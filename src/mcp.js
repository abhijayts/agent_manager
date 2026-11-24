// MCP endpoints the spawned `claude` processes connect to.
//   /mcp/supervisor      -> "manager" tools (task list, plan, spawn agents)
//   /mcp/agent/:agentId  -> "me" tools (an agent's own checklist only)
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const m = require('./manager');

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    if (e instanceof m.UserError) return { isError: true, content: [{ type: 'text', text: e.message }] };
    console.error('[mcp]', e);
    return { isError: true, content: [{ type: 'text', text: 'Internal error: ' + e.message }] };
  }
};

function supervisorServer() {
  const s = new McpServer({ name: 'manager', version: '1.0.0' });
  const tool = (name, description, inputSchema, fn) => s.registerTool(name, { description, inputSchema }, wrap(fn));

  tool('list_tasks', 'List every task (and subtask) with status, plan approval and assigned agents.', {}, () => ({
    tasks: require('./store').state.tasks.map(m.taskSummary),
  }));

  tool('get_task', 'Full detail of one task: prompt, plan, open points, notes, agents.', { task_id: z.string() }, ({ task_id }) => {
    const t = m.getTask(task_id);
    if (!t) throw new m.UserError('No such task: ' + task_id);
    return { ...t, planApproved: m.planApproved(t), rootTask: m.rootOf(t).id };
  });

  tool(
    'create_task',
    'Add a task to the central list. Use parent_id to create a subtask of an existing task (e.g. one per agent).',
    { title: z.string(), description: z.string().optional(), parent_id: z.string().optional() },
    ({ title, description, parent_id }) => m.taskSummary(m.createTask({ title, prompt: description || title, parentId: parent_id }))
  );

  tool(
    'set_plan',
    'Save a draft plan for a top-level task. The user must approve it in the UI before any work starts. open_points are non-blocking unknowns that may change during execution.',
    { task_id: z.string(), plan: z.string(), open_points: z.string().optional() },
    ({ task_id, plan, open_points }) => m.taskSummary(m.setPlan(task_id, plan, open_points))
  );

  tool(
    'update_open_points',
    'Replace the open-points list of a plan (e.g. after one is resolved). Allowed even after approval.',
    { task_id: z.string(), open_points: z.string() },
    ({ task_id, open_points }) => {
      m.updateOpenPoints(task_id, open_points);
      return 'updated';
    }
  );

  tool(
    'update_task',
    'Update status/title/note of a task. status: in_progress | blocked | done | failed | cancelled. in_progress/blocked/done are rejected unless the plan is approved.',
    { task_id: z.string(), status: z.enum(['in_progress', 'blocked', 'done', 'failed', 'cancelled']).optional(), title: z.string().optional(), note: z.string().optional() },
    (a) => m.taskSummary(m.updateTask(a.task_id, a))
  );

  tool(
    'spawn_subagent',
    'Start a subagent (separate Claude Code process) on a task or subtask. Rejected unless the plan is approved. The agent does not see the chat: the objective must be self-contained. Returns immediately; you will be woken when it finishes.',
    { task_id: z.string(), name: z.string().describe('short kebab-case label, e.g. api-builder'), objective: z.string(), instructions: z.string().optional() },
    ({ task_id, name, objective, instructions }) => {
      const a = m.spawnAgent({ taskId: task_id, name, objective, instructions });
      return { id: a.id, name: a.name, task: a.taskId, status: a.status };
    }
  );

  tool('list_agents', 'List all agents with status, task and current activity.', {}, () => ({
    agents: require('./store').state.agents.map((a) => ({ id: a.id, name: a.name, task: a.taskId, status: a.status, activity: a.activity, todos: a.todos })),
  }));

  tool('get_agent_report', 'Final report (if finished) plus recent activity and checklist of an agent.', { agent: z.string().describe('id or name') }, ({ agent }) => {
    const a = m.findAgent(agent);
    if (!a) throw new m.UserError('No such agent: ' + agent);
    return { id: a.id, name: a.name, task: a.taskId, status: a.status, objective: a.objective, todos: a.todos, report: a.report, recent: a.log.slice(-15).map((l) => `${l.kind}: ${l.text.slice(0, 200)}`) };
  });

  tool('send_to_subagent', 'Send a follow-up instruction to a FINISHED agent (resumes its session).', { agent: z.string(), message: z.string() }, ({ agent, message }) => {
    const a = m.sendToAgent(agent, message);
    return `${a.id} resumed`;
  });

  tool('stop_subagent', 'Stop a running agent.', { agent: z.string() }, ({ agent }) => {
    const a = m.stopAgent(agent);
    return `${a.id} stopping`;
  });

  return s;
}

function agentServer(agentId) {
  const s = new McpServer({ name: 'me', version: '1.0.0' });
  s.registerTool(
    'set_my_tasks',
    {
      description: 'Replace your own checklist (shown on the dashboard). Always send the full list. status: pending | in_progress | done.',
      inputSchema: { items: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'in_progress', 'done']) })) },
    },
    wrap(({ items }) => {
      m.setAgentTodos(agentId, items);
      return 'ok';
    })
  );
  s.registerTool('get_my_tasks', { description: 'Read back your own checklist.', inputSchema: {} }, wrap(() => m.getAgent(agentId)?.todos || []));
  return s;
}

async function handle(server, req, res) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

function mount(app) {
  app.post('/mcp/supervisor', (req, res) => handle(supervisorServer(), req, res));
  app.post('/mcp/agent/:id', (req, res) => {
    if (!m.getAgent(req.params.id)) return res.status(404).json({ error: 'unknown agent' });
    return handle(agentServer(req.params.id), req, res);
  });
  const no = (req, res) => res.status(405).set('Allow', 'POST').end();
  app.get('/mcp/*splat', no);
  app.delete('/mcp/*splat', no);
}

module.exports = { mount };
