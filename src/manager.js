// Domain logic: tasks, plans (with the hard plan gate), agents, and the per-task supervisors.
//
// Every top-level task has its OWN supervisor (own Claude session, own turn queue, own chat).
// A 'general' supervisor (read-only) answers questions about the whole picture.
const fs = require('fs');
const path = require('path');
const { state, bus, changed, nextId } = require('./store');
const { runClaude, killTree, toLogEntries } = require('./runner');
const prompts = require('./prompts');

const ROOT = path.join(__dirname, '..');
const config = {
  port: 4800,
  workspace: 'workspace',
  claudeBin: 'claude',
  maxAgentsPerTask: 5,
  permissionMode: 'acceptEdits',
  // Built-in tools every supervisor/agent gets. Keep this list SHORT: each extra tool schema is
  // re-sent on every request. Web tools are opt-in per agent (spawn_subagent web:true).
  tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
  supervisorModel: null, // null = CLI default
  agentModel: null,
  generalModel: 'haiku', // the read-only overview chat does not need a big model
  ...require('../config.json'),
};
// Env overrides, for running an isolated second instance (also used by tests).
if (process.env.AGENT_MANAGER_PORT) config.port = Number(process.env.AGENT_MANAGER_PORT);
if (process.env.AGENT_MANAGER_WORKSPACE) config.workspace = process.env.AGENT_MANAGER_WORKSPACE;
const MODELS = ['haiku', 'sonnet', 'opus'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
const GENERAL_TOOLS = ['Read', 'Glob', 'Grep'];
const WORKSPACE = path.resolve(ROOT, config.workspace);
const DATA = process.env.AGENT_MANAGER_DATA || path.join(ROOT, 'data');
const GENERAL = 'general';

const now = () => new Date().toISOString();
const SUPERVISOR_SETTABLE = ['in_progress', 'blocked', 'done', 'failed', 'cancelled'];
const GATED = ['in_progress', 'blocked', 'done'];
const TODO_STATUSES = ['pending', 'in_progress', 'done'];

class UserError extends Error {}
const fail = (msg) => {
  throw new UserError(msg);
};

// ---------- lookups ----------
const getTask = (id) => state.tasks.find((t) => t.id === String(id).toUpperCase());
const getAgent = (id) => state.agents.find((a) => a.id === String(id).toLowerCase());
function findAgent(ref) {
  const r = String(ref).replace(/^@/, '').toLowerCase();
  return state.agents.find((a) => a.id === r || a.name.toLowerCase() === r);
}
function rootOf(task) {
  let t = task;
  for (let i = 0; t.parentId && i < 20; i++) t = getTask(t.parentId) || t;
  return t;
}
const planApproved = (task) => !!rootOf(task).plan?.approved;
const mustTask = (id) => getTask(id) || fail(`No such task: ${id}`);
const scopeOfAgent = (a) => rootOf(getTask(a.taskId) || { id: '?', parentId: null }).id;

/** Scope checks used by the MCP layer: a task supervisor may only touch its own family. */
function taskInScope(scope, taskId) {
  const t = mustTask(taskId);
  if (scope !== GENERAL && rootOf(t).id !== scope) fail(`${t.id} belongs to ${rootOf(t).id}, which has its own supervisor.`);
  return t;
}
function agentInScope(scope, ref) {
  const a = findAgent(ref) || fail(`No such agent: ${ref}`);
  if (scope !== GENERAL && scopeOfAgent(a) !== scope) fail(`${a.id} belongs to another task's supervisor.`);
  return a;
}
const family = (scope) => state.tasks.filter((t) => scope === GENERAL || rootOf(t).id === scope);
const agentsOf = (scope) => state.agents.filter((a) => scope === GENERAL || scopeOfAgent(a) === scope);

// ---------- chat ----------
function addChat(scope, role, text, extra = {}) {
  const entry = { id: nextId('chat', 'c'), scope, role, text, ts: now(), ...extra };
  state.chat.push(entry);
  if (state.chat.length > 3000) state.chat.splice(0, state.chat.length - 3000);
  bus.emit('chat', entry);
  changed();
  return entry;
}

// ---------- supervisors (one per scope) ----------
const runtime = new Map(); // scope -> { queue: [], child, stopped }
const rt = (scope) => {
  if (!runtime.has(scope)) runtime.set(scope, { queue: [], child: null, stopped: false });
  return runtime.get(scope);
};
const supState = (scope) => (state.supervisors[scope] ||= { sessionId: null, status: 'idle', since: null });

// Token accounting. `result` events carry the usage of one whole run (all of its requests).
// `in` counts everything sent to the model (fresh + cache writes + cache reads); `cost` is the
// CLI's API-equivalent estimate (informational on a subscription).
// `cr` = cache reads (cheap), `cw` = cache writes. Each run is also appended to usageLog (with the
// per-model split from `modelUsage`) so the Usage tab can show per-day and per-model spend.
function addUsage(holder, ev, ctx = {}) {
  const u = ev.usage;
  if (!u) return;
  const fresh = u.input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const all = fresh + cw + cr;
  const t = (holder.usage ||= { in: 0, out: 0, cost: 0, runs: 0, cr: 0, cw: 0 });
  t.in += all;
  t.out += u.output_tokens || 0;
  t.cost += ev.total_cost_usd || 0;
  t.runs += 1;
  t.cr = (t.cr || 0) + cr;
  t.cw = (t.cw || 0) + cw;
  const models = {};
  for (const [name, mu] of Object.entries(ev.modelUsage || {})) {
    models[name.replace(/^claude-/, '')] = {
      in: (mu.inputTokens || 0) + (mu.cacheReadInputTokens || 0) + (mu.cacheCreationInputTokens || 0),
      out: mu.outputTokens || 0,
      cost: mu.costUSD || 0,
    };
  }
  state.usageLog.push({ ts: now(), scope: ctx.scope || null, agent: ctx.agent || null, in: all, out: u.output_tokens || 0, cr, cw, cost: ev.total_cost_usd || 0, models });
  if (state.usageLog.length > 4000) state.usageLog.splice(0, state.usageLog.length - 4000);
  changed();
}

// Claude Code reports the plan's rolling windows (5-hour and weekly) inside its event stream.
// utilization is a 0..1 fraction; resetsAt is epoch seconds. Account-wide, not just this app.
function noteRateLimit(info) {
  if (!info) return;
  const prev = state.rateLimits || {};
  const w = info.unifiedWindows || {};
  state.rateLimits = {
    updatedAt: now(),
    status: info.status || prev.status || null,
    fiveHour: w.five_hour || prev.fiveHour || null,
    sevenDay: w.seven_day || prev.sevenDay || null,
    overage: { status: info.overageStatus ?? prev.overage?.status ?? null, reason: info.overageDisabledReason ?? prev.overage?.reason ?? null, using: !!info.isUsingOverage },
  };
  changed();
}

const day = (iso) => new Date(iso).toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
function usageReport() {
  const sums = (list) => list.reduce((t, u) => ({ in: t.in + (u?.in || 0), out: t.out + (u?.out || 0), cost: t.cost + (u?.cost || 0), runs: t.runs + (u?.runs || 0), cr: t.cr + (u?.cr || 0), cw: t.cw + (u?.cw || 0) }), { in: 0, out: 0, cost: 0, runs: 0, cr: 0, cw: 0 });
  const total = sums([...Object.values(state.supervisors).map((s) => s.usage), ...state.agents.map((a) => a.usage)]);
  // last 14 local days (from the per-run log, which starts when this version was first run)
  const days = [];
  for (let i = 13; i >= 0; i--) days.push({ date: day(new Date(Date.now() - i * 86400000)), in: 0, out: 0, cost: 0, runs: 0 });
  const byDate = new Map(days.map((d) => [d.date, d]));
  const models = {};
  for (const e of state.usageLog) {
    const d = byDate.get(day(e.ts));
    if (d) {
      d.in += e.in;
      d.out += e.out;
      d.cost += e.cost;
      d.runs += 1;
    }
    for (const [name, mu] of Object.entries(e.models || {})) {
      const x = (models[name] ||= { model: name, in: 0, out: 0, cost: 0 });
      x.in += mu.in;
      x.out += mu.out;
      x.cost += mu.cost;
    }
  }
  const tasks = state.tasks
    .filter((t) => !t.parentId)
    .map((t) => {
      const s = sums([state.supervisors[t.id]?.usage]);
      const a = sums(state.agents.filter((x) => scopeOfAgent(x) === t.id).map((x) => x.usage));
      return { id: t.id, title: t.title, status: t.status, supervisor: s.in + s.out, agents: a.in + a.out, total: s.in + s.out + a.in + a.out, cost: s.cost + a.cost };
    })
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total);
  const gen = sums([state.supervisors[GENERAL]?.usage]);
  const agents = state.agents
    .filter((a) => a.usage)
    .map((a) => ({ id: a.id, name: a.name, task: a.taskId, model: a.model, tokens: a.usage.in + a.usage.out, cost: a.usage.cost }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8);
  return { rateLimits: state.rateLimits, total, today: days[days.length - 1], days, models: Object.values(models).sort((a, b) => b.in + b.out - (a.in + a.out)), tasks, general: gen.in + gen.out, agents, logSince: state.usageLog[0]?.ts || null };
}

function validScope(scope) {
  if (scope === GENERAL) return;
  const t = getTask(scope);
  if (!t || t.parentId) fail(`Unknown chat: ${scope}`);
}

function enqueueSupervisor(scope, text) {
  rt(scope).queue.push(text);
  pump(scope);
}

function writeFiles(id, systemPrompt, mcpName, mcpPath) {
  fs.mkdirSync(path.join(DATA, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'mcp'), { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const promptFile = path.join(DATA, 'prompts', `${id}.md`);
  const mcpFile = path.join(DATA, 'mcp', `${id}.json`);
  fs.writeFileSync(promptFile, systemPrompt);
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { [mcpName]: { type: 'http', url: `http://127.0.0.1:${config.port}${mcpPath}` } } }));
  return { promptFile, mcpFile };
}

