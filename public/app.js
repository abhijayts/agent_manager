(() => {
  const $ = (s) => document.querySelector(s);
  let S = { tasks: [], agents: [], supervisors: { general: { status: 'idle' } }, config: {} };
  const chat = []; // every scope; the panel shows only the selected one
  let scope = localStorage.getItem('scope') || 'general';
  const unread = {};
  const sup = (id) => S.supervisors?.[id] || { status: 'idle' };
  let openView = null; // { type: 'task'|'agent'|'new', id }
  let agentLog = []; // log of the agent drawer that is currently open

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const badge = (s) => `<span class="badge s-${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
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

  // ---------- header ----------
  function renderHeader() {
    const workingN = Object.values(S.supervisors || {}).filter((s) => s.status === 'working').length;
    $('#sup-pill').className = 'pill ' + (workingN ? 'working' : 'idle');
    $('#sup-text').textContent = workingN ? `${workingN} supervisor${workingN > 1 ? 's' : ''} working` : 'supervisors idle';
    const live = S.agents.filter((a) => ['running', 'starting'].includes(a.status));
    const liveTasks = new Set(live.map((a) => rootOf(S.tasks.find((t) => t.id === a.taskId) || { id: a.taskId }).id)).size;
    const open = S.tasks.filter((t) => !t.parentId && !['done', 'failed', 'cancelled'].includes(t.status)).length;
    $('#stats').textContent = `${live.length} agent${live.length === 1 ? '' : 's'} running${live.length ? ` across ${liveTasks} task${liveTasks > 1 ? 's' : ''}` : ''} · ${open} open task${open === 1 ? '' : 's'}`;
  }

  // ---------- tasks ----------
  const rootOf = (t) => (t.parentId ? S.tasks.find((x) => x.id === t.parentId) || t : t);
  function taskProgress(t) {
    const kids = S.tasks.filter((x) => x.parentId === t.id);
    if (!kids.length) return null;
    return { done: kids.filter((k) => k.status === 'done').length, total: kids.length };
  }
  function renderTasks() {
    const el = $('#tasks');
    $('#tasks-count').textContent = S.tasks.length || '';
    if (!S.tasks.length) {
      el.innerHTML = '<div class="empty">No tasks yet.<br>Click “New task” to give the supervisor something to do.</div>';
      return;
    }
    const roots = S.tasks.filter((t) => !t.parentId).reverse();
    const card = (t, sub) => {
      const needsApproval = t.status === 'awaiting_approval';
      const prog = taskProgress(t);
      const planBadge = sub ? '' : t.plan ? (t.plan.approved ? '<span class="chip">plan ✓</span>' : '<span class="chip" style="color:var(--warn)">plan: needs your approval</span>') : '<span class="chip">no plan</span>';
      const agents = t.agentIds.map((id) => `<span class="chip">${esc(id)}</span>`).join('');
      const working = !sub && sup(t.id).status === 'working' ? '<span class="work-dot" title="its supervisor is working"></span>' : '';
      const chatBtn = sub ? '' : `<button class="ghost small" data-chat="${t.id}">${unread[t.id] ? '● ' : ''}chat</button>`;
      return `<div class="card ${sub ? 'sub' : ''}" data-task="${t.id}">
        <div class="row"><span class="id">${t.id}</span><span class="title grow">${esc(t.title)}</span>${working}${badge(t.status)}</div>
        <div class="meta">${planBadge}${agents}${prog ? `<span>${prog.done}/${prog.total} subtasks</span>` : ''}${needsApproval ? `<button class="primary small" data-approve="${t.id}">Approve plan</button>` : ''}<span class="grow"></span>${chatBtn}</div>
        ${prog ? `<div class="bar"><i style="width:${(prog.done / prog.total) * 100}%"></i></div>` : ''}
      </div>`;
    };
    el.innerHTML = roots.map((r) => card(r, false) + S.tasks.filter((k) => k.parentId === r.id).map((k) => card(k, true)).join('')).join('');
  }

  // ---------- agents ----------
  function todoSummary(a) {
    if (!a.todos?.length) return '';
    const done = a.todos.filter((t) => t.status === 'done').length;
    const cur = a.todos.find((t) => t.status === 'in_progress');
    return `<div class="todo-line">☑ ${done}/${a.todos.length}${cur ? ' · ' + esc(cur.text) : ''}</div><div class="bar"><i style="width:${(done / a.todos.length) * 100}%"></i></div>`;
  }
  function renderAgents() {
    const el = $('#agents');
    $('#agents-count').textContent = S.agents.length || '';
    if (!S.agents.length) {
      el.innerHTML = '<div class="empty">No agents yet.<br>The supervisor spawns them when a task needs parallel work. Easy tasks it does itself.</div>';
      return;
    }
    const order = { running: 0, starting: 0, failed: 1, stopped: 2, done: 3 };
    const list = [...S.agents].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.id.localeCompare(a.id, undefined, { numeric: true }));
    el.innerHTML = list
      .map((a) => `<div class="card" data-agent="${a.id}">
        <div class="row"><span class="id">${a.id}</span><span class="title grow">${esc(a.name)}</span>${badge(a.status)}</div>
        <div class="meta"><span class="chip">${esc(a.taskId)}</span><span>${esc((S.tasks.find((t) => t.id === a.taskId) || {}).title || '')}</span></div>
        <div class="activity">${esc(a.activity || '')}</div>
        <div class="meta"><span class="chip owns" title="paths this agent may write">${a.owns?.length ? 'writes: ' + esc(a.owns.map((p) => p || '.').join(', ')) : 'read-only'}</span></div>
        ${todoSummary(a)}
      </div>`)
      .join('');
  }

  // ---------- chat ----------
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
    el.innerHTML = '';
    const mine = chat.filter((e) => e.scope === scope);
    if (!mine.length) {
      el.innerHTML = `<div class="empty">${scope === 'general' ? 'General overview: ask what is running, what is blocked, how a task is going.<br>Each task has its own supervisor chat (pick it above).' : 'No messages yet for this task.'}</div>`;
    }
    mine.forEach((e) => el.appendChild(chatNode(e)));
    el.scrollTop = el.scrollHeight;
    updateThinking();
  }
  function appendChat(e) {
    chat.push(e);
    if (e.scope !== scope) {
      if (e.role === 'supervisor' && e.scope !== 'general') {
        unread[e.scope] = (unread[e.scope] || 0) + 1;
        renderScopeSelect();
        renderTasks();
      }
      return;
    }
    const el = $('#chat');
    const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    el.querySelector('.empty')?.remove();
    const th = $('#thinking');
    if (th) th.remove();
    el.appendChild(chatNode(e));
    updateThinking();
    if (stick) el.scrollTop = el.scrollHeight;
  }

  let scopeSig = '';
  function renderScopeSelect() {
    const roots = S.tasks.filter((t) => !t.parentId).reverse();
    const opts = [{ id: 'general', label: 'General overview' }, ...roots.map((t) => ({ id: t.id, label: `${t.id} · ${t.title.slice(0, 40)}` }))];
    if (!opts.some((o) => o.id === scope)) scope = 'general';
    const sig = JSON.stringify(opts.map((o) => [o.id, o.label, sup(o.id).status, unread[o.id] || 0])) + scope;
    const st = sup(scope);
    $('#scope-state').textContent = st.status === 'working' ? `working · ${ago(st.since)}${st.queued ? ` · ${st.queued} queued` : ''}` : 'idle';
    $('#sup-stop').classList.toggle('hidden', st.status !== 'working');
    if (sig === scopeSig) return;
    scopeSig = sig;
    const sel = $('#scope');
    sel.innerHTML = opts.map((o) => `<option value="${o.id}">${esc((unread[o.id] ? '● ' : '') + (sup(o.id).status === 'working' ? '… ' : '') + o.label)}</option>`).join('');
    sel.value = scope;
    $('#msg').placeholder = scope === 'general' ? 'Ask for an overview…  (read-only; use a task chat to direct work)' : `Message the supervisor of ${scope}…  (@a1 or @name to point at an agent · Enter to send)`;
  }
  function selectScope(id) {
    scope = id;
    localStorage.setItem('scope', id);
    unread[id] = 0;
    scopeSig = '';
    renderScopeSelect();
    renderTasks();
    renderChatAll();
    $('#msg').focus();
  }
  function updateThinking() {
    const el = $('#chat');
    let th = $('#thinking');
    const working = sup(scope).status === 'working';
    if (working && !th) {
      th = document.createElement('div');
      th.id = 'thinking';
      th.className = 'thinking';
      th.textContent = (scope === 'general' ? 'assistant' : `supervisor of ${scope}`) + ' is working…';
      el.appendChild(th);
      el.scrollTop = el.scrollHeight;
    } else if (!working && th) th.remove();
    else if (working && th && el.lastChild !== th) el.appendChild(th);
  }

  // ---------- modal ----------
  const modal = $('#modal');
  const sheet = $('#sheet');
  function openModal(view) {
    openView = view;
    renderModal();
    modal.classList.remove('hidden');
  }
  function closeModal() {
    openView = null;
    modal.classList.add('hidden');
  }
  function renderModal() {
    if (!openView) return;
    if (openView.type === 'new') return renderNewTask();
    if (openView.type === 'task') return renderTaskDetail();
    if (openView.type === 'agent') return renderAgentDetail();
  }
  function renderNewTask() {
    if (sheet.dataset.view === 'new') return; // do not wipe the form on state refresh
    sheet.dataset.view = 'new';
    sheet.innerHTML = `<h3>New task</h3><div class="muted">The supervisor decides whether to do it alone or with subagents. No work starts without an approved plan.</div>
      <form id="new-form">
        <label>What should be done? *</label><textarea name="prompt" rows="5" required placeholder="Describe the task"></textarea>
        <label>Existing plan (optional): leave empty and the supervisor will draft one for your approval</label><textarea name="plan" rows="5" placeholder="1. …&#10;2. …"></textarea>
        <div class="two">
          <div><label>Open points (optional, non-blocking, may change during the work)</label><textarea name="openPoints" rows="2"></textarea></div>
          <div><label>Number of subagents (optional, empty = supervisor decides, up to ${S.config.maxAgentsPerTask || 5} at once)</label><input name="agents" type="number" min="1" max="${S.config.maxAgentsPerTask || 5}" placeholder="auto"></div>
        </div>
        <div class="actions"><button type="button" class="ghost" data-close>Cancel</button><button class="primary" type="submit">Start task</button></div>
      </form>`;
    $('#new-form textarea').focus();
  }
  function renderTaskDetail() {
    const t = S.tasks.find((x) => x.id === openView.id);
    if (!t) return closeModal();
    sheet.dataset.view = 'task';
    const root = rootOf(t);
    const plan = root.plan;
    const agents = t.agentIds.map((id) => S.agents.find((a) => a.id === id)).filter(Boolean);
    const kids = S.tasks.filter((x) => x.parentId === t.id);
    sheet.innerHTML = `<div class="row"><span class="id">${t.id}</span><h3 class="grow" style="margin:0">${esc(t.title)}</h3>${badge(t.status)}</div>
      <h4>Request</h4><div class="block">${esc(t.prompt)}</div>
      <h4>Plan ${plan ? (plan.approved ? '· approved' : '· <span style="color:var(--warn)">waiting for your approval</span>') : '· none yet'}${t.parentId ? ` (from ${root.id})` : ''}</h4>
      ${plan ? `<div class="block">${esc(plan.text)}</div><h4>Open points (non-blocking)</h4><div class="block">${esc(plan.openPoints || '(none)')}</div>` : '<div class="muted">The supervisor has not drafted a plan yet.</div>'}
      <div class="row" style="margin-top:12px"><button data-chat="${root.id}">Open ${root.id} supervisor chat</button></div>
      ${agents.length ? `<h4>Agents</h4><div class="row" style="flex-wrap:wrap">${agents.map((a) => `<span class="card" data-agent="${a.id}" style="padding:4px 10px">${a.id} ${esc(a.name)} ${badge(a.status)}</span>`).join('')}</div>` : ''}
      ${kids.length ? `<h4>Subtasks</h4>${kids.map((k) => `<div class="row" style="padding:2px 0"><span class="id">${k.id}</span><span class="grow">${esc(k.title)}</span>${badge(k.status)}</div>`).join('')}` : ''}
      ${t.notes.length ? `<h4>Notes</h4><div class="block">${t.notes.map((n) => `${ago(n.ts)} ago · ${esc(n.text)}`).join('\n')}</div>` : ''}
      <div class="actions">
        ${!t.parentId && plan && !plan.approved ? `<button class="primary" data-approve="${t.id}">Approve plan</button>` : ''}
        ${!t.parentId && !['done', 'failed', 'cancelled'].includes(t.status) ? `<button class="danger" data-cancel="${t.id}">Cancel task</button>` : ''}
        <button class="ghost" data-close>Close</button>
      </div>`;
  }
  async function renderAgentDetail() {
    const a = S.agents.find((x) => x.id === openView.id);
    if (!a) return closeModal();
    const logEl = $('#agent-log');
    const keepScroll = logEl ? logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40 : true;
    sheet.dataset.view = 'agent';
    sheet.innerHTML = `<div class="row"><span class="id">${a.id}</span><h3 class="grow" style="margin:0">${esc(a.name)}</h3>${badge(a.status)}</div>
      <div class="muted">on ${a.taskId} · started ${ago(a.startedAt)} ago${a.endedAt ? ' · ended ' + ago(a.endedAt) + ' ago' : ''}</div>
      <h4>Objective</h4><div class="block">${esc(a.objective)}</div>
      <h4>May write to</h4><div class="muted">${a.owns?.length ? esc(a.owns.map((p) => p || '. (whole workspace)').join(', ')) : 'nothing (read-only agent)'}</div>
      <h4>Its own checklist</h4>${a.todos.length ? `<ul class="checklist">${a.todos.map((t) => `<li class="${t.status}">${esc(t.text)}</li>`).join('')}</ul>` : '<div class="muted">The agent has not written a checklist yet.</div>'}
      ${a.report ? `<h4>Final report</h4><div class="block">${esc(a.report)}</div>` : ''}
      <h4>Live activity (read-only)</h4><div class="log" id="agent-log">${agentLogHtml()}</div>
      <div class="actions">${['running', 'starting'].includes(a.status) ? `<button class="danger" data-stop="${a.id}">Stop agent</button>` : ''}<button class="ghost" data-close>Close</button></div>`;
    const l = $('#agent-log');
    if (keepScroll) l.scrollTop = l.scrollHeight;
  }
  const agentLogHtml = () => agentLog.filter((e) => e.kind !== 'input' || true).map((e) => `<div class="${e.kind}">${esc(e.kind === 'tool' ? '→ ' + e.text : e.kind === 'input' ? '▸ ' + e.text : e.text)}</div>`).join('');

  async function openAgent(id) {
    agentLog = [];
    openModal({ type: 'agent', id });
    try {
      const { log } = await api('GET', `/agents/${id}/log`);
      if (openView?.type === 'agent' && openView.id === id) {
        agentLog = log;
        renderAgentDetail();
      }
    } catch {}
  }

  // ---------- events ----------
  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.closest('[data-close]') || t === modal) return closeModal();
    const ch = t.closest('[data-chat]');
    if (ch) {
      closeModal();
      return selectScope(ch.dataset.chat);
    }
    const ap = t.closest('[data-approve]');
    if (ap) {
      ev.stopPropagation();
      await api('POST', `/tasks/${ap.dataset.approve}/approve`).catch(() => {});
      return;
    }
    const cn = t.closest('[data-cancel]');
    if (cn) {
      if (confirm(`Cancel ${cn.dataset.cancel} and stop its agents?`)) await api('POST', `/tasks/${cn.dataset.cancel}/cancel`).catch(() => {});
      return;
    }
    const st = t.closest('[data-stop]');
    if (st) return void api('POST', `/agents/${st.dataset.stop}/stop`).catch(() => {});
    const ag = t.closest('[data-agent]');
    if (ag) return openAgent(ag.dataset.agent);
    const tk = t.closest('[data-task]');
    if (tk) return openModal({ type: 'task', id: tk.dataset.task });
  });
  $('#new-task').onclick = () => {
    sheet.dataset.view = '';
    openModal({ type: 'new' });
  };
  $('#sup-stop').onclick = () => api('POST', `/supervisors/${scope}/stop`).catch(() => {});
  $('#scope').onchange = (e) => selectScope(e.target.value);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'new-form') {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      await api('POST', '/tasks', f)
        .then((task) => {
          closeModal();
          selectScope(task.id); // jump to the new task's own supervisor chat
        })
        .catch(() => {});
    } else if (e.target.id === 'composer') {
      e.preventDefault();
      const box = $('#msg');
      const text = box.value.trim();
      if (!text) return;
      box.value = '';
      await api('POST', '/chat', { scope, text }).catch(() => (box.value = text));
    }
  });
  $('#msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });

  function renderAll() {
    renderHeader();
    renderTasks();
    renderAgents();
    renderScopeSelect();
    updateThinking();
    if (openView && openView.type !== 'new') renderModal();
  }

  async function init() {
    const s = await api('GET', '/state');
    S = s;
    chat.length = 0;
    chat.push(...s.chat);
    renderAll();
    renderChatAll();
    const es = new EventSource('/api/events');
    es.addEventListener('state', (e) => {
      S = { ...S, ...JSON.parse(e.data) };
      renderAll();
    });
    es.addEventListener('chat', (e) => appendChat(JSON.parse(e.data)));
    es.addEventListener('notice', (e) => toast(JSON.parse(e.data).text, 'info', 8000));
    es.addEventListener('log', (e) => {
      const { agentId, entry } = JSON.parse(e.data);
      if (openView?.type === 'agent' && openView.id === agentId) {
        agentLog.push(entry);
        const l = $('#agent-log');
        if (l) {
          const stick = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
          const d = document.createElement('div');
          d.className = entry.kind;
          d.textContent = entry.kind === 'tool' ? '→ ' + entry.text : entry.text;
          l.appendChild(d);
          if (stick) l.scrollTop = l.scrollHeight;
        }
      }
    });
    es.onerror = () => {}; // EventSource reconnects by itself
    setInterval(() => {
      renderHeader();
      renderScopeSelect();
    }, 5000);
  }
  init();
})();
