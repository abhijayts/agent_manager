// Domain logic: tasks, plans (with the hard plan gate), agents, and the supervisor turn loop.
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
  model: null,
  maxConcurrentAgents: 5,
  permissionMode: 'acceptEdits',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
  ...require('../config.json'),
};
const WORKSPACE = path.resolve(ROOT, config.workspace);
const DATA = path.join(ROOT, 'data');

const now = () => new Date().toISOString();
const TASK_STATUSES = ['new', 'awaiting_approval', 'ready', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'];
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
function mustTask(id) {
  return getTask(id) || fail(`No such task: ${id}`);
}

// ---------- chat ----------
function addChat(role, text, extra = {}) {
  const entry = { id: nextId('chat', 'c'), role, text, ts: now(), ...extra };
  state.chat.push(entry);
  if (state.chat.length > 600) state.chat.splice(0, state.chat.length - 600);
  bus.emit('chat', entry);
  changed();
  return entry;
}

// ---------- supervisor ----------
const queue = [];
let supChild = null;
let supStopped = false;

function enqueueSupervisor(text) {
  queue.push(text);
  pump();
}

function writeFiles(id, systemPrompt, mcpPath) {
  fs.mkdirSync(path.join(DATA, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'mcp'), { recursive: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const promptFile = path.join(DATA, 'prompts', `${id}.md`);
  const mcpFile = path.join(DATA, 'mcp', `${id}.json`);
  fs.writeFileSync(promptFile, systemPrompt);
  const name = id === 'supervisor' ? 'manager' : 'me';
  fs.writeFileSync(
    mcpFile,
    JSON.stringify({ mcpServers: { [name]: { type: 'http', url: `http://127.0.0.1:${config.port}${mcpPath}` } } })
  );
  return { promptFile, mcpFile };
}

function pump() {
  if (supChild || !queue.length) return;
  const prompt = queue.shift();
  const { promptFile, mcpFile } = writeFiles(
    'supervisor',
    prompts.supervisorSystemPrompt({ maxAgents: config.maxConcurrentAgents, workspace: WORKSPACE }),
    '/mcp/supervisor'
  );
  state.supervisor.status = 'working';
  state.supervisor.since = now();
  changed();
  supStopped = false;
  supChild = runClaude({
    bin: config.claudeBin,
    cwd: WORKSPACE,
    prompt,
    sessionId: state.supervisor.sessionId,
    systemPromptFile: promptFile,
    mcpConfigFile: mcpFile,
    permissionMode: config.permissionMode,
    allowedTools: [...config.allowedTools, 'mcp__manager'],
    disallowedTools: ['Task', 'Agent'],
    model: config.model,
    onEvent(ev) {
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
        state.supervisor.sessionId = ev.session_id;
        changed();
      } else if (ev.type === 'result' && ev.is_error) {
        addChat('system', `Supervisor error: ${String(ev.result || ev.subtype).slice(0, 500)}`);
      }
      for (const e of toLogEntries(ev)) addChat(e.kind === 'text' ? 'supervisor' : e.kind, e.text);
    },
    onExit({ code, stderr }) {
      supChild = null;
      state.supervisor.status = 'idle';
      state.supervisor.since = now();
      if (/No conversation found/i.test(stderr)) {
        state.supervisor.sessionId = null;
        addChat('system', 'The supervisor session could not be resumed, so a fresh one will start with the next message.');
      } else if (code !== 0 && !supStopped) {
        addChat('system', `Supervisor process exited with code ${code}. ${stderr.trim().slice(-400)}`);
      }
      changed();
      pump();
    },
  });
}

function stopSupervisor() {
  queue.length = 0;
  if (supChild) {
    supStopped = true;
    killTree(supChild);
    addChat('system', 'Supervisor turn stopped.');
  }
}

// Batch several agent completions into a single supervisor wake-up.
let pendingWake = [];
let wakeTimer = null;
function wakeSupervisor(text) {
  pendingWake.push(text);
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    const batch = pendingWake.join('\n\n---\n\n');
    pendingWake = [];
    enqueueSupervisor(`SYSTEM EVENT (not from the user)\n\n${batch}`);
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
  addChat('event', `Created ${task.id}: ${task.title}${task.plan ? ' (plan supplied)' : ''}`);
  const lines = [
    `NEW TASK ${task.id}`,
    `Title: ${task.title}`,
    `Request:\n${task.prompt}`,
    task.plan
      ? `Plan: supplied by the user and already APPROVED.\n${task.plan.text}\nOpen points: ${task.plan.openPoints || '(none)'}`
      : 'Plan: none yet. Draft one with set_plan and wait for the user to approve it.',
    `Requested number of agents: ${task.requestedAgents ?? 'not specified (you decide)'}`,
  ];
  enqueueSupervisor(lines.join('\n\n'));
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
  if (!task.plan) fail('This task has no plan to approve.');
  if (task.plan.approved) fail('Plan already approved.');
  task.plan.approved = true;
  task.plan.by = 'user';
  task.status = 'ready';
  task.updatedAt = now();
  addChat('event', `You approved the plan for ${task.id}`);
  enqueueSupervisor(
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
  const family = state.tasks.filter((t) => t.id === task.id || rootOf(t).id === task.id);
  for (const t of family) {
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
  addChat('event', `You cancelled ${task.id}`);
  enqueueSupervisor(`USER CANCELLED ${task.id}. Its agents were stopped. Acknowledge briefly; do not continue the work.`);
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

const running = () => state.agents.filter((a) => a.status === 'running' || a.status === 'starting');

function spawnAgent({ taskId, name, objective, instructions }) {
  const task = mustTask(taskId);
  if (!planApproved(task)) fail(`Plan gate: ${rootOf(task).id} has no approved plan. No agents can start.`);
  if (['done', 'cancelled', 'failed'].includes(task.status)) fail(`${task.id} is ${task.status}; reopen it with update_task first.`);
  if (!objective?.trim()) fail('objective is required');
  if (running().length >= config.maxConcurrentAgents) fail(`At most ${config.maxConcurrentAgents} agents may run at once. Wait for one to finish.`);
  let nm = (name || 'agent').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  if (findAgent(nm) && !/^a\d+$/.test(nm)) nm = `${nm}-${state.seq.agent + 1}`;
  if (/^a\d+$/.test(nm)) nm = `worker-${state.seq.agent + 1}`;
  const agent = {
    id: nextId('agent', 'a'),
    name: nm,
    taskId: task.id,
    objective: objective.trim(),
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
  addChat('event', `Spawned ${agent.id} “${agent.name}” on ${task.id}`);
  const first = `Your objective:\n${agent.objective}${instructions?.trim() ? `\n\nExtra instructions:\n${instructions.trim()}` : ''}`;
  startAgentRun(agent, first);
  return agent;
}

function startAgentRun(agent, prompt) {
  const task = getTask(agent.taskId);
  const { promptFile, mcpFile } = writeFiles(agent.id, prompts.agentSystemPrompt({ agent, task, rootTask: rootOf(task) }), `/mcp/agent/${agent.id}`);
  agent.status = 'running';
  agent.stopRequested = false;
  agent.endedAt = null;
  let finalResult = null;
  let isError = false;
  pushLog(agent, { kind: 'input', text: prompt.slice(0, 1500) });
  changed();
  const child = runClaude({
    bin: config.claudeBin,
    cwd: WORKSPACE,
    prompt,
    sessionId: agent.sessionId,
    systemPromptFile: promptFile,
    mcpConfigFile: mcpFile,
    permissionMode: config.permissionMode,
    allowedTools: [...config.allowedTools, 'mcp__me'],
    disallowedTools: ['Task', 'Agent'],
    model: config.model,
    onEvent(ev) {
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) agent.sessionId = ev.session_id;
      else if (ev.type === 'result') {
        finalResult = ev.result;
        isError = !!ev.is_error;
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
        wakeSupervisor(`Agent ${agent.id} "${agent.name}" on ${agent.taskId} ${agent.status.toUpperCase()}.\nReport:\n${agent.report.slice(0, 6000)}`);
      }
    },
  });
  children.set(agent.id, child);
}

function sendToAgent(ref, message) {
  const agent = findAgent(ref) || fail(`No such agent: ${ref}`);
  if (running().some((a) => a.id === agent.id)) fail(`${agent.id} is still running; you can only message it after it finishes (or stop it first).`);
  if (!agent.sessionId) fail(`${agent.id} has no session to resume.`);
  if (running().length >= config.maxConcurrentAgents) fail('Agent limit reached.');
  startAgentRun(agent, `Follow-up from the supervisor:\n${message}`);
  return agent;
}

function stopAgent(ref, { quiet = false } = {}) {
  const agent = findAgent(ref) || fail(`No such agent: ${ref}`);
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
function mentionContext(text) {
  const found = new Set();
  for (const m of text.matchAll(/@([\w-]+)/g)) {
    const a = findAgent(m[1]);
    if (a) found.add(a);
  }
  for (const m of text.matchAll(/\b(a\d+)\b/gi)) {
    const a = getAgent(m[1]);
    if (a) found.add(a);
  }
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

function sendUserMessage(text) {
  if (!text?.trim()) fail('empty message');
  addChat('user', text.trim());
  enqueueSupervisor(text.trim() + mentionContext(text));
}

// ---------- snapshot for the UI ----------
function snapshot({ withChat = false } = {}) {
  const s = {
    tasks: state.tasks,
    agents: state.agents.map(({ log, stopQuiet, ...a }) => ({ ...a, logCount: log.length })),
    supervisor: { status: state.supervisor.status, since: state.supervisor.since, queued: queue.length },
    config: { maxAgents: config.maxConcurrentAgents, workspace: WORKSPACE, permissionMode: config.permissionMode },
  };
  if (withChat) s.chat = state.chat;
  return s;
}

// ---------- startup recovery ----------
function recover() {
  state.supervisor.status = 'idle';
  const lost = running();
  for (const a of lost) {
    a.status = 'failed';
    a.endedAt = now();
    a.activity = 'interrupted';
    a.report = 'Interrupted: the manager server restarted while this agent was running.';
  }
  if (lost.length) {
    addChat('system', `Server restarted; ${lost.map((a) => a.id).join(', ')} were interrupted.`);
    wakeSupervisor(`Server restarted. Interrupted agents: ${lost.map((a) => `${a.id} (${a.taskId})`).join(', ')}. Decide whether to respawn or continue yourself.`);
  }
  changed();
}

module.exports = {
  config, WORKSPACE, UserError, TASK_STATUSES,
  getTask, getAgent, findAgent, rootOf, planApproved,
  addChat, sendUserMessage, stopSupervisor,
  submitUserTask, createTask, setPlan, updateOpenPoints, approveTask, updateTask, cancelTask, taskSummary,
  spawnAgent, sendToAgent, stopAgent, setAgentTodos,
  snapshot, recover,
};