function pump(scope) {
  const r = rt(scope);
  if (r.child || !r.queue.length) return;
  const prompt = r.queue.shift();
  const st = supState(scope);
  const system =
    scope === GENERAL
      ? prompts.generalSystemPrompt({ workspace: WORKSPACE })
      : prompts.supervisorSystemPrompt({ scope, maxAgents: config.maxAgentsPerTask, workspace: WORKSPACE });
  const { promptFile, mcpFile } = writeFiles(`sup-${scope}`, system, 'manager', `/mcp/supervisor/${scope}`);
  st.status = 'working';
  st.since = now();
  changed();
  r.stopped = false;
  r.child = runClaude({
    bin: config.claudeBin,
    cwd: WORKSPACE,
    prompt,
    sessionId: st.sessionId,
    systemPromptFile: promptFile,
    mcpConfigFile: mcpFile,
    permissionMode: config.permissionMode,
    tools: scope === GENERAL ? GENERAL_TOOLS : config.tools,
    allowedTools: [...(scope === GENERAL ? GENERAL_TOOLS : config.tools), 'mcp__manager'],
    disallowedTools: ['Task', 'Agent'],
    model: scope === GENERAL ? config.generalModel : config.supervisorModel,
    onEvent(ev) {
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
        st.sessionId = ev.session_id;
        changed();
      } else if (ev.type === 'rate_limit_event') {
        noteRateLimit(ev.rate_limit_info);
      } else if (ev.type === 'result') {
        addUsage(st, ev, { scope });
        if (ev.is_error) addChat(scope, 'system', `Supervisor error: ${String(ev.result || ev.subtype).slice(0, 500)}`);
      }
      for (const e of toLogEntries(ev)) addChat(scope, e.kind === 'text' ? 'supervisor' : e.kind, e.text);
    },
    onExit({ code, stderr }) {
      r.child = null;
      st.status = 'idle';
      st.since = now();
      if (/No conversation found/i.test(stderr)) {
        st.sessionId = null;
        addChat(scope, 'system', 'The supervisor session could not be resumed, so a fresh one will start with the next message.');
      } else if (code !== 0 && !r.stopped) {
        addChat(scope, 'system', `Supervisor process exited with code ${code}. ${stderr.trim().slice(-400)}`);
      }
      changed();
      pump(scope);
    },
  });
}

