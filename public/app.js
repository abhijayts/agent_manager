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
  // Only touch the DOM when markup really changed: keeps hover/scroll state and avoids flicker.
  const setHtml = (el, html) => {
    if (el._html !== html) {
      el._html = html;
      el.innerHTML = html;
    }
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
      setHtml(el, empty('✦', 'No tasks yet.<br>Click “New task” to give a supervisor something to do.'));
      return;
    }
    const roots = S.tasks.filter((t) => !t.parentId).reverse();
    const card = (t, sub) => {
      const needsApproval = t.status === 'awaiting_approval';
      const prog = taskProgress(t);
      const planBadge = sub ? '' : t.plan ? (t.plan.approved ? '<span class="chip">plan ✓</span>' : '<span class="chip warn">plan needs your approval</span>') : '<span class="chip">no plan</span>';
      const agents = t.agentIds.map((id) => `<span class="chip">${esc(id)}</span>`).join('');
      const working = !sub && sup(t.id).status === 'working' ? '<span class="work-dot" title="its supervisor is working"></span>' : '';
      const chatBtn = sub ? '' : `<button class="ghost small" data-chat="${t.id}">${unread[t.id] ? '● ' : ''}chat</button>`;
      return `<div class="card task s-${t.status} ${sub ? 'sub' : ''}" data-task="${t.id}">
        <div class="row"><span class="id">${t.id}</span><span class="title grow">${esc(t.title)}</span>${working}${badge(t.status)}</div>
        <div class="meta">${planBadge}${agents}${prog ? `<span>${prog.done}/${prog.total} subtasks</span>` : ''}${needsApproval ? `<button class="primary small" data-approve="${t.id}">Approve plan</button>` : ''}<span class="grow"></span>${chatBtn}</div>
        ${prog ? `<div class="bar"><i style="width:${(prog.done / prog.total) * 100}%"></i></div>` : ''}
      </div>`;
    };
    setHtml(el, roots.map((r) => card(r, false) + S.tasks.filter((k) => k.parentId === r.id).map((k) => card(k, true)).join('')).join(''));
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
      setHtml(el, empty('◎', 'No agents yet.<br>Supervisors spawn them when a task needs parallel work. Easy tasks they do themselves.'));
      return;
    }
    const order = { running: 0, starting: 0, failed: 1, stopped: 2, done: 3 };
    const list = [...S.agents].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.id.localeCompare(a.id, undefined, { numeric: true }));
    setHtml(
      el,
      list
        .map((a) => `<div class="card agent s-${a.status}" data-agent="${a.id}">
        ${avatar(a)}
        <div class="grow">
          <div class="row"><span class="title grow">${esc(a.name)}</span><span class="id">${a.id}</span>${badge(a.status)}</div>
          <div class="meta" style="margin-top:3px"><span class="chip">${esc(a.taskId)}</span><span class="title">${esc((S.tasks.find((t) => t.id === a.taskId) || {}).title || '')}</span></div>
          <div class="activity">${isLive(a) ? typing : ''}<span class="title">${esc(a.activity || '')}</span></div>
          <div class="meta"><span class="chip owns" title="paths this agent may write">${a.owns?.length ? 'writes ' + esc(a.owns.map((p) => p || '.').join(', ')) : 'read-only'}</span></div>
          ${todoSummary(a)}
        </div>
      </div>`)
        .join('')
    );
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
      el.innerHTML = empty(scope === 'general' ? '◈' : '✉', scope === 'general' ? 'General overview: ask what is running, what is blocked, how a task is going.<br>Each task has its own supervisor chat (pick it above).' : 'No messages yet for this task.');
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
    const node = chatNode(e);
    node.classList.add('enter');
    el.appendChild(node);
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
      th.innerHTML = `${typing}<span>${scope === 'general' ? 'assistant' : `supervisor of ${scope}`} is working…</span>`;
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
    sheet.dataset.sig = ''; // always rebuild on open
    renderModal();
    modal.classList.remove('hidden');
  }
  function closeModal() {
    openView = null;
    sheet.dataset.sig = '';
    modal.classList.add('hidden');
  }
  function renderModal() {
    if (!openView) return;
    if (openView.type === 'new') return renderNewTask();
    if (openView.type === 'task') return renderTaskDetail();
    if (openView.type === 'agent') return renderAgentDetail();
  }
  const shell = ({ head, tabs = '', body, foot, tag = 'div', attrs = '' }) => `<${tag} class="shell" ${attrs}>
    <div class="sheet-head">${head}<button type="button" class="x" data-close title="Close (Esc)">✕</button></div>
    ${tabs}<div class="sheet-body" id="sheet-body">${body}</div>
    <div class="sheet-foot">${foot}</div></${tag}>`;

  // Rebuild the dialog only when its content signature changed; keep the body scroll position.
  function paint(view, id, sig, html) {
    const same = sheet.dataset.view === view && sheet.dataset.id === id;
    if (same && sheet.dataset.sig === sig) return false;
    const top = $('#sheet-body')?.scrollTop ?? 0;
    sheet.dataset.view = view;
    sheet.dataset.id = id;
    sheet.dataset.sig = sig;
    sheet.innerHTML = html;
    if (same) $('#sheet-body').scrollTop = top;
    return true;
  }

  function renderNewTask() {
    if (sheet.dataset.view === 'new') return; // do not wipe the form on state refresh
    sheet.dataset.view = 'new';
    sheet.innerHTML = shell({
      tag: 'form',
      attrs: 'id="new-form"',
      head: `<div class="avatar lg" style="--h:250">✦</div><div><h3>New task</h3><div class="sub">A supervisor takes it from here. Nothing starts without an approved plan.</div></div>`,
      body: `<label>What should be done? *</label><textarea name="prompt" rows="5" required placeholder="Describe the task"></textarea>
        <label>Existing plan (optional): leave empty and the supervisor will draft one for your approval</label><textarea name="plan" rows="5" placeholder="1. …&#10;2. …"></textarea>
        <div class="two">
          <div><label>Open points (optional, non-blocking, may change during the work)</label><textarea name="openPoints" rows="2"></textarea></div>
          <div><label>Number of subagents (optional, empty = supervisor decides, up to ${S.config.maxAgentsPerTask || 5} at once)</label><input name="agents" type="number" min="1" max="${S.config.maxAgentsPerTask || 5}" placeholder="auto"></div>
        </div>`,
      foot: `<button type="button" class="ghost" data-close>Cancel</button><button class="primary" type="submit">Start task</button>`,
    });
    $('#new-form textarea').focus();
  }

  function renderTaskDetail() {
    const t = S.tasks.find((x) => x.id === openView.id);
    if (!t) return closeModal();
    const root = rootOf(t);
    const plan = root.plan;
    const agents = t.agentIds.map((id) => S.agents.find((a) => a.id === id)).filter(Boolean);
    const kids = S.tasks.filter((x) => x.parentId === t.id);
    const prog = taskProgress(t);
    const sig = JSON.stringify([t, plan, kids.map((k) => [k.id, k.status, k.title]), agents.map((a) => [a.id, a.status])]);
    const planState = plan ? (plan.approved ? 'approved' : '<span style="color:var(--warn)">waiting for your approval</span>') : 'none yet';
    paint(
      'task',
      t.id,
      sig,
      shell({
        head: `<div class="avatar lg" style="--h:${hue(t.id)};font-size:19px">${esc(t.id)}</div>
          <div class="grow" style="padding-right:28px"><h3>${esc(t.title)}</h3>
          <div class="sub">${badge(t.status)}<span class="chip">plan ${plan ? (plan.approved ? '✓' : '…') : '—'}</span>${agents.length ? `<span class="chip">${agents.length} agent${agents.length > 1 ? 's' : ''}</span>` : ''}${prog ? `<span class="chip">${prog.done}/${prog.total} subtasks</span>` : ''}<span>created ${ago(t.createdAt)} ago</span></div></div>`,
        body: `<h4>Request</h4><div class="block">${esc(t.prompt)}</div>
          <h4>Plan · ${planState}${t.parentId ? ` (from ${root.id})` : ''}</h4>
          ${plan ? `<div class="block">${esc(plan.text)}</div><h4>Open points · non-blocking</h4><div class="block">${esc(plan.openPoints || '(none)')}</div>` : '<div class="muted">The supervisor has not drafted a plan yet.</div>'}
          ${agents.length ? `<h4>Agents</h4><div class="wrap">${agents.map((a) => `<span class="agentchip" data-agent="${a.id}">${avatar(a, 'xs')}${esc(a.name)} ${badge(a.status)}</span>`).join('')}</div>` : ''}
          ${kids.length ? `<h4>Subtasks</h4>${kids.map((k) => `<div class="subrow"><span class="id">${k.id}</span><span class="grow title">${esc(k.title)}</span>${badge(k.status)}</div>`).join('')}` : ''}
          ${t.notes.length ? `<h4>Notes</h4><div class="block">${t.notes.map((n) => `${ago(n.ts)} ago · ${esc(n.text)}`).join('\n')}</div>` : ''}`,
        foot: `${!t.parentId && !['done', 'failed', 'cancelled'].includes(t.status) ? `<button class="danger" data-cancel="${t.id}">Cancel task</button>` : ''}
          <span class="spacer"></span>
          <button data-chat="${root.id}">Open ${root.id} chat</button>
          ${!t.parentId && plan && !plan.approved ? `<button class="primary" data-approve="${t.id}">Approve plan</button>` : ''}
          <button class="ghost" data-close>Close</button>`,
      })
    );
  }

  let agentTab = 'overview';
  const tlHtml = (e) => `<div class="tl ${e.kind}"><span class="t">${esc(e.kind === 'input' ? 'Briefing · ' + e.text.slice(0, 400) : e.text)}</span><time>${clock(e.ts)}</time></div>`;
  const liveMarker = '<div class="tl running" id="tl-live"><span class="t muted">working…</span></div>';

  function renderAgentDetail() {
    const a = S.agents.find((x) => x.id === openView.id);
    if (!a) return closeModal();
    const task = S.tasks.find((t) => t.id === a.taskId);
    const live = isLive(a);
    const done = a.todos.filter((t) => t.status === 'done').length;
    const pct = a.todos.length ? Math.round((done / a.todos.length) * 100) : 0;
    const sig = JSON.stringify([a.status, a.todos, a.report, a.endedAt, a.owns, a.objective, agentTab, task?.title]);
    const activityLine = `${live ? typing : ''}<span class="title">${esc(a.activity || '')}</span>`;

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
    const activity = `<div class="timeline" id="agent-log">${agentLog.map(tlHtml).join('')}${live ? liveMarker : ''}</div>`;

    const rebuilt = paint(
      'agent',
      a.id,
      sig,
      shell({
        head: `${avatar(a, 'lg')}
          <div class="grow" style="padding-right:28px">
            <div class="row" style="gap:10px"><h3>${esc(a.name)}</h3><span class="id">${a.id}</span>${badge(a.status)}</div>
            <div class="sub"><span class="chip" data-task="${a.taskId}" style="cursor:pointer">${esc(a.taskId)}${task ? ' · ' + esc(task.title.slice(0, 40)) : ''}</span><span>started ${ago(a.startedAt)} ago</span><span class="chip" id="agent-dur">${dur(a)}</span></div>
            <div class="activity" id="agent-activity">${activityLine}</div>
          </div>`,
        tabs: `<div class="sheet-tabs">
          <button class="tab ${agentTab === 'overview' ? 'on' : ''}" data-tab="overview">Overview</button>
          <button class="tab ${agentTab === 'activity' ? 'on' : ''}" data-tab="activity">Activity<span class="count" id="act-count">${agentLog.length}</span></button></div>`,
        body: agentTab === 'overview' ? overview : activity,
        foot: `${live ? `<button class="danger" data-stop="${a.id}">Stop agent</button>` : ''}<span class="spacer"></span><button class="ghost" data-close>Close</button>`,
      })
    );
    if (rebuilt && agentTab === 'activity') {
      const b = $('#sheet-body');
      b.scrollTop = b.scrollHeight;
    }
    if (!rebuilt) {
      // cheap in-place refresh of the live bits
      const act = $('#agent-activity');
      if (act) setHtml(act, activityLine);
      const d = $('#agent-dur');
      if (d) d.textContent = dur(a);
    }
  }

  async function openAgent(id) {
    agentLog = [];
    agentTab = 'overview';
    openModal({ type: 'agent', id });
    try {
      const { log } = await api('GET', `/agents/${id}/log`);
      if (openView?.type === 'agent' && openView.id === id) {
        agentLog = log;
        sheet.dataset.sig = '';
        renderAgentDetail();
      }
    } catch {}
  }

  // ---------- events ----------
  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t.closest('[data-close]') || t === modal) return closeModal();
    const tab = t.closest('[data-tab]');
    if (tab) {
      agentTab = tab.dataset.tab;
      sheet.dataset.sig = '';
      return renderAgentDetail();
    }
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
      box.style.height = 'auto';
      await api('POST', '/chat', { scope, text }).catch(() => (box.value = text));
    }
  });
  $('#msg').addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px';
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
        const cnt = $('#act-count');
        if (cnt) cnt.textContent = agentLog.length;
        const l = $('#agent-log');
        if (l) {
          const body = $('#sheet-body');
          const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
          const marker = $('#tl-live');
          if (marker) marker.insertAdjacentHTML('beforebegin', tlHtml(entry));
          else l.insertAdjacentHTML('beforeend', tlHtml(entry));
          if (stick) body.scrollTop = body.scrollHeight;
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
