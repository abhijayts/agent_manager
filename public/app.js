(() => {
  const $ = (s) => document.querySelector(s);

  // ---------- state ----------
  let S = { tasks: [], agents: [], supervisors: { general: { status: 'idle' } }, config: {} };
  const chat = []; // every scope; the main pane shows only the open one
  const unread = {}; // scope -> count of unseen supervisor messages
  const sup = (id) => S.supervisors?.[id] || { status: 'idle' };
  const expanded = new Set(JSON.parse(localStorage.getItem('expanded') || '[]'));
  const saveExpanded = () => localStorage.setItem('expanded', JSON.stringify([...expanded]));
  let nav = { scope: 'general', view: 'chat' }; // view: chat | overview | agent | sub
  let navKey = '';
  let agentLog = [];
  let agentTab = 'overview';

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const badge = (s) => `<span class="badge s-${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
  const sdot = (s) => `<i class="sdot s-${esc(s)}"></i>`;
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  };
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false });
  function dur(a) {
    const s = Math.max(0, ((a.endedAt ? new Date(a.endedAt) : Date.now()) - new Date(a.startedAt)) / 1000);
    return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const hue = (str) => [...String(str)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const isLive = (a) => a.status === 'running' || a.status === 'starting';
  const avatar = (a, size = '') => `<div class="avatar ${size} ${isLive(a) ? 'live' : ''}" style="--h:${hue(a.name)}">${esc(a.name.charAt(0))}</div>`;
  const typing = '<span class="typing"><i></i><i></i><i></i></span>';
  const empty = (icon, html) => `<div class="empty"><b>${icon}</b>${html}</div>`;
  // Only touch the DOM when the markup really changed: keeps hover/scroll state and avoids flicker.
  const setHtml = (el, html) => {
    if (!el) return false;
    if (el._html === html) return false;
    el._html = html;
    el.innerHTML = html;
    return true;
  };
  const svg = (p) => `<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ic = {
    chat: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'),
    doc: svg('<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 8h4M6 10.5h4"/>'),
    task: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M5.5 8.2l1.8 1.8 3.2-3.5"/>'),
    globe: svg('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11"/>'),
    chev: svg('<path d="M6 4l4 4-4 4"/>'),
  };
  function md(text) {
    let out = esc(text);
    out = out.replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.replace(/^\w*\n/, '')}</pre>`);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    return out;
  }
  function toast(msg, kind = 'error', ms = 4000) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + kind;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.add('hidden'), ms);
  }
  async function api(method, url, body) {
    const r = await fetch('/api' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(data.error || r.statusText);
      throw new Error(data.error || r.statusText);
    }
    return data;
  }

  // ---------- model helpers ----------
  const getTask = (id) => S.tasks.find((t) => t.id === id);
  const rootOf = (t) => {
    let x = t;
    for (let i = 0; x.parentId && i < 20; i++) x = getTask(x.parentId) || x;
    return x;
  };
  const scopeOfAgent = (a) => {
    const t = getTask(a.taskId);
    return t ? rootOf(t).id : a.taskId;
  };
  const agentsIn = (scope) => S.agents.filter((a) => scopeOfAgent(a) === scope);
  const familyOf = (rootId) => S.tasks.filter((t) => t.id !== rootId && rootOf(t).id === rootId);
  function taskProgress(t) {
    const kids = S.tasks.filter((x) => x.parentId === t.id);
    return kids.length ? { done: kids.filter((k) => k.status === 'done').length, total: kids.length } : null;
  }
  function todoSummary(a) {
    if (!a.todos?.length) return '';
    const done = a.todos.filter((t) => t.status === 'done').length;
    const cur = a.todos.find((t) => t.status === 'in_progress');
    return `<div class="todo-line">☑ ${done}/${a.todos.length}${cur ? ' · ' + esc(cur.text) : ''}</div><div class="bar"><i style="width:${(done / a.todos.length) * 100}%"></i></div>`;
  }

  // ---------- routing (#/T1/chat, #/T1/overview, #/T1/agent/a2, #/T1/sub/T3, #/general) ----------
  function parseHash() {
    const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!p.length) return null;
    if (p[0].toLowerCase() === 'general') return { scope: 'general', view: 'chat' };
    const scope = p[0].toUpperCase();
    const root = S.tasks.find((t) => t.id === scope && !t.parentId);
    if (!root) return null;
    const view = p[1] || 'chat';
    if (view === 'overview') return { scope, view };
    if (view === 'agent') {
      const a = S.agents.find((x) => x.id === (p[2] || '').toLowerCase());
      if (a && scopeOfAgent(a) === scope) return { scope, view, id: a.id };
    }
    if (view === 'sub') {
      const s = S.tasks.find((t) => t.id === (p[2] || '').toUpperCase());
      if (s && s.parentId && rootOf(s).id === scope) return { scope, view, id: s.id };
    }
    return { scope, view: 'chat' };
  }
  const pathOf = (n) => (n.scope === 'general' ? 'general' : [n.scope, n.view, n.id].filter(Boolean).join('/'));
  function go(path) {
    if (location.hash === '#/' + path) route();
    else location.hash = '#/' + path;
  }
  function route() {
    const n = parseHash() || { scope: 'general', view: 'chat' };
    const key = pathOf(n);
    if (key === navKey) return updateView();
    nav = n;
    navKey = key;
    localStorage.setItem('nav', key);
    if (n.scope !== 'general') {
      expanded.add(n.scope);
      saveExpanded();
    }
    if (n.view === 'chat') unread[n.scope] = 0;
    mountView();
    renderTree();
    updateView();
  }
  window.addEventListener('hashchange', route);

  // ---------- header ----------
  function renderHeader() {
    const workingN = Object.values(S.supervisors || {}).filter((s) => s.status === 'working').length;
    $('#sup-pill').className = 'pill ' + (workingN ? 'working' : 'idle');
    $('#sup-text').textContent = workingN ? `${workingN} supervisor${workingN > 1 ? 's' : ''} working` : 'supervisors idle';
    const live = S.agents.filter(isLive);
    const liveTasks = new Set(live.map(scopeOfAgent)).size;
    const open = S.tasks.filter((t) => !t.parentId && !['done', 'failed', 'cancelled'].includes(t.status)).length;
    $('#stats').textContent = `${live.length} agent${live.length === 1 ? '' : 's'} running${live.length ? ` across ${liveTasks} task${liveTasks > 1 ? 's' : ''}` : ''} · ${open} open task${open === 1 ? '' : 's'}`;
  }

  // ---------- explorer (navigates across ALL tasks) ----------
  function row({ depth = 0, to, cls = '', toggle = null, open = false, icon = '', label, trail = '', sel = false, title = '' }) {
    const chev = toggle ? `<span class="chev ${open ? 'open' : ''}" data-toggle="${toggle}">${ic.chev}</span>` : '<span class="chev none"></span>';
    return `<div class="tr ${cls} ${sel ? 'sel' : ''}" style="--d:${depth}" data-nav="${to}" title="${esc(title)}">${chev}${icon}<span class="lbl">${label}</span>${trail}</div>`;
  }
  function treeHtml() {
    const out = [];
    out.push(row({ to: 'general', icon: ic.globe, label: 'General overview', trail: sup('general').status === 'working' ? '<span class="work-dot"></span>' : '', sel: nav.scope === 'general' }));
    const roots = S.tasks.filter((t) => !t.parentId).reverse();
    out.push('<div class="tree-sep"></div>');
    if (!roots.length) out.push('<div class="tree-empty">No tasks yet. Click “New task”.</div>');
    for (const t of roots) {
      const open = expanded.has(t.id);
      const here = nav.scope === t.id;
      const trail = [
        sup(t.id).status === 'working' ? '<span class="work-dot" title="supervisor working"></span>' : '',
        t.status === 'awaiting_approval' ? '<span class="chip warn tiny">approve</span>' : '',
        unread[t.id] ? '<span class="unread" title="new message"></span>' : '',
        sdot(t.status),
      ].join('');
      out.push(row({ to: `${t.id}/chat`, cls: `task s-${t.status} ${here ? 'in' : ''}`, toggle: t.id, open, icon: ic.task, label: `<span class="id">${t.id}</span><span class="t">${esc(t.title)}</span>`, trail, title: t.title }));
      if (!open) continue;
      out.push(row({ depth: 1, to: `${t.id}/chat`, icon: ic.chat, label: 'Supervisor', trail: unread[t.id] ? '<span class="unread"></span>' : sup(t.id).status === 'working' ? '<span class="work-dot"></span>' : '', sel: here && nav.view === 'chat' }));
      out.push(row({ depth: 1, to: `${t.id}/overview`, icon: ic.doc, label: 'Overview · plan', sel: here && nav.view === 'overview' }));
      const agentRow = (a, depth) => row({ depth, to: `${t.id}/agent/${a.id}`, icon: avatar(a, 'xs'), label: esc(a.name), trail: `${isLive(a) ? typing : ''}${sdot(a.status)}`, sel: here && nav.view === 'agent' && nav.id === a.id, title: `${a.id} · ${a.status}` });
      for (const k of familyOf(t.id)) {
        out.push(row({ depth: 1, to: `${t.id}/sub/${k.id}`, cls: `s-${k.status}`, icon: ic.task, label: `<span class="id">${k.id}</span>${esc(k.title)}`, trail: sdot(k.status), sel: here && nav.view === 'sub' && nav.id === k.id, title: k.title }));
        for (const a of S.agents.filter((x) => x.taskId === k.id)) out.push(agentRow(a, 2));
      }
      for (const a of S.agents.filter((x) => x.taskId === t.id)) out.push(agentRow(a, 1));
    }
    return out.join('');
  }
  function renderTree() {
    const tree = $('#tree');
    $('#tasks-count').textContent = S.tasks.filter((t) => !t.parentId).length || '';
    const top = tree.scrollTop;
    if (setHtml(tree, treeHtml())) tree.scrollTop = top;
  }

  // ---------- main pane: header + tabs (scoped to ONE task) ----------
  function headHtml() {
    if (nav.scope === 'general') {
      return `<div class="phead"><div class="avatar" style="--h:250">${ic.globe}</div><div class="grow"><h3>General overview</h3><div class="sub">Read-only assistant for the whole picture · each task has its own supervisor in the explorer</div></div></div>`;
    }
    const t = getTask(nav.scope);
    if (!t) return '';
    const agents = agentsIn(t.id);
    const prog = taskProgress(t);
    const plan = t.plan;
    return `<div class="phead"><div class="avatar" style="--h:${hue(t.id)}">${esc(t.id)}</div>
      <div class="grow"><h3>${esc(t.title)}</h3>
        <div class="sub">${badge(t.status)}<span class="chip">plan ${plan ? (plan.approved ? '✓ approved' : '… needs approval') : '— none'}</span>${agents.length ? `<span class="chip">${agents.filter(isLive).length}/${agents.length} agents running</span>` : ''}${prog ? `<span class="chip">${prog.done}/${prog.total} subtasks</span>` : ''}<span>created ${ago(t.createdAt)} ago</span></div></div>
      <div class="actions">${plan && !plan.approved ? `<button class="primary" data-approve="${t.id}">Approve plan</button>` : ''}${!['done', 'failed', 'cancelled'].includes(t.status) ? `<button class="danger" data-cancel="${t.id}">Cancel task</button>` : ''}</div></div>`;
  }
  function tabsHtml() {
    if (nav.scope === 'general') return '';
    const s = nav.scope;
    const tab = (to, inner, on) => `<button class="ptab ${on ? 'on' : ''}" data-nav="${to}">${inner}</button>`;
    let h = tab(`${s}/chat`, `${ic.chat}Supervisor${unread[s] ? '<span class="unread"></span>' : sup(s).status === 'working' ? '<span class="work-dot"></span>' : ''}`, nav.view === 'chat');
    h += tab(`${s}/overview`, `${ic.doc}Overview`, nav.view === 'overview');
    const agents = agentsIn(s);
    if (agents.length) h += '<span class="sep"></span>';
    for (const a of agents) h += tab(`${s}/agent/${a.id}`, `${avatar(a, 'xs')}${esc(a.name)}${sdot(a.status)}`, nav.view === 'agent' && nav.id === a.id);
    if (nav.view === 'sub') h += '<span class="sep"></span>' + tab(pathOf(nav), `${ic.task}${esc(nav.id)}`, true);
    return `<div class="ptabs">${h}</div>`;
  }

  // ---------- main pane: views ----------
  const body = () => $('#pane-body');
  function setBody(html) {
    const b = body();
    const top = b.scrollTop;
    if (!setHtml(b, html)) return false;
    b.scrollTop = top;
    return true;
  }

  function mountView() {
    const b = body();
    b._html = null;
    b.className = 'pane-body ' + nav.view;
    b.scrollTop = 0;
    if (nav.view === 'chat') {
      b.innerHTML = `<div class="chatview"><div class="chatcol">
          <div class="chat-top"><span class="muted" id="scope-state"></span><button id="sup-stop" class="ghost small hidden">Stop turn</button></div>
          <div id="chat" class="scroll"></div>
          <form id="composer"><textarea id="msg" rows="1"></textarea><button class="primary" type="submit" title="Send"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M3 10l14-7-5 14-2.5-5.5z"/></svg></button></form>
        </div><aside class="rail" id="rail"></aside></div>`;
      renderChatAll();
      $('#msg').focus();
    } else {
      b.innerHTML = '';
      if (nav.view === 'agent') {
        agentLog = [];
        agentTab = 'overview';
        loadAgentLog(nav.id);
      }
    }
  }

  function updateView() {
    if (nav.scope !== 'general' && !getTask(nav.scope)) return go('general'); // task vanished
    setHtml($('#pane-head'), headHtml());
    setHtml($('#pane-tabs'), tabsHtml());
    if (nav.view === 'chat') {
      setHtml($('#rail'), railHtml());
      updateChatChrome();
      updateThinking();
    } else if (nav.view === 'overview') setBody(overviewHtml());
    else if (nav.view === 'sub') setBody(subHtml());
    else if (nav.view === 'agent') renderAgentView();
  }

  // ----- chat view -----
  function railHtml() {
    const general = nav.scope === 'general';
    const list = general ? S.agents.filter(isLive) : agentsIn(nav.scope);
    const order = { running: 0, starting: 0, failed: 1, stopped: 2, done: 3 };
    list.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.id.localeCompare(a.id, undefined, { numeric: true }));
    const head = `<h5>${general ? 'Running now' : 'Subagents'} <span class="count">${list.length}</span></h5>`;
    if (!list.length) return head + `<div class="muted">${general ? 'No agents are running.' : 'No subagents. Easy tasks are done by the supervisor itself.'}</div>`;
    return (
      head +
      list
        .map(
          (a) => `<div class="rcard" data-nav="${scopeOfAgent(a)}/agent/${a.id}">${avatar(a)}<div class="grow">
          <div class="row"><span class="title grow">${esc(a.name)}</span>${badge(a.status)}</div>
          <div class="activity">${isLive(a) ? typing : ''}<span class="title">${esc(a.activity || '')}</span></div>
          <div class="meta"><span class="chip owns">${a.owns?.length ? 'writes ' + esc(a.owns.map((p) => p || '.').join(', ')) : 'read-only'}</span></div>
          ${todoSummary(a)}</div></div>`
        )
        .join('')
    );
  }
  function chatNode(e) {
    const d = document.createElement('div');
    d.className = 'msg ' + e.role;
    d.dataset.id = e.id;
    if (e.role === 'tool') d.textContent = '→ ' + e.text;
    else if (e.role === 'user' || e.role === 'supervisor') d.innerHTML = md(e.text);
    else d.textContent = e.text;
    return d;
  }
  function renderChatAll() {
    const el = $('#chat');
    if (!el) return;
    el.innerHTML = '';
    const mine = chat.filter((e) => e.scope === nav.scope);
    if (!mine.length) {
      el.innerHTML = empty(nav.scope === 'general' ? '◈' : '✉', nav.scope === 'general' ? 'Ask what is running, what is blocked, how a task is going.<br>Open a task in the explorer to talk to its supervisor.' : 'No messages yet for this task.');
    }
    mine.forEach((e) => el.appendChild(chatNode(e)));
    el.scrollTop = el.scrollHeight;
    updateChatChrome();
    updateThinking();
  }
  function appendChat(e) {
    chat.push(e);
    const visible = nav.view === 'chat' && e.scope === nav.scope && $('#chat');
    if (!visible) {
      if (e.role === 'supervisor' && e.scope !== 'general') {
        unread[e.scope] = (unread[e.scope] || 0) + 1;
        renderTree();
        setHtml($('#pane-tabs'), tabsHtml());
      }
      return;
    }
    const el = $('#chat');
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    el.querySelector('.empty')?.remove();
    $('#thinking')?.remove();
    const node = chatNode(e);
    node.classList.add('enter');
    el.appendChild(node);
    updateThinking();
    if (stick) el.scrollTop = el.scrollHeight;
  }
  function updateChatChrome() {
    if (nav.view !== 'chat') return;
    const st = sup(nav.scope);
    const who = nav.scope === 'general' ? 'Assistant' : `Supervisor of ${nav.scope}`;
    const stateEl = $('#scope-state');
    if (stateEl) stateEl.textContent = `${who} · ${st.status === 'working' ? `working ${ago(st.since)}${st.queued ? ` · ${st.queued} queued` : ''}` : 'idle'}`;
    $('#sup-stop')?.classList.toggle('hidden', st.status !== 'working');
    const msg = $('#msg');
    if (msg) msg.placeholder = nav.scope === 'general' ? 'Ask for an overview…  (read-only; open a task to direct work)' : `Message ${nav.scope}’s supervisor…  (@a1 or @name to point at an agent · Enter to send)`;
  }
  function updateThinking() {
    const el = $('#chat');
    if (!el || nav.view !== 'chat') return;
    let th = $('#thinking');
    const working = sup(nav.scope).status === 'working';
    if (working && !th) {
      th = document.createElement('div');
      th.id = 'thinking';
      th.className = 'thinking';
      th.innerHTML = `${typing}<span>${nav.scope === 'general' ? 'assistant' : `supervisor of ${nav.scope}`} is working…</span>`;
      el.appendChild(th);
      el.scrollTop = el.scrollHeight;
    } else if (!working && th) th.remove();
    else if (working && th && el.lastChild !== th) el.appendChild(th);
  }

  // ----- overview view -----
  function overviewHtml() {
    const t = getTask(nav.scope);
    if (!t) return '';
    const plan = t.plan;
    const kids = familyOf(t.id);
    const agents = agentsIn(t.id);
    return `<h4>Request</h4><div class="block">${esc(t.prompt)}</div>
      <h4>Plan · ${plan ? (plan.approved ? 'approved' : '<span style="color:var(--warn)">waiting for your approval</span>') : 'none yet'}</h4>
      ${plan ? `<div class="block">${esc(plan.text)}</div>${!plan.approved ? `<div class="inline-actions"><button class="primary" data-approve="${t.id}">Approve plan</button><button data-nav="${t.id}/chat">Ask for changes in chat</button></div>` : ''}
        <h4>Open points · non-blocking</h4><div class="block">${esc(plan.openPoints || '(none)')}</div>` : '<div class="muted">The supervisor has not drafted a plan yet.</div>'}
      ${kids.length ? `<h4>Subtasks <span class="count">${kids.length}</span></h4>${kids.map((k) => `<div class="subrow" data-nav="${t.id}/sub/${k.id}"><span class="id">${k.id}</span><span class="grow title">${esc(k.title)}</span>${S.agents.filter((a) => a.taskId === k.id).map((a) => `<span class="chip">${a.id}</span>`).join('')}${badge(k.status)}</div>`).join('')}` : ''}
      ${agents.length ? `<h4>Agents <span class="count">${agents.length}</span></h4><div class="wrap">${agents.map((a) => `<span class="agentchip" data-nav="${t.id}/agent/${a.id}">${avatar(a, 'xs')}${esc(a.name)} ${badge(a.status)}</span>`).join('')}</div>` : ''}
      ${t.notes.length ? `<h4>Notes</h4><div class="block">${t.notes.map((n) => `${ago(n.ts)} ago · ${esc(n.text)}`).join('\n')}</div>` : ''}`;
  }

  // ----- subtask view -----
  function subHtml() {
    const k = getTask(nav.id);
    if (!k) return '';
    const agents = S.agents.filter((a) => a.taskId === k.id);
    return `<div class="crumbs"><a data-nav="${nav.scope}/overview">${nav.scope} overview</a> › <span>${k.id}</span></div>
      <div class="page-title"><h3>${esc(k.title)}</h3>${badge(k.status)}</div>
      <h4>Description</h4><div class="block">${esc(k.prompt)}</div>
      ${agents.length ? `<h4>Assigned agents</h4>${agents.map((a) => `<div class="rcard" style="margin-bottom:8px" data-nav="${nav.scope}/agent/${a.id}">${avatar(a)}<div class="grow"><div class="row"><span class="title grow">${esc(a.name)}</span><span class="id">${a.id}</span>${badge(a.status)}</div><div class="activity">${isLive(a) ? typing : ''}<span class="title">${esc(a.activity || '')}</span></div>${todoSummary(a)}</div></div>`).join('')}` : '<h4>Assigned agents</h4><div class="muted">No agent assigned (the supervisor may be doing this itself).</div>'}
      ${k.notes.length ? `<h4>Notes</h4><div class="block">${k.notes.map((n) => `${ago(n.ts)} ago · ${esc(n.text)}`).join('\n')}</div>` : ''}`;
  }

  // ----- agent view -----
  const tlHtml = (e) => `<div class="tl ${e.kind}"><span class="t">${esc(e.kind === 'input' ? 'Briefing · ' + e.text.slice(0, 400) : e.text)}</span><time>${clock(e.ts)}</time></div>`;
  const liveMarker = '<div class="tl running" id="tl-live"><span class="t muted">working…</span></div>';
  function fillTimeline() {
    const l = $('#agent-log');
    const a = S.agents.find((x) => x.id === nav.id);
    if (!l || !a) return;
    l.innerHTML = agentLog.map(tlHtml).join('') + (isLive(a) ? liveMarker : '');
    const b = body();
    b.scrollTop = b.scrollHeight;
  }
  async function loadAgentLog(id) {
    try {
      const { log } = await api('GET', `/agents/${id}/log`);
      if (nav.view === 'agent' && nav.id === id) {
        agentLog = log;
        const c = $('#act-count');
        if (c) c.textContent = agentLog.length;
        if (agentTab === 'activity') fillTimeline();
      }
    } catch {}
  }
  function renderAgentView() {
    const a = S.agents.find((x) => x.id === nav.id);
    if (!a) return go(`${nav.scope}/chat`);
    const task = getTask(a.taskId);
    const live = isLive(a);
    const done = a.todos.filter((t) => t.status === 'done').length;
    const pct = a.todos.length ? Math.round((done / a.todos.length) * 100) : 0;
    const overview = `<div class="grid2">
        <div>
          <h4>Objective</h4><div class="block">${esc(a.objective)}</div>
          <h4>Can write to</h4><div class="paths">${a.owns?.length ? a.owns.map((p) => `<span class="path">${esc(p || '.')}</span>`).join('') : '<span class="path ro">nothing · read-only agent</span>'}</div>
        </div>
        <div>
          <h4>Its own checklist</h4>
          ${a.todos.length ? `<div class="prog"><div class="ring" style="--p:${pct}"><span>${pct}%</span></div><div><b>${done} of ${a.todos.length}</b> steps done</div></div>
            <ul class="checklist">${a.todos.map((t) => `<li class="${t.status}">${esc(t.text)}</li>`).join('')}</ul>` : '<div class="muted">The agent has not written a checklist yet.</div>'}
        </div>
      </div>
      ${a.report ? `<h4>${a.status === 'done' ? 'Final report' : 'Last message'}</h4><div class="block report ${a.status === 'done' ? '' : 'bad'}">${esc(a.report)}</div>` : ''}`;
    const html = `<div class="ahero">${avatar(a, 'lg')}
        <div class="grow">
          <div class="row" style="gap:10px"><h3>${esc(a.name)}</h3><span class="id">${a.id}</span>${badge(a.status)}</div>
          <div class="sub"><span class="chip" data-nav="${nav.scope}/${a.taskId === nav.scope ? 'overview' : 'sub/' + a.taskId}">${esc(a.taskId)}${task ? ' · ' + esc(task.title.slice(0, 40)) : ''}</span><span>started ${ago(a.startedAt)} ago</span><span class="chip" id="agent-dur"></span></div>
          <div class="activity" id="agent-activity"></div>
        </div>${live ? `<button class="danger" data-stop="${a.id}">Stop agent</button>` : ''}</div>
      <div class="seg"><button class="${agentTab === 'overview' ? 'on' : ''}" data-tab="overview">Overview</button><button class="${agentTab === 'activity' ? 'on' : ''}" data-tab="activity">Activity <span class="count" id="act-count"></span></button></div>
      ${agentTab === 'overview' ? overview : '<div class="timeline" id="agent-log"></div>'}`;
    const rebuilt = setBody(html);
    if (rebuilt && agentTab === 'activity') fillTimeline();
    // live bits are filled in place so the page itself is not rebuilt on every tick
    setHtml($('#agent-activity'), `${live ? typing : ''}<span class="title">${esc(a.activity || '')}</span>`);
    const d = $('#agent-dur');
    if (d) d.textContent = dur(a);
    const c = $('#act-count');
    if (c) c.textContent = agentLog.length;
  }

  // ---------- new-task modal ----------
  const modal = $('#modal');
  const sheet = $('#sheet');
  const closeModal = () => modal.classList.add('hidden');
  function openNewTask() {
    sheet.innerHTML = `<form class="shell" id="new-form">
      <div class="sheet-head"><div class="avatar lg" style="--h:250">✦</div><div><h3>New task</h3><div class="sub">A supervisor takes it from here. Nothing starts without an approved plan.</div></div><button type="button" class="x" data-close title="Close (Esc)">✕</button></div>
      <div class="sheet-body">
        <label>What should be done? *</label><textarea name="prompt" rows="5" required placeholder="Describe the task"></textarea>
        <label>Existing plan (optional): leave empty and the supervisor will draft one for your approval</label><textarea name="plan" rows="5" placeholder="1. …&#10;2. …"></textarea>
        <div class="two">
          <div><label>Open points (optional, non-blocking, may change during the work)</label><textarea name="openPoints" rows="2"></textarea></div>
          <div><label>Number of subagents (optional, empty = supervisor decides, up to ${S.config.maxAgentsPerTask || 5} at once)</label><input name="agents" type="number" min="1" max="${S.config.maxAgentsPerTask || 5}" placeholder="auto"></div>
        </div>
      </div>
      <div class="sheet-foot"><button type="button" class="ghost" data-close>Cancel</button><button class="primary" type="submit">Start task</button></div></form>`;
    modal.classList.remove('hidden');
    sheet.querySelector('textarea').focus();
  }

  // ---------- events ----------
  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.closest('[data-close]') || t === modal) return closeModal();
    const tg = t.closest('[data-toggle]');
    if (tg) {
      ev.stopPropagation();
      const id = tg.dataset.toggle;
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      saveExpanded();
      return renderTree();
    }
    const tab = t.closest('[data-tab]');
    if (tab) {
      agentTab = tab.dataset.tab;
      body()._html = null;
      return renderAgentView();
    }
    const ap = t.closest('[data-approve]');
    if (ap) return void (await api('POST', `/tasks/${ap.dataset.approve}/approve`).catch(() => {}));
    const cn = t.closest('[data-cancel]');
    if (cn) {
      if (confirm(`Cancel ${cn.dataset.cancel} and stop its agents?`)) await api('POST', `/tasks/${cn.dataset.cancel}/cancel`).catch(() => {});
      return;
    }
    const st = t.closest('[data-stop]');
    if (st) return void (await api('POST', `/agents/${st.dataset.stop}/stop`).catch(() => {}));
    if (t.closest('#sup-stop')) return void (await api('POST', `/supervisors/${nav.scope}/stop`).catch(() => {}));
    const nv = t.closest('[data-nav]');
    if (nv) return go(nv.dataset.nav);
  });
  $('#new-task').onclick = openNewTask;
  $('#collapse-all').onclick = () => {
    expanded.clear();
    saveExpanded();
    renderTree();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.target.id === 'msg' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'msg') return;
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'new-form') {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      await api('POST', '/tasks', f)
        .then((task) => {
          closeModal();
          if (!getTask(task.id)) S.tasks.push(task); // the live update will confirm it in a moment
          go(`${task.id}/chat`); // jump into the new task's supervisor
        })
        .catch(() => {});
    } else if (e.target.id === 'composer') {
      e.preventDefault();
      const box = $('#msg');
      const text = box.value.trim();
      if (!text) return;
      box.value = '';
      box.style.height = 'auto';
      await api('POST', '/chat', { scope: nav.scope, text }).catch(() => (box.value = text));
    }
  });

  function renderAll() {
    // The URL is the source of truth: if it points at something that only just appeared
    // (e.g. a task created a moment ago), follow it now.
    const target = parseHash();
    if (target && pathOf(target) !== navKey) return route();
    renderHeader();
    renderTree();
    updateView();
  }

  // Full reload of server state (first load, and after the live connection was lost and came back).
  async function loadState() {
    const s = await api('GET', '/state');
    S = s;
    chat.length = 0;
    chat.push(...s.chat);
    renderHeader();
    navKey = ''; // force the current view to be rebuilt from the fresh data
    route();
    renderTree();
  }

  async function init() {
    if (!location.hash) history.replaceState(null, '', '#/' + (localStorage.getItem('nav') || 'general'));
    await loadState();
    const es = new EventSource('/api/events');
    let wasDown = false;
    es.onopen = () => {
      if (wasDown) loadState().catch(() => {});
      wasDown = false;
    };
    es.addEventListener('state', (e) => {
      S = { ...S, ...JSON.parse(e.data) };
      renderAll();
    });
    es.addEventListener('chat', (e) => appendChat(JSON.parse(e.data)));
    es.addEventListener('notice', (e) => toast(JSON.parse(e.data).text, 'info', 8000));
    es.addEventListener('log', (e) => {
      const { agentId, entry } = JSON.parse(e.data);
      if (nav.view !== 'agent' || nav.id !== agentId) return;
      agentLog.push(entry);
      const c = $('#act-count');
      if (c) c.textContent = agentLog.length;
      const l = $('#agent-log');
      if (!l) return;
      const b = body();
      const stick = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
      const marker = $('#tl-live');
      if (marker) marker.insertAdjacentHTML('beforebegin', tlHtml(entry));
      else l.insertAdjacentHTML('beforeend', tlHtml(entry));
      if (stick) b.scrollTop = b.scrollHeight;
    });
    es.onerror = () => {
      wasDown = true; // EventSource reconnects by itself; onopen then re-syncs
    };
    setInterval(() => {
      renderHeader();
      updateChatChrome();
      const d = $('#agent-dur');
      const a = nav.view === 'agent' && S.agents.find((x) => x.id === nav.id);
      if (d && a) d.textContent = dur(a);
    }, 5000);
  }
  init();
})();