function stopSupervisor(scope, { quiet = false } = {}) {
  validScope(scope);
  const r = rt(scope);
  r.queue.length = 0;
  if (r.child) {
    r.stopped = true;
    killTree(r.child);
    if (!quiet) addChat(scope, 'system', 'Supervisor turn stopped.');
  }
}

// Batch several agent completions of one task into a single supervisor wake-up.
const wakes = new Map(); // scope -> { items: [], timer }
function wakeSupervisor(scope, text) {
  const w = wakes.get(scope) || { items: [], timer: null };
  wakes.set(scope, w);
  w.items.push(text);
  clearTimeout(w.timer);
  w.timer = setTimeout(() => {
    const batch = w.items.join('\n\n---\n\n');
    wakes.delete(scope);
    enqueueSupervisor(scope, `SYSTEM EVENT (not from the user)\n\n${batch}`);
  }, 4000);
}

// ---------- tasks ----------
function createTask({ title, prompt, plan, openPoints, agents, parentId } = {}) {
  if (!prompt?.trim() && !title?.trim()) fail('A task needs a prompt or a title.');
  if (parentId) mustTask(parentId);
  const text = (prompt || title).trim();
  const task = {
    id: nextId('task', 'T'),
    title: (title?.trim() || text.split('\n')[0]).slice(0, 80),
    prompt: text,
    status: 'new',
    parentId: parentId ? String(parentId).toUpperCase() : null,
    plan: null,
    requestedAgents: Number.isInteger(agents) && agents > 0 ? agents : null,
    agentIds: [],
    notes: [],
    createdAt: now(),
    updatedAt: now(),
  };
  if (plan?.trim() && !parentId) {
    task.plan = { text: plan.trim(), openPoints: (openPoints || '').trim(), approved: true, by: 'user', updatedAt: now() };
    task.status = 'ready';
  }
  state.tasks.push(task);
  changed();
  return task;
}

