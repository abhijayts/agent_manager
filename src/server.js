const path = require('path');
const express = require('express');
const store = require('./store');
store.load();
const m = require('./manager');
const mcp = require('./mcp');

const app = express();
const LOCAL = /^(localhost|127\.0\.0\.1)$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Personal tool bound to localhost. Still refuse foreign Host/Origin headers so a random
// web page cannot talk to it (DNS rebinding / cross-site POST).
app.use((req, res, next) => {
  if (!LOCAL.test((req.headers.host || '').replace(/:\d+$/, ''))) return res.status(403).end('forbidden host');
  if (req.method !== 'GET' && req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) return res.status(403).end('forbidden origin');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
mcp.mount(app);

const api = express.Router();
const h = (fn) => (req, res) => {
  try {
    res.json(fn(req) ?? { ok: true });
  } catch (e) {
    if (e instanceof m.UserError) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

api.get('/state', h(() => m.snapshot({ withChat: true })));
api.post('/tasks', h((req) => m.submitUserTask({ title: req.body.title, prompt: req.body.prompt, plan: req.body.plan, openPoints: req.body.openPoints, agents: parseInt(req.body.agents, 10) || null })));
api.post('/tasks/:id/approve', h((req) => m.approveTask(req.params.id)));
api.post('/tasks/:id/cancel', h((req) => m.cancelTask(req.params.id)));
api.post('/chat', h((req) => m.sendUserMessage(req.body.scope || m.GENERAL, req.body.text)));
api.post('/supervisors/:scope/stop', h((req) => m.stopSupervisor(req.params.scope)));
api.post('/agents/:id/stop', h((req) => {
  m.stopAgent(req.params.id);
}));
api.get('/agents/:id/log', h((req) => {
  const a = m.getAgent(req.params.id);
  if (!a) throw new m.UserError('no such agent');
  return { log: a.log };
}));

// Server-sent events: state snapshots (debounced) + incremental chat/log entries.
api.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let t = null;
  const onChanged = () => {
    if (t) return;
    t = setTimeout(() => {
      t = null;
      send('state', m.snapshot());
    }, 120);
  };
  const onChat = (entry) => send('chat', entry);
  const onLog = (d) => send('log', d);
  const onNotice = (d) => send('notice', d);
  store.bus.on('changed', onChanged);
  store.bus.on('chat', onChat);
  store.bus.on('log', onLog);
  store.bus.on('notice', onNotice);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clearTimeout(t);
    store.bus.off('changed', onChanged);
    store.bus.off('chat', onChat);
    store.bus.off('log', onLog);
    store.bus.off('notice', onNotice);
  });
});
app.use('/api', api);

m.recover();
const server = app.listen(m.config.port, '127.0.0.1', () => {
  console.log(`Agent Manager running at http://localhost:${m.config.port}`);
  console.log(`Workspace: ${m.WORKSPACE}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.flush();
    server.close();
    process.exit(0);
  });
}