function submitUserTask(input) {
  const task = createTask(input);
  addChat(task.id, 'event', `Created ${task.id}: ${task.title}${task.plan ? ' (plan supplied)' : ''}`);
  addChat(GENERAL, 'event', `New task ${task.id}: ${task.title}. It has its own supervisor.`);
  const lines = [
    `NEW TASK ${task.id}`,
    `Title: ${task.title}`,
    `Request:\n${task.prompt}`,
    task.plan
      ? `Plan: supplied by the user and already APPROVED.\n${task.plan.text}\nOpen points: ${task.plan.openPoints || '(none)'}`
      : 'Plan: none yet. Draft one with set_plan and wait for the user to approve it.',
    `Requested number of agents: ${task.requestedAgents ?? 'not specified (you decide)'}`,
  ];
  enqueueSupervisor(task.id, lines.join('\n\n'));
  return task;
}

function setPlan(taskId, text, openPoints) {
  const task = mustTask(taskId);
  if (task.parentId) fail('Plans belong to top-level tasks. Set the plan on ' + rootOf(task).id);
  if (task.plan?.approved) fail('This plan is already approved. Ask the user before changing it (use update_open_points for open points).');
  if (!text?.trim()) fail('Plan text is empty.');
  task.plan = { text: text.trim(), openPoints: (openPoints || '').trim(), approved: false, by: 'supervisor', updatedAt: now() };
  task.status = 'awaiting_approval';
  task.updatedAt = now();
  changed();
  return task;
}

function updateOpenPoints(taskId, openPoints) {
  const task = rootOf(mustTask(taskId));
  if (!task.plan) fail('No plan yet.');
  task.plan.openPoints = (openPoints || '').trim();
  task.plan.updatedAt = now();
  changed();
  return task;
}

function approveTask(taskId) {
  const task = mustTask(taskId);
  if (task.parentId) fail('Approve the top-level task instead.');
  if (!task.plan) fail('This task has no plan to approve.');
  if (task.plan.approved) fail('Plan already approved.');
  task.plan.approved = true;
  task.plan.by = 'user';
  task.status = 'ready';
  task.updatedAt = now();
  addChat(task.id, 'event', `You approved the plan for ${task.id}`);
  enqueueSupervisor(
    task.id,
    `PLAN APPROVED ${task.id}\nThe user approved the plan. Decide solo vs multi-agent and proceed.\n\nPlan:\n${task.plan.text}\n\nOpen points: ${task.plan.openPoints || '(none)'}\nRequested number of agents: ${task.requestedAgents ?? 'not specified (you decide)'}`
  );
  changed();
  return task;
}

function updateTask(taskId, { status, title, note } = {}) {
  const task = mustTask(taskId);
  if (status) {
    if (!SUPERVISOR_SETTABLE.includes(status)) fail(`status must be one of: ${SUPERVISOR_SETTABLE.join(', ')}`);
    if (GATED.includes(status) && !planApproved(task)) {
      fail(`Plan gate: ${rootOf(task).id} has no approved plan, so it cannot be set to ${status}. Draft a plan with set_plan and have the user approve it.`);
    }
    task.status = status;
  }
  if (title?.trim()) task.title = title.trim().slice(0, 80);
  if (note?.trim()) task.notes.push({ ts: now(), text: note.trim() });
  task.updatedAt = now();
  changed();
  return task;
}

function cancelTask(taskId) {
  const task = mustTask(taskId);
  if (task.parentId) fail('Cancel the top-level task.');
  for (const t of family(task.id)) {
    for (const aid of t.agentIds) {
      try {
        stopAgent(aid, { quiet: true });
      } catch {
        /* already finished */
      }
    }
    if (!['done', 'failed'].includes(t.status)) t.status = 'cancelled';
    t.updatedAt = now();
  }
  addChat(task.id, 'event', `You cancelled ${task.id}`);
  stopSupervisor(task.id, { quiet: true });
  enqueueSupervisor(task.id, `USER CANCELLED ${task.id}. Its agents were stopped. Acknowledge briefly; do not continue the work.`);
  changed();
}

function taskSummary(t) {
  return { id: t.id, title: t.title, status: t.status, parentId: t.parentId, planApproved: planApproved(t), agents: t.agentIds, requestedAgents: t.requestedAgents };
}

// ---------- agents ----------
const children = new Map(); // agentId -> child process

function pushLog(agent, entry) {
  const e = { ts: now(), ...entry };
  agent.log.push(e);
  if (agent.log.length > 400) agent.log.splice(0, agent.log.length - 400);
  if (e.kind === 'tool' || e.kind === 'text') agent.activity = e.text.slice(0, 160);
  bus.emit('log', { agentId: agent.id, entry: e });
}

const isLive = (a) => a.status === 'running' || a.status === 'starting';
const running = () => state.agents.filter(isLive);
const runningFor = (scope) => running().filter((a) => scopeOfAgent(a) === scope);

// A single heads-up for a burst of spawns, with the totals across all tasks (there is no global cap).
const spawnBursts = new Map(); // scope -> { n, timer }
function noticeSpawn(scope) {
  const b = spawnBursts.get(scope) || { n: 0, timer: null };
  spawnBursts.set(scope, b);
  b.n++;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => {
    spawnBursts.delete(scope);
    const live = running();
    const tasks = new Set(live.map(scopeOfAgent)).size;
    const text = `${scope} is starting ${b.n} subagent${b.n > 1 ? 's' : ''}. ${live.length} agent${live.length > 1 ? 's' : ''} running now across ${tasks} task${tasks > 1 ? 's' : ''}.`;
    addChat(GENERAL, 'event', text);
    bus.emit('notice', { text });
  }, 1500);
}

// Write-ownership: every agent declares the paths it may write to (relative to the workspace;
// [] = read-only). The server rejects a claim that overlaps a LIVE agent's claim, across all tasks.
// This stops supervisor mistakes; it is not a sandbox (an agent could still ignore its own prompt).
function normalizeOwns(owns) {
  if (!Array.isArray(owns)) fail('owns is required: list the workspace paths this agent may write to, or [] for a read-only agent.');
  return owns.map((p) => {
    const rel = path.relative(WORKSPACE, path.resolve(WORKSPACE, String(p).trim() || '.')).replace(/\\/g, '/').toLowerCase();
    if (rel.startsWith('..') || path.isAbsolute(rel)) fail(`"${p}" is outside the workspace.`);
    return rel.replace(/\/+$/, ''); // '' means the whole workspace
  });
}
const pathsOverlap = (a, b) => a === '' || b === '' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
function checkClaims(owns, exceptAgentId) {
  for (const other of running()) {
    if (other.id === exceptAgentId) continue;
    for (const mine of owns) {
      for (const theirs of other.owns || []) {
        if (pathsOverlap(mine, theirs)) {
          fail(`Overlap: "${mine || '.'}" conflicts with ${other.id} "${other.name}" (${other.taskId}), which owns "${theirs || '.'}". Narrow the paths or wait until it finishes.`);
        }
      }
    }
  }
}

// `subtask` (optional title) creates a subtask under taskId and assigns the agent to it in the same
// call, which saves the supervisor a separate create_task round trip (each round trip re-reads its context).
function spawnAgent({ taskId, name, objective, instructions, owns, model, web, subtask }) {
  const base = mustTask(taskId);
  if (model && !MODELS.includes(model)) fail(`model must be one of: ${MODELS.join(', ')}`);
  const scope = rootOf(base).id;
  if (!planApproved(base)) fail(`Plan gate: ${scope} has no approved plan. No agents can start.`);
  if (['done', 'cancelled', 'failed'].includes(base.status)) fail(`${base.id} is ${base.status}; reopen it with update_task first.`);
  if (!objective?.trim()) fail('objective is required');
  if (runningFor(scope).length >= config.maxAgentsPerTask) fail(`At most ${config.maxAgentsPerTask} agents of ${scope} may run at once. Wait for one to finish.`);
  const claims = normalizeOwns(owns);
  checkClaims(claims, null);
  // all validation passed: only now create the subtask, so a rejected spawn leaves no orphan
  const task = subtask?.trim() ? createTask({ title: subtask, prompt: objective, parentId: base.id }) : base;
  if (['new', 'ready'].includes(base.status)) base.status = 'in_progress';
  let nm = (name || 'agent').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  if (findAgent(nm) && !/^a\d+$/.test(nm)) nm = `${nm}-${state.seq.agent + 1}`;
  if (/^a\d+$/.test(nm)) nm = `worker-${state.seq.agent + 1}`;
  const agent = {
    id: nextId('agent', 'a'),
    name: nm,
    taskId: task.id,
    objective: objective.trim(),
    owns: claims,
    model: model || config.agentModel || null,
    web: !!web,
    status: 'starting',
    sessionId: null,
    activity: 'starting…',
    todos: [],
    log: [],
    report: null,
    startedAt: now(),
    endedAt: null,
    stopRequested: false,
  };
  state.agents.push(agent);
  task.agentIds.push(agent.id);
  if (['new', 'ready'].includes(task.status)) task.status = 'in_progress';
  task.updatedAt = now();
  addChat(scope, 'event', `Spawned ${agent.id} “${agent.name}” on ${task.id}`);
  noticeSpawn(scope);
  const first = `Your objective:\n${agent.objective}${instructions?.trim() ? `\n\nExtra instructions:\n${instructions.trim()}` : ''}`;
  startAgentRun(agent, first);
  return agent;
}

function startAgentRun(agent, prompt) {
  const task = getTask(agent.taskId);
  const scope = rootOf(task).id;
  const { promptFile, mcpFile } = writeFiles(agent.id, prompts.agentSystemPrompt({ agent, task, rootTask: rootOf(task) }), 'me', `/mcp/agent/${agent.id}`);
  agent.status = 'running';
  agent.stopRequested = false;
  agent.endedAt = null;
  let finalResult = null;
  let isError = false;
  pushLog(agent, { kind: 'input', text: prompt.slice(0, 1500) });
  changed();
  const agentTools = [...config.tools, ...(agent.web ? WEB_TOOLS : [])];
  const child = runClaude({
    bin: config.claudeBin,
    cwd: WORKSPACE,
    prompt,
    sessionId: agent.sessionId,
    systemPromptFile: promptFile,
    mcpConfigFile: mcpFile,
    permissionMode: config.permissionMode,
    tools: agentTools,
    allowedTools: [...agentTools, 'mcp__me'],
    disallowedTools: ['Task', 'Agent'],
    model: agent.model,
    onEvent(ev) {
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) agent.sessionId = ev.session_id;
      else if (ev.type === 'rate_limit_event') noteRateLimit(ev.rate_limit_info);
      else if (ev.type === 'result') {
        finalResult = ev.result;
        isError = !!ev.is_error;
        addUsage(agent, ev, { scope, agent: agent.id });
      }
      for (const e of toLogEntries(ev)) pushLog(agent, e);
      changed();
    },
    onExit({ code, stderr }) {
      children.delete(agent.id);
      agent.endedAt = now();
      const ok = code === 0 && !isError;
      agent.status = agent.stopRequested ? 'stopped' : ok ? 'done' : 'failed';
      agent.report = finalResult || (stderr.trim() ? `(no report) ${stderr.trim().slice(-600)}` : '(no report)');
      agent.activity = agent.status === 'done' ? 'finished' : agent.status;
      pushLog(agent, { kind: ok ? 'result' : 'error', text: agent.report.slice(0, 4000) });
      changed();
      if (agent.status !== 'stopped' || !agent.stopQuiet) {
        wakeSupervisor(scope, `Agent ${agent.id} "${agent.name}" on ${agent.taskId} ${agent.status.toUpperCase()}.\nReport:\n${agent.report.slice(0, 2500)}`);
      }
    },
  });
  children.set(agent.id, child);
}

function sendToAgent(ref, message, scope = GENERAL) {
  const agent = agentInScope(scope, ref);
  const own = scopeOfAgent(agent);
  if (isLive(agent)) fail(`${agent.id} is still running; you can only message it after it finishes (or stop it first).`);
  if (!agent.sessionId) fail(`${agent.id} has no session to resume.`);
  if (runningFor(own).length >= config.maxAgentsPerTask) fail(`Agent limit for ${own} reached.`);
  checkClaims(agent.owns || [], agent.id);
  startAgentRun(agent, `Follow-up from the supervisor:\n${message}`);
  noticeSpawn(own);
  return agent;
}

function stopAgent(ref, { quiet = false, scope = GENERAL } = {}) {
  const agent = agentInScope(scope, ref);
  const child = children.get(agent.id);
  if (!child) fail(`${agent.id} is not running.`);
  agent.stopRequested = true;
  agent.stopQuiet = quiet;
  killTree(child);
  return agent;
}

function setAgentTodos(agentId, items) {
  const agent = getAgent(agentId) || fail('unknown agent');
  agent.todos = items.slice(0, 40).map((i) => ({ text: String(i.text).slice(0, 200), status: TODO_STATUSES.includes(i.status) ? i.status : 'pending' }));
  changed();
  return agent.todos;
}

// ---------- user messages ----------
function mentionContext(text, scope) {
  const found = new Set();
  const consider = (a) => a && (scope === GENERAL || scopeOfAgent(a) === scope) && found.add(a);
  for (const m of text.matchAll(/@([\w-]+)/g)) consider(findAgent(m[1]));
  for (const m of text.matchAll(/\b(a\d+)\b/gi)) consider(getAgent(m[1]));
  if (!found.size) return '';
  const blocks = [...found].map((a) => {
    const recent = a.log
      .filter((l) => l.kind !== 'input')
      .slice(-8)
      .map((l) => `  - ${l.kind}: ${l.text.slice(0, 160)}`)
      .join('\n');
    const todos = a.todos.map((t) => `  [${t.status}] ${t.text}`).join('\n') || '  (none)';
    return `Agent ${a.id} "${a.name}" | task ${a.taskId} | status ${a.status} | now: ${a.activity}\nIts checklist:\n${todos}\nRecent activity:\n${recent || '  (none)'}`;
  });
  return `\n\n[Context the user's message refers to, from the dashboard]\n${blocks.join('\n\n')}`;
}

function sendUserMessage(scope, text) {
  validScope(scope);
  if (!text?.trim()) fail('empty message');
  addChat(scope, 'user', text.trim());
  enqueueSupervisor(scope, text.trim() + mentionContext(text, scope));
}

// ---------- snapshot for the UI ----------
function snapshot({ withChat = false } = {}) {
  const supervisors = {};
  for (const scope of [GENERAL, ...state.tasks.filter((t) => !t.parentId).map((t) => t.id)]) {
    const s = supState(scope);
    supervisors[scope] = { status: s.status, since: s.since, queued: rt(scope).queue.length, usage: s.usage || null };
  }
  const s = {
    tasks: state.tasks,
    agents: state.agents.map(({ log, stopQuiet, ...a }) => ({ ...a, logCount: log.length })),
    supervisors,
    rateLimits: state.rateLimits,
    config: { maxAgentsPerTask: config.maxAgentsPerTask, workspace: WORKSPACE, permissionMode: config.permissionMode },
  };
  if (withChat) s.chat = state.chat;
  return s;
}

// ---------- startup recovery ----------
function recover() {
  for (const s of Object.values(state.supervisors)) s.status = 'idle';
  const lost = running();
  const byScope = new Map();
  for (const a of lost) {
    a.status = 'failed';
    a.endedAt = now();
    a.activity = 'interrupted';
    a.report = 'Interrupted: the manager server restarted while this agent was running.';
    const sc = scopeOfAgent(a);
    byScope.set(sc, [...(byScope.get(sc) || []), a]);
  }
  for (const [sc, list] of byScope) {
    addChat(sc, 'system', `Server restarted; ${list.map((a) => a.id).join(', ')} were interrupted.`);
    wakeSupervisor(sc, `Server restarted. Interrupted agents: ${list.map((a) => `${a.id} (${a.taskId})`).join(', ')}. Decide whether to respawn or continue yourself.`);
  }
  changed();
}

module.exports = {
  config, WORKSPACE, GENERAL, UserError,
  getTask, getAgent, findAgent, rootOf, planApproved, taskInScope, agentInScope, family, agentsOf, scopeOfAgent,
  addChat, sendUserMessage, stopSupervisor, validScope,
  submitUserTask, createTask, setPlan, updateOpenPoints, approveTask, updateTask, cancelTask, taskSummary,
  spawnAgent, sendToAgent, stopAgent, setAgentTodos,
  snapshot, recover, usageReport,
};
