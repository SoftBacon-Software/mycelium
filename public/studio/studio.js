// Mycelium Dashboard — v2 Interactive
// Security: All dynamic content is escaped via esc() which uses textContent round-trip.
(function () {
  var API_BASE = '/api/dioverse';
  var POLL_MS = 10000;
  var authToken = '';
  var currentUser = null;
  var pollTimer = null;

  // ---- DOM refs ----
  var loginScreen = document.getElementById('login-screen');
  var dashboard = document.getElementById('dashboard');
  var usernameInput = document.getElementById('login-username');
  var passwordInput = document.getElementById('login-password');
  var loginBtn = document.getElementById('login-btn');
  var loginError = document.getElementById('login-error');
  var logoutBtn = document.getElementById('logout-btn');
  var refreshBtn = document.getElementById('refresh-btn');
  var lastRefreshEl = document.getElementById('last-refresh');
  var overlay = document.getElementById('modal-overlay');
  var modalCreateTask = document.getElementById('modal-create-task');
  var modalSendMsg = document.getElementById('modal-send-msg');
  var modalTaskDetail = document.getElementById('modal-task-detail');
  var modalFileBug = document.getElementById('modal-file-bug');
  var modalBugDetail = document.getElementById('modal-bug-detail');
  var modalDictate = document.getElementById('modal-dictate');
  var modalCreatePlan = document.getElementById('modal-create-plan');
  var modalPlanDetail = document.getElementById('modal-plan-detail');
  var modalConceptDetail = document.getElementById('modal-concept-detail');

  // ---- Helpers ----
  function esc(s) {
    if (!s) return '';
    var d = document.createElement('span');
    d.textContent = String(s);
    return d.textContent;
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === 'className') node.className = attrs[k];
        else if (k === 'textContent') node.textContent = attrs[k];
        else if (k === 'onclick') node.addEventListener('click', attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      if (typeof children === 'string') node.textContent = children;
      else if (Array.isArray(children)) children.forEach(function (c) { if (c) node.appendChild(c); });
    }
    return node;
  }

  function clearAndAppend(container, nodes) {
    container.textContent = '';
    nodes.forEach(function (n) { container.appendChild(n); });
  }

  // ---- Tab switching ----
  document.addEventListener('click', function (e) {
    var tab = e.target.closest('.tab');
    if (!tab) return;
    var bar = tab.parentElement;
    var panel = bar.parentElement;
    bar.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');
    panel.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
    var target = document.getElementById(tab.dataset.tab);
    if (target) target.classList.add('active');
  });

  // ---- Collapsible Done column ----
  var doneHeader = document.getElementById('done-header');
  if (doneHeader) {
    doneHeader.addEventListener('click', function () {
      var content = document.getElementById('tasks-done');
      var collapsed = doneHeader.classList.toggle('collapsed');
      content.style.display = collapsed ? 'none' : '';
    });
  }

  // ---- API helpers ----
  function authHeaders() {
    if (authToken) return { 'Authorization': 'Bearer ' + authToken };
    return {};
  }
  function apiGet(path, cb) {
    fetch(API_BASE + path, { headers: authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { cb(null, d); })
      .catch(function (e) { cb(e); });
  }
  function apiPost(path, body, cb) {
    var h = authHeaders();
    h['Content-Type'] = 'application/json';
    fetch(API_BASE + path, {
      method: 'POST', headers: h,
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || r.status); });
      return r.json();
    }).then(function (d) { cb(null, d); }).catch(function (e) { cb(e); });
  }
  function apiPut(path, body, cb) {
    var h = authHeaders();
    h['Content-Type'] = 'application/json';
    fetch(API_BASE + path, {
      method: 'PUT', headers: h,
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || r.status); });
      return r.json();
    }).then(function (d) { cb(null, d); }).catch(function (e) { cb(e); });
  }

  function apiDelete(path, cb) {
    fetch(API_BASE + path, {
      method: 'DELETE', headers: authHeaders()
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || r.status); });
      return r.json();
    }).then(function (d) { cb(null, d); }).catch(function (e) { cb(e); });
  }

  // ---- Modal helpers ----
  function openModal(m) { overlay.style.display = ''; m.style.display = ''; }
  function closeAllModals() {
    overlay.style.display = 'none';
    modalCreateTask.style.display = 'none';
    modalSendMsg.style.display = 'none';
    modalTaskDetail.style.display = 'none';
    modalFileBug.style.display = 'none';
    modalBugDetail.style.display = 'none';
    modalDictate.style.display = 'none';
    if (modalCreatePlan) modalCreatePlan.style.display = 'none';
    if (modalPlanDetail) modalPlanDetail.style.display = 'none';
    // Stop dictation if recording
    if (dictRecognition && dictRecording) {
      dictRecognition.stop();
      dictRecording = false;
    }
  }
  overlay.addEventListener('click', function (e) { if (e.target === overlay) closeAllModals(); });
  document.querySelectorAll('.modal-close').forEach(function (b) { b.addEventListener('click', closeAllModals); });
  document.querySelectorAll('.btn-cancel').forEach(function (b) { b.addEventListener('click', closeAllModals); });

  // ---- Create Task ----
  document.getElementById('create-task-btn').addEventListener('click', function () {
    ['task-title', 'task-desc', 'task-assignee', 'task-tags'].forEach(function (id) {
      document.getElementById(id).value = '';
    });
    document.getElementById('task-priority').value = 'normal';
    document.getElementById('task-game').value = 'willing-sacrifice';
    document.getElementById('task-approval').checked = false;
    document.getElementById('task-form-error').textContent = '';
    openModal(modalCreateTask);
  });
  document.getElementById('task-submit').addEventListener('click', function () {
    var title = document.getElementById('task-title').value.trim();
    var desc = document.getElementById('task-desc').value.trim();
    var game = document.getElementById('task-game').value;
    var priority = document.getElementById('task-priority').value;
    var assignee = document.getElementById('task-assignee').value.trim();
    var tagsStr = document.getElementById('task-tags').value.trim();
    var needsApproval = document.getElementById('task-approval').checked;
    var errorEl = document.getElementById('task-form-error');
    if (!title) { errorEl.textContent = 'Title is required'; return; }
    var tags = tagsStr ? tagsStr.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : [];
    var body = { title: title, game: game, priority: priority, needs_approval: needsApproval ? 1 : 0 };
    if (desc) body.description = desc;
    if (assignee) body.assignee = assignee;
    if (tags.length) body.tags = tags;
    errorEl.textContent = 'Creating...';
    apiPost('/tasks', body, function (err) {
      if (err) { errorEl.textContent = 'Error: ' + err.message; return; }
      closeAllModals(); fetchOverview();
    });
  });

  // ---- Send Message / Request ----
  document.getElementById('send-msg-btn').addEventListener('click', function () {
    document.getElementById('msg-from').value = 'admin';
    document.getElementById('msg-to').value = '';
    document.getElementById('msg-content').value = '';
    document.getElementById('msg-type').value = 'message';
    document.getElementById('msg-game').value = 'willing-sacrifice';
    document.getElementById('msg-auto-task').checked = false;
    document.getElementById('request-options').style.display = 'none';
    document.getElementById('msg-form-error').textContent = '';
    openModal(modalSendMsg);
  });
  document.getElementById('msg-type').addEventListener('change', function () {
    document.getElementById('request-options').style.display = this.value === 'request' ? '' : 'none';
  });
  document.getElementById('msg-submit').addEventListener('click', function () {
    var type = document.getElementById('msg-type').value;
    var from = document.getElementById('msg-from').value.trim();
    var to = document.getElementById('msg-to').value.trim();
    var content = document.getElementById('msg-content').value.trim();
    var game = document.getElementById('msg-game').value;
    var autoTask = document.getElementById('msg-auto-task').checked;
    var errorEl = document.getElementById('msg-form-error');
    if (!from) { errorEl.textContent = 'From is required'; return; }
    if (!content) { errorEl.textContent = 'Content is required'; return; }
    errorEl.textContent = 'Sending...';
    if (type === 'request') {
      if (!to) { errorEl.textContent = 'To is required for requests'; return; }
      var reqBody = { from_agent: from, to_agent: to, content: content, game: game };
      if (autoTask) reqBody.auto_task = true;
      apiPost('/requests', reqBody, function (err) {
        if (err) { errorEl.textContent = 'Error: ' + err.message; return; }
        closeAllModals(); fetchOverview();
      });
    } else {
      var msgBody = { from_agent: from, content: content, game: game };
      if (to) msgBody.to_agent = to;
      apiPost('/messages', msgBody, function (err) {
        if (err) { errorEl.textContent = 'Error: ' + err.message; return; }
        closeAllModals(); fetchOverview();
      });
    }
  });

  // ---- Team Chat Tab Switching ----
  document.querySelectorAll('.msg-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.msg-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var target = tab.getAttribute('data-msg-tab');
      document.getElementById('team-chat-container').style.display = target === 'chat' ? '' : 'none';
      document.getElementById('agent-msgs-container').style.display = target === 'agents' ? '' : 'none';
    });
  });

  // ---- Team Chat Send ----
  function sendChatMessage() {
    var input = document.getElementById('chat-input');
    var content = input.value.trim();
    if (!content) return;
    input.value = '';
    apiPost('/team-chat', { content: content }, function (err) {
      if (err) { input.value = content; return; }
      fetchOverview();
    });
  }
  document.getElementById('chat-send').addEventListener('click', sendChatMessage);
  document.getElementById('chat-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });

  // ---- Create Plan ----
  var createPlanBtn = document.getElementById('create-plan-btn');
  if (createPlanBtn) {
    createPlanBtn.addEventListener('click', function () {
      document.getElementById('plan-title').value = '';
      document.getElementById('plan-desc').value = '';
      document.getElementById('plan-game').value = 'dioverse';
      document.getElementById('plan-priority').value = 'normal';
      document.getElementById('plan-owner').value = '';
      document.getElementById('plan-form-error').textContent = '';
      openModal(modalCreatePlan);
    });
  }
  var planSubmit = document.getElementById('plan-submit');
  if (planSubmit) {
    planSubmit.addEventListener('click', function () {
      var title = document.getElementById('plan-title').value.trim();
      var desc = document.getElementById('plan-desc').value.trim();
      var game = document.getElementById('plan-game').value;
      var priority = document.getElementById('plan-priority').value;
      var owner = document.getElementById('plan-owner').value.trim();
      var errorEl = document.getElementById('plan-form-error');
      if (!title) { errorEl.textContent = 'Title is required'; return; }
      var body = { title: title, game: game, priority: priority };
      if (desc) body.description = desc;
      if (owner) body.owner = owner;
      errorEl.textContent = 'Creating...';
      apiPost('/plans', body, function (err) {
        if (err) { errorEl.textContent = 'Error: ' + err.message; return; }
        closeAllModals(); fetchOverview();
      });
    });
  }

  // ---- File Bug ----
  document.getElementById('file-bug-btn').addEventListener('click', function () {
    document.getElementById('bug-title').value = '';
    document.getElementById('bug-desc').value = '';
    document.getElementById('bug-game').value = 'dioverse';
    document.getElementById('bug-severity').value = 'normal';
    document.getElementById('bug-category').value = 'other';
    document.getElementById('bug-assignee').value = '';
    document.getElementById('bug-form-error').textContent = '';
    openModal(modalFileBug);
  });
  document.getElementById('bug-submit').addEventListener('click', function () {
    var title = document.getElementById('bug-title').value.trim();
    var desc = document.getElementById('bug-desc').value.trim();
    var game = document.getElementById('bug-game').value;
    var severity = document.getElementById('bug-severity').value;
    var category = document.getElementById('bug-category').value;
    var assignee = document.getElementById('bug-assignee').value.trim();
    var errorEl = document.getElementById('bug-form-error');
    if (!title) { errorEl.textContent = 'Title is required'; return; }
    if (!desc) { errorEl.textContent = 'Description is required'; return; }
    var body = { title: title, description: desc, game: game, severity: severity, category: category };
    if (assignee) body.assignee = assignee;
    errorEl.textContent = 'Filing...';
    apiPost('/bugs', body, function (err) {
      if (err) { errorEl.textContent = 'Error: ' + err.message; return; }
      closeAllModals(); fetchOverview();
    });
  });

  // ---- Auth ----
  function tryLogin() {
    var username = usernameInput.value.trim();
    var password = passwordInput.value;
    if (!username || !password) { loginError.textContent = 'Enter username and password'; return; }
    loginError.textContent = 'Logging in...';
    fetch(API_BASE + '/studio/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || r.status); });
      return r.json();
    }).then(function (data) {
      authToken = data.token;
      currentUser = data.user;
      sessionStorage.setItem('dv_token', authToken);
      sessionStorage.setItem('dv_user', JSON.stringify(currentUser));
      loginScreen.style.display = 'none'; dashboard.style.display = '';
      updateUserDisplay();
      fetchOverview();
      startPolling();
      requestNotificationPermission();
      // Mycelium intro sound
      try { var _a = new Audio('studio_intro.mp3'); _a.volume = 0.5; _a.play().catch(function(){}); } catch(e) {}
    }).catch(function (e) {
      loginError.textContent = e.message || 'Login failed';
      authToken = '';
      currentUser = null;
    });
  }
  function updateUserDisplay() {
    var nameEl = document.getElementById('user-display-name');
    if (nameEl && currentUser) nameEl.textContent = currentUser.display_name;
  }
  loginBtn.addEventListener('click', tryLogin);
  usernameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') passwordInput.focus(); });
  passwordInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryLogin(); });
  logoutBtn.addEventListener('click', function () {
    sessionStorage.removeItem('dv_token');
    sessionStorage.removeItem('dv_user');
    authToken = ''; currentUser = null;
    if (pollTimer) clearInterval(pollTimer);
    dashboard.style.display = 'none'; loginScreen.style.display = '';
    usernameInput.value = ''; passwordInput.value = ''; loginError.textContent = '';
  });
  refreshBtn.addEventListener('click', function () { fetchOverview(); });

  // Auto-login from saved token
  var savedToken = sessionStorage.getItem('dv_token');
  var savedUser = sessionStorage.getItem('dv_user');
  if (savedToken && savedUser) {
    authToken = savedToken;
    try { currentUser = JSON.parse(savedUser); } catch (e) { currentUser = null; }
    fetchOverview(function (err) {
      if (!err) {
        loginScreen.style.display = 'none'; dashboard.style.display = '';
        updateUserDisplay();
        startPolling();
        // No intro sound on session restore — only on fresh login
      } else {
        authToken = ''; currentUser = null;
        sessionStorage.removeItem('dv_token');
        sessionStorage.removeItem('dv_user');
      }
    });
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () { fetchOverview(); }, POLL_MS);
  }

  function fetchOverview(cb) {
    apiGet('/admin/overview', function (err, data) {
      if (err) { if (cb) cb(err); return; }
      render(data);
      if (cb) cb(null);
    });
  }

  // ---- Time helpers ----
  // Normalize "2026-03-01 03:06:44" → "2026-03-01T03:06:44" for Date parsing
  function normalizeTs(ts) { return ts ? ts.replace(' ', 'T') : ts; }

  function timeAgo(iso) {
    if (!iso) return 'never';
    var diff = Date.now() - new Date(normalizeTs(iso) + 'Z').getTime();
    if (diff < 60000) return Math.round(diff / 1000) + 's';
    if (diff < 3600000) return Math.round(diff / 60000) + 'm';
    if (diff < 86400000) return Math.round(diff / 3600000) + 'h';
    return Math.round(diff / 86400000) + 'd';
  }
  function shortTime(iso) {
    if (!iso) return '';
    return new Date(normalizeTs(iso) + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ---- Browser Notifications ----
  var prevApprovalCount = -1;
  var prevRequestCount = -1;
  var prevBugCount = -1;

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  function showNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        var n = new Notification(title, {
          body: body,
          icon: 'favicon.svg',
          tag: title,
          silent: false
        });
        setTimeout(function () { n.close(); }, 8000);
      } catch (e) { /* ignore */ }
    }
  }

  function checkNotifications(data) {
    var taskApprovals = (data.approval_queue || []).length;
    var gateApprovals = (data.pending_approvals || []).length;
    var approvals = taskApprovals + gateApprovals;
    var requests = (data.pending_requests || []).length;
    var bugs = data.bug_counts ? (data.bug_counts.open || 0) : 0;

    if (prevApprovalCount >= 0 && approvals > prevApprovalCount) {
      showNotification('Approval Required', (approvals - prevApprovalCount) + ' action(s) need your approval');
    }
    if (prevRequestCount >= 0 && requests > prevRequestCount) {
      showNotification('New Request', (requests - prevRequestCount) + ' new blocking request(s)');
    }
    if (prevBugCount >= 0 && bugs > prevBugCount) {
      showNotification('New Bug Filed', (bugs - prevBugCount) + ' new bug(s) reported');
    }

    prevApprovalCount = approvals;
    prevRequestCount = requests;
    prevBugCount = bugs;
  }

  // ---- Render ----
  function render(data) {
    lastRefreshEl.textContent = new Date().toLocaleTimeString();
    checkNotifications(data);
    renderAgents(data.agents);
    renderEvents(data.events);
    renderTasks(data.tasks);
    renderMessages(data.messages);
    renderTeamChat(data.team_chat);
    renderContext(data.context);
    renderGames(data.games);
    renderApprovals(data.pending_approvals, data.approval_queue);
    renderPendingRequests(data.pending_requests);
    renderContextKeys(data.context_keys);
    renderAssets(data.assets);
    renderBugs(data.bugs, data.bug_counts);
    renderPlans(data.plans);
    renderConcepts(data.concepts);
  }

  function agentAvatarClass(id) {
    if (id.indexOf('greatness') >= 0) return 'avatar-greatness';
    if (id.indexOf('hijack') >= 0) return 'avatar-hijack';
    if (id.indexOf('gpu') >= 0 || id.indexOf('drone') >= 0) return 'avatar-admin';
    return 'avatar-user-default';
  }

  function agentInitials(name) {
    var parts = name.split(/[\s-]+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function renderAgents(agents) {
    var c = document.getElementById('agents-list');
    if (!agents || !agents.length) { c.textContent = 'No agents'; return; }
    clearAndAppend(c, agents.map(function (a) {
      var isOnline = a.status === 'online';
      var card = el('div', { className: 'agent-card ' + (isOnline ? 'agent-online' : 'agent-offline') });

      // Avatar
      var avatar = el('div', { className: 'agent-avatar ' + agentAvatarClass(a.id), textContent: agentInitials(a.name) });
      card.appendChild(avatar);

      // Info column
      var info = el('div', { className: 'agent-info' });

      // Header row: name + status dot
      var header = el('div', { className: 'agent-header' });
      header.appendChild(el('span', { className: 'agent-name', textContent: a.name }));
      header.appendChild(el('span', { className: 'agent-dot ' + (isOnline ? 'online' : 'offline') }));
      info.appendChild(header);

      // Project identifier
      var project = a.game || a.project || '';
      info.appendChild(el('div', { className: 'agent-project', textContent: a.id + (project ? ' \u00B7 ' + project : '') }));

      // Working on
      if (a.working_on) info.appendChild(el('div', { className: 'agent-working', textContent: a.working_on }));

      // Footer: heartbeat + capability badges
      var footer = el('div', { className: 'agent-footer' });
      footer.appendChild(el('span', { className: 'agent-heartbeat', textContent: timeAgo(a.last_heartbeat) }));

      var caps = [];
      try { caps = JSON.parse(a.capabilities || '[]'); } catch (e) {}
      if (caps.length) {
        var capsEl = el('div', { className: 'agent-caps' });
        caps.forEach(function (cap) {
          capsEl.appendChild(el('span', { className: 'agent-cap', textContent: cap }));
        });
        footer.appendChild(capsEl);
      }
      info.appendChild(footer);

      card.appendChild(info);
      return card;
    }));
  }

  function renderEvents(events) {
    var c = document.getElementById('events-list');
    if (!events || !events.length) { c.textContent = 'No events'; return; }
    clearAndAppend(c, events.slice(0, 20).map(function (e) {
      var item = el('div', { className: 'event-item' });
      item.appendChild(el('span', { className: 'event-time', textContent: shortTime(e.created_at) }));
      item.appendChild(el('span', { className: 'event-type ' + e.type, textContent: e.type.replace(/_/g, ' ') }));
      item.appendChild(el('span', { textContent: ' ' + e.summary }));
      return item;
    }));
  }

  function renderTasks(tasks) {
    var open = tasks.open || [];
    var prog = tasks.in_progress || [];
    var rev = tasks.review || [];
    var done = tasks.done || [];
    document.getElementById('count-open').textContent = open.length || '';
    document.getElementById('count-progress').textContent = prog.length || '';
    document.getElementById('count-review').textContent = rev.length || '';
    document.getElementById('count-done').textContent = done.length || '';
    renderTaskCol('tasks-open', open);
    renderTaskCol('tasks-progress', prog);
    renderTaskCol('tasks-review', rev);
    renderTaskCol('tasks-done', done);
  }

  function renderTaskCol(id, items) {
    var c = document.getElementById(id);
    if (!items || !items.length) { c.textContent = ''; return; }
    clearAndAppend(c, items.map(function (t) {
      var blocked = []; try { blocked = JSON.parse(t.blocked_by || '[]'); } catch (e) {}
      var dotCls = 'tile-dot dot-task';
      if (t.priority === 'urgent') dotCls += ' dot-task-urgent';
      else if (t.priority === 'high') dotCls += ' dot-task-high';
      else if (blocked.length) dotCls += ' dot-task-blocked';
      var tileCls = 'queue-tile tile-task';
      if (blocked.length) tileCls += ' tile-task-blocked';
      var tile = el('div', { className: tileCls, onclick: function () { showTaskDetail(t); } });
      tile.appendChild(el('div', { className: 'tile-row' }, [
        el('span', { className: dotCls }),
        el('span', { className: 'tile-label', textContent: '#' + t.id + ' ' + t.title })
      ]));
      var detail = el('div', { className: 'tile-detail' });
      var badges = el('div', { className: 'tile-badges' });
      if (t.needs_approval && !t.approved_by) badges.appendChild(el('span', { className: 'tile-badge tile-badge-approval', textContent: 'approval' }));
      if (t.needs_approval && t.approved_by) badges.appendChild(el('span', { className: 'tile-badge tile-badge-approved', textContent: 'approved' }));
      if (blocked.length) badges.appendChild(el('span', { className: 'tile-badge tile-badge-blocked', textContent: 'blocked' }));
      if (t.priority === 'high' || t.priority === 'urgent') badges.appendChild(el('span', { className: 'tile-badge tile-badge-' + t.priority, textContent: t.priority }));
      if (badges.children.length) detail.appendChild(badges);
      detail.appendChild(el('div', { className: 'tile-meta', textContent: t.game + ' \u00B7 ' + (t.assignee || 'unassigned') }));
      tile.appendChild(detail);
      return tile;
    }));
  }

  function showTaskDetail(t) {
    document.getElementById('detail-title').textContent = '#' + t.id + ': ' + esc(t.title);
    var body = document.getElementById('detail-body');
    body.textContent = '';
    if (t.description) {
      body.appendChild(el('div', { className: 'detail-section' }, [
        el('label', {}, 'Description'), el('p', { textContent: t.description })
      ]));
    }
    var meta = el('div', { className: 'detail-meta' });
    [['Project', t.game], ['Status', t.status], ['Priority', t.priority || 'normal'], ['Assignee', t.assignee || 'unassigned'], ['Created', t.created_at || '']].forEach(function (pair) {
      meta.appendChild(el('div', {}, [el('span', { className: 'detail-label', textContent: pair[0] + ': ' }), el('span', { textContent: pair[1] })]));
    });
    body.appendChild(meta);
    var blocked = []; try { blocked = JSON.parse(t.blocked_by || '[]'); } catch (e) {}
    var blocks = []; try { blocks = JSON.parse(t.blocks || '[]'); } catch (e) {}
    if (blocked.length || blocks.length) {
      var dep = el('div', { className: 'detail-section' });
      dep.appendChild(el('label', {}, 'Dependencies'));
      if (blocked.length) dep.appendChild(el('div', { textContent: 'Blocked by: #' + blocked.join(', #') }));
      if (blocks.length) dep.appendChild(el('div', { textContent: 'Blocks: #' + blocks.join(', #') }));
      body.appendChild(dep);
    }
    if (t.needs_approval) {
      var appr = el('div', { className: 'detail-section' });
      appr.appendChild(el('label', {}, 'Approval'));
      if (t.approved_by) {
        appr.appendChild(el('div', { className: 'approval-approved', textContent: 'Approved by ' + t.approved_by }));
      } else {
        appr.appendChild(el('div', { className: 'approval-pending', textContent: 'Awaiting approval' }));
        appr.appendChild(el('button', { className: 'btn-approve', textContent: 'Approve', onclick: function () { approveTask(t.id); } }));
      }
      body.appendChild(appr);
    }
    var actions = el('div', { className: 'detail-actions' });
    ['open', 'in_progress', 'review', 'done'].forEach(function (s) {
      actions.appendChild(el('button', {
        className: 'btn-status' + (s === t.status ? ' active' : ''), textContent: s,
        onclick: function () {
          apiPut('/tasks/' + t.id, { status: s }, function (err) {
            if (err) { alert('Error: ' + err.message); return; }
            closeAllModals(); fetchOverview();
          });
        }
      }));
    });
    body.appendChild(actions);

    // Comments section
    var commentsSection = el('div', { className: 'detail-section comments-section' });
    commentsSection.style.marginTop = '0.8rem';
    commentsSection.appendChild(el('label', {}, 'Comments'));
    var commentsList = el('div', { className: 'comments-list' });
    commentsList.textContent = 'Loading...';
    commentsSection.appendChild(commentsList);

    // Comment input
    var commentInput = document.createElement('div');
    commentInput.className = 'comment-input-bar';
    var commentTextarea = document.createElement('input');
    commentTextarea.type = 'text';
    commentTextarea.placeholder = 'Add a comment...';
    commentTextarea.className = 'comment-input';
    var commentBtn = el('button', { className: 'btn-primary comment-send', textContent: 'Post' });
    commentInput.appendChild(commentTextarea);
    commentInput.appendChild(commentBtn);
    commentsSection.appendChild(commentInput);
    body.appendChild(commentsSection);

    // Load comments
    function loadComments() {
      apiGet('/tasks/' + t.id + '/comments', function (err, comments) {
        commentsList.textContent = '';
        if (err || !comments || !comments.length) {
          commentsList.appendChild(el('div', { className: 'comment-empty', textContent: 'No comments yet' }));
          return;
        }
        comments.forEach(function (c) {
          var item = el('div', { className: 'comment-item' });
          var header = el('div', { className: 'comment-header' });
          header.appendChild(el('span', { className: 'comment-author', textContent: c.author }));
          header.appendChild(el('span', { className: 'comment-time', textContent: timeAgo(c.created_at) }));
          item.appendChild(header);
          item.appendChild(el('div', { className: 'comment-text', textContent: c.content }));
          commentsList.appendChild(item);
        });
      });
    }
    loadComments();

    // Post comment
    function postComment() {
      var text = commentTextarea.value.trim();
      if (!text) return;
      var author = currentUser ? currentUser.display_name : 'admin';
      commentTextarea.value = '';
      apiPost('/tasks/' + t.id + '/comments', { author: author, content: text }, function (err) {
        if (err) { commentTextarea.value = text; return; }
        loadComments();
      });
    }
    commentBtn.addEventListener('click', postComment);
    commentTextarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postComment(); }
    });

    openModal(modalTaskDetail);
  }

  function approveTask(id) {
    apiPut('/tasks/' + id + '/approve', {}, function (err) {
      if (err) { alert('Error: ' + err.message); return; }
      closeAllModals(); fetchOverview();
    });
  }

  function renderApprovals(gateApprovals, taskApprovals) {
    var c = document.getElementById('approval-list');
    var countEl = document.getElementById('approval-count');
    var gates = gateApprovals || [];
    var tasks = taskApprovals || [];
    var total = gates.length + tasks.length;
    if (countEl) countEl.textContent = total || '';
    if (!total) { c.textContent = ''; c.appendChild(el('div', { className: 'queue-empty', textContent: 'Clear' })); return; }

    var tiles = [];

    // Gate approvals first (high-risk agent actions)
    gates.forEach(function (a) {
      var tile = el('div', { className: 'queue-tile tile-approval tile-gate', onclick: function () { showApprovalDetail(a); } });
      var row = el('div', { className: 'tile-row' });
      row.appendChild(el('span', { className: 'tile-dot dot-approval' }));
      row.appendChild(el('span', { className: 'approval-action-badge approval-action-' + a.action_type, textContent: a.action_type.replace('_', ' ') }));
      row.appendChild(el('span', { className: 'tile-label', textContent: a.title }));
      tile.appendChild(row);
      var detail = el('div', { className: 'tile-detail' });
      detail.appendChild(el('div', { className: 'tile-meta', textContent: a.requested_by + ' \u00B7 ' + a.project + ' \u00B7 ' + timeAgo(a.created_at) }));
      var actions = el('div', { style: 'display:flex;gap:0.3rem;margin-top:0.2rem;' });
      actions.appendChild(el('button', { className: 'tile-action tile-action-approve', textContent: 'Approve', onclick: function (e) {
        e.stopPropagation();
        apiPut('/approvals/' + a.id, { status: 'approved' }, function (err) {
          if (err) { alert('Error: ' + err.message); return; }
          fetchOverview();
        });
      }}));
      actions.appendChild(el('button', { className: 'tile-action tile-action-deny', textContent: 'Deny', onclick: function (e) {
        e.stopPropagation();
        var reason = prompt('Reason for denial (optional):');
        if (reason === null) return;
        apiPut('/approvals/' + a.id, { status: 'denied', reason: reason }, function (err) {
          if (err) { alert('Error: ' + err.message); return; }
          fetchOverview();
        });
      }}));
      detail.appendChild(actions);
      tile.appendChild(detail);
      tiles.push(tile);
    });

    // Legacy task approvals
    tasks.forEach(function (t) {
      var tile = el('div', { className: 'queue-tile tile-approval', onclick: function () { showTaskDetail(t); } });
      tile.appendChild(el('div', { className: 'tile-row' }, [
        el('span', { className: 'tile-dot dot-approval' }),
        el('span', { className: 'tile-label', textContent: '#' + t.id + ' ' + t.title })
      ]));
      var detail = el('div', { className: 'tile-detail' });
      detail.appendChild(el('div', { className: 'tile-meta', textContent: t.game + ' \u00B7 ' + (t.assignee || '?') }));
      detail.appendChild(el('button', { className: 'tile-action tile-action-approve', textContent: 'Approve', onclick: function (e) { e.stopPropagation(); approveTask(t.id); } }));
      tile.appendChild(detail);
      tiles.push(tile);
    });

    clearAndAppend(c, tiles);
  }

  function showApprovalDetail(a) {
    var titleEl = document.getElementById('detail-title');
    var body = document.getElementById('detail-body');
    titleEl.textContent = 'Approval #' + a.id;
    body.textContent = '';

    // Action type + title
    var header = el('div', { style: 'display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;' });
    header.appendChild(el('span', { className: 'approval-action-badge approval-action-' + a.action_type, textContent: a.action_type.replace('_', ' ') }));
    header.appendChild(el('span', { style: 'font-size:0.9rem;font-weight:700;color:var(--text);', textContent: a.title }));
    body.appendChild(header);

    // Meta grid
    var meta = el('div', { className: 'detail-meta' });
    [['Requested By', a.requested_by], ['Project', a.project], ['Status', a.status],
     ['Created', a.created_at || '']].forEach(function (pair) {
      meta.appendChild(el('div', {}, [el('span', { className: 'detail-label', textContent: pair[0] + ': ' }), el('span', { textContent: pair[1] })]));
    });
    if (a.decided_by) {
      meta.appendChild(el('div', {}, [el('span', { className: 'detail-label', textContent: 'Decided By: ' }), el('span', { textContent: a.decided_by })]));
      meta.appendChild(el('div', {}, [el('span', { className: 'detail-label', textContent: 'Decided At: ' }), el('span', { textContent: a.decided_at || '' })]));
    }
    if (a.reason) {
      meta.appendChild(el('div', {}, [el('span', { className: 'detail-label', textContent: 'Reason: ' }), el('span', { textContent: a.reason })]));
    }
    body.appendChild(meta);

    // Payload
    var payloadData = typeof a.payload === 'string' ? a.payload : JSON.stringify(a.payload, null, 2);
    var payloadSection = el('div', { className: 'detail-section' });
    payloadSection.appendChild(el('label', { style: 'font-weight:600;color:var(--accent);margin-bottom:0.3rem;display:block;font-size:0.75rem;' }, 'Action Payload'));
    payloadSection.appendChild(el('pre', { className: 'concept-detail-data', textContent: payloadData }));
    body.appendChild(payloadSection);

    // Approve / Deny buttons (if pending)
    if (a.status === 'pending') {
      var actions = el('div', { className: 'detail-actions', style: 'margin-top:0.5rem;' });
      actions.appendChild(el('button', { className: 'btn-status active', style: 'background:var(--green);color:#000;', textContent: 'Approve', onclick: function () {
        apiPut('/approvals/' + a.id, { status: 'approved' }, function (err) {
          if (err) { alert('Error: ' + err.message); return; }
          closeAllModals(); fetchOverview();
        });
      }}));
      actions.appendChild(el('button', { className: 'btn-status', style: 'background:var(--red);color:#fff;margin-left:0.3rem;', textContent: 'Deny', onclick: function () {
        var reason = prompt('Reason for denial (optional):');
        if (reason === null) return;
        apiPut('/approvals/' + a.id, { status: 'denied', reason: reason }, function (err) {
          if (err) { alert('Error: ' + err.message); return; }
          closeAllModals(); fetchOverview();
        });
      }}));
      body.appendChild(actions);
    }

    openModal(modalTaskDetail);
  }

  function renderPendingRequests(reqs) {
    var c = document.getElementById('requests-list');
    var countEl = document.getElementById('request-count');
    if (countEl) countEl.textContent = (reqs && reqs.length) ? reqs.length : '';
    if (!reqs || !reqs.length) { c.textContent = ''; c.appendChild(el('div', { className: 'queue-empty', textContent: 'Clear' })); return; }
    clearAndAppend(c, reqs.map(function (r) {
      var tile = el('div', { className: 'queue-tile tile-request' });
      tile.appendChild(el('div', { className: 'tile-row' }, [
        el('span', { className: 'tile-dot dot-request' }),
        el('span', { className: 'tile-label', textContent: r.from_agent + ' \u2192 ' + (r.to_agent || 'all') })
      ]));
      var detail = el('div', { className: 'tile-detail' });
      detail.appendChild(el('div', { className: 'tile-preview', textContent: r.content.substring(0, 80) + (r.content.length > 80 ? '...' : '') }));
      tile.appendChild(detail);
      return tile;
    }));
  }

  // Bug #8 fix: track which messages are expanded across re-renders
  var expandedMsgIds = {};

  function renderMessages(msgs) {
    var c = document.getElementById('messages-list');
    var countEl = document.getElementById('msg-count');
    if (countEl) countEl.textContent = (msgs && msgs.length) ? msgs.length : '';
    if (!msgs || !msgs.length) { c.textContent = 'No messages'; return; }

    // Bug #5: Sort oldest-first (chat order), group consecutive same-sender
    var sorted = msgs.slice().sort(function (a, b) {
      return new Date(normalizeTs(a.created_at)) - new Date(normalizeTs(b.created_at));
    });

    var nodes = [];
    var lastSender = null;
    var lastDate = null;

    sorted.forEach(function (m) {
      // Date separator — handle both "2026-03-01 03:06:44" and "2026-03-01T03:06:44"
      var msgDate = m.created_at ? m.created_at.split(/[T ]/)[0] : '';
      if (msgDate && msgDate !== lastDate) {
        lastDate = msgDate;
        var dateLabel = new Date(msgDate + 'T00:00:00Z').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        var sep = el('div', { className: 'msg-date-sep' });
        sep.appendChild(el('span', { className: 'msg-date-line' }));
        sep.appendChild(el('span', { className: 'msg-date-label', textContent: dateLabel }));
        sep.appendChild(el('span', { className: 'msg-date-line' }));
        nodes.push(sep);
        lastSender = null;
      }

      var sameSender = m.from_agent === lastSender;
      var item = el('div', { className: 'msg-chat' + (sameSender ? ' msg-grouped' : '') });

      if (!sameSender) {
        // Full header row with avatar
        var topRow = el('div', { className: 'msg-top' });
        var avatarCls = 'msg-avatar';
        var initial = '';
        if (m.from_agent && m.from_agent.indexOf('hijack') !== -1) { avatarCls += ' avatar-hijack'; initial = 'H'; }
        else if (m.from_agent && m.from_agent.indexOf('greatness') !== -1) { avatarCls += ' avatar-greatness'; initial = 'G'; }
        else { avatarCls += ' avatar-admin'; initial = 'D'; }
        topRow.appendChild(el('span', { className: avatarCls, textContent: initial }));
        topRow.appendChild(el('span', { className: 'msg-sender', textContent: m.from_agent || 'system' }));
        if (m.to_agent) topRow.appendChild(el('span', { className: 'msg-target', textContent: '\u2192 ' + m.to_agent }));
        if (m.msg_type && m.msg_type !== 'message') topRow.appendChild(el('span', { className: 'badge badge-msg-type', textContent: m.msg_type }));
        if (m.msg_type === 'request') topRow.appendChild(el('span', { className: 'badge badge-' + (m.status || 'sent'), textContent: m.status || 'sent' }));
        topRow.appendChild(el('span', { className: 'msg-ts', textContent: shortTime(m.created_at) }));
        item.appendChild(topRow);
      }

      // Content — expandable, preserves state across refreshes (Bug #8)
      var isLong = m.content.length > 140;
      var isExpanded = expandedMsgIds[m.id] || false;
      var preview = isLong ? m.content.substring(0, 140) + '...' : m.content;
      var body = el('div', { className: 'msg-body' + (sameSender ? ' msg-body-grouped' : '') });

      // Inline timestamp for grouped messages
      if (sameSender) {
        body.appendChild(el('span', { className: 'msg-ts-inline', textContent: shortTime(m.created_at) }));
      }

      var textNode = el('div', { className: 'msg-text', textContent: isExpanded ? m.content : preview });
      body.appendChild(textNode);
      if (isLong) {
        var toggle = el('span', { className: 'msg-expand', textContent: isExpanded ? 'show less' : 'show more' });
        toggle.addEventListener('click', (function (msgId) {
          return function () {
            expandedMsgIds[msgId] = !expandedMsgIds[msgId];
            textNode.textContent = expandedMsgIds[msgId] ? m.content : preview;
            toggle.textContent = expandedMsgIds[msgId] ? 'show less' : 'show more';
          };
        })(m.id));
        body.appendChild(toggle);
      }
      item.appendChild(body);
      nodes.push(item);
      lastSender = m.from_agent;
    });

    // Only auto-scroll if user was already near the bottom
    var wasAtBottom = (c.scrollHeight - c.scrollTop - c.clientHeight) < 80;
    clearAndAppend(c, nodes);
    if (wasAtBottom) {
      c.scrollTop = c.scrollHeight;
    }
  }

  // ---- Team Chat Rendering ----
  var expandedChatIds = {};

  function getUserAvatar(sender) {
    // sender format: __user:DisplayName
    var name = sender.replace('__user:', '');
    var lower = name.toLowerCase();
    var initial = name.charAt(0).toUpperCase();
    if (lower.indexOf('greatness') !== -1 || lower === 'greatness') return { cls: 'avatar-user-g', initial: 'G', name: name };
    if (lower.indexOf('hijack') !== -1) return { cls: 'avatar-user-h', initial: 'H', name: name };
    if (lower.indexOf('stoupe') !== -1) return { cls: 'avatar-user-s', initial: 'S', name: name };
    return { cls: 'avatar-user-default', initial: initial, name: name };
  }

  function renderTeamChat(msgs) {
    var c = document.getElementById('team-chat-list');
    if (!c) return;
    if (!msgs || !msgs.length) { c.textContent = 'No messages yet. Say something!'; return; }

    var sorted = msgs.slice().sort(function (a, b) {
      return new Date(normalizeTs(a.created_at)) - new Date(normalizeTs(b.created_at));
    });

    var nodes = [];
    var lastSender = null;
    var lastDate = null;

    sorted.forEach(function (m) {
      // Parse date — handle both "2026-03-01 03:06:44" and "2026-03-01T03:06:44" formats
      var msgDate = m.created_at ? m.created_at.split(/[T ]/)[0] : '';

      var sameSender = m.from_agent === lastSender;
      var item = el('div', { className: 'msg-chat' + (sameSender ? ' msg-grouped' : '') });

      if (!sameSender) {
        var user = getUserAvatar(m.from_agent || 'unknown');
        var topRow = el('div', { className: 'msg-top' });
        topRow.appendChild(el('span', { className: 'msg-avatar ' + user.cls, textContent: user.initial }));
        topRow.appendChild(el('span', { className: 'msg-sender', textContent: user.name }));
        topRow.appendChild(el('span', { className: 'msg-ts', textContent: shortTime(m.created_at) }));
        item.appendChild(topRow);
      }

      var isLong = m.content.length > 140;
      var isExpanded = expandedChatIds[m.id] || false;
      var preview = isLong ? m.content.substring(0, 140) + '...' : m.content;
      var body = el('div', { className: 'msg-body' + (sameSender ? ' msg-body-grouped' : '') });

      if (sameSender) {
        body.appendChild(el('span', { className: 'msg-ts-inline', textContent: shortTime(m.created_at) }));
      }

      var textNode = el('div', { className: 'msg-text', textContent: isExpanded ? m.content : preview });
      body.appendChild(textNode);
      if (isLong) {
        var toggle = el('span', { className: 'msg-expand', textContent: isExpanded ? 'show less' : 'show more' });
        toggle.addEventListener('click', (function (msgId) {
          return function () {
            expandedChatIds[msgId] = !expandedChatIds[msgId];
            textNode.textContent = expandedChatIds[msgId] ? m.content : preview;
            toggle.textContent = expandedChatIds[msgId] ? 'show less' : 'show more';
          };
        })(m.id));
        body.appendChild(toggle);
      }
      item.appendChild(body);
      nodes.push(item);
      lastSender = m.from_agent;
    });

    var wasAtBottom = (c.scrollHeight - c.scrollTop - c.clientHeight) < 80;
    clearAndAppend(c, nodes);
    if (wasAtBottom) {
      c.scrollTop = c.scrollHeight;
    }
  }

  function renderContextKeys(keys) {
    var c = document.getElementById('context-keys-list');
    if (!c) return;
    if (!keys || !keys.length) { c.textContent = ''; c.appendChild(el('div', { className: 'queue-empty', textContent: 'No context' })); return; }
    var grouped = {};
    keys.forEach(function (k) { if (!grouped[k.namespace]) grouped[k.namespace] = []; grouped[k.namespace].push(k); });
    var nodes = [];
    for (var ns in grouped) {
      // Namespace as a collapsible tile group
      var nsHeader = el('div', { className: 'queue-tile tile-context-ns' });
      var nsRow = el('div', { className: 'tile-row' });
      nsRow.appendChild(el('span', { className: 'tile-dot dot-context' }));
      nsRow.appendChild(el('span', { className: 'tile-label', textContent: ns + ' (' + grouped[ns].length + ')' }));
      nsHeader.appendChild(nsRow);
      var keysList = el('div', { className: 'tile-ns-keys' });
      grouped[ns].forEach(function (k) {
        var keyTile = el('div', { className: 'queue-tile tile-context-key' });
        keyTile.appendChild(el('div', { className: 'tile-row' }, [
          el('span', { className: 'tile-key-name', textContent: k.key })
        ]));
        var detail = el('div', { className: 'tile-detail' });
        var pretty = '';
        try { pretty = JSON.stringify(JSON.parse(k.data), null, 2); } catch (e) { pretty = k.data; }
        if (pretty.length > 120) pretty = pretty.substring(0, 120) + '...';
        detail.appendChild(el('pre', { className: 'tile-code', textContent: pretty }));
        detail.appendChild(el('div', { className: 'tile-meta', textContent: timeAgo(k.updated_at) }));
        keyTile.appendChild(detail);
        keysList.appendChild(keyTile);
      });
      nsHeader.addEventListener('click', (function (kl) {
        return function () { kl.classList.toggle('expanded'); };
      })(keysList));
      nodes.push(nsHeader);
      nodes.push(keysList);
    }
    clearAndAppend(c, nodes);
  }

  function renderContext(ctxs) {
    var c = document.getElementById('context-list');
    if (!ctxs || !ctxs.length) { c.textContent = ''; return; }
    clearAndAppend(c, ctxs.map(function (cx) {
      var tile = el('div', { className: 'queue-tile tile-context' });
      tile.appendChild(el('div', { className: 'tile-row' }, [
        el('span', { className: 'tile-dot dot-context' }),
        el('span', { className: 'tile-label', textContent: cx.game })
      ]));
      var detail = el('div', { className: 'tile-detail' });
      var pretty = '';
      try { pretty = JSON.stringify(JSON.parse(cx.data), null, 2); } catch (e) { pretty = cx.data; }
      if (pretty.length > 120) pretty = pretty.substring(0, 120) + '...';
      detail.appendChild(el('pre', { className: 'tile-code', textContent: pretty }));
      detail.appendChild(el('div', { className: 'tile-meta', textContent: (cx.updated_by || '?') + ' \u00B7 ' + timeAgo(cx.updated_at) }));
      tile.appendChild(detail);
      return tile;
    }));
  }

  function renderAssets(assets) {
    var c = document.getElementById('assets-list');
    var countEl = document.getElementById('asset-count');
    if (!c) return;
    if (!assets || !assets.length) { c.textContent = ''; c.appendChild(el('div', { className: 'queue-empty', textContent: 'No assets' })); if (countEl) countEl.textContent = ''; return; }
    if (countEl) countEl.textContent = assets.length;
    var grouped = {};
    assets.forEach(function (a) {
      var key = a.game || 'unknown';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(a);
    });
    var nodes = [];
    for (var game in grouped) {
      var groupHeader = el('div', { className: 'queue-tile tile-asset-group' });
      groupHeader.appendChild(el('div', { className: 'tile-row' }, [
        el('span', { className: 'tile-dot dot-asset' }),
        el('span', { className: 'tile-label', textContent: game + ' (' + grouped[game].length + ')' })
      ]));
      var itemsWrap = el('div', { className: 'tile-ns-keys' });
      grouped[game].forEach(function (a) {
        var tile = el('div', { className: 'queue-tile tile-asset' });
        var statusCls = a.status === 'delivered' ? ' status-delivered' : a.status === 'requested' ? ' status-requested' : '';
        tile.appendChild(el('div', { className: 'tile-row' }, [
          el('span', { className: 'tile-asset-name', textContent: a.name }),
          el('span', { className: 'tile-asset-status' + statusCls, textContent: a.status || '' })
        ]));
        itemsWrap.appendChild(tile);
      });
      groupHeader.addEventListener('click', (function (iw) {
        return function () { iw.classList.toggle('expanded'); };
      })(itemsWrap));
      nodes.push(groupHeader);
      nodes.push(itemsWrap);
    }
    clearAndAppend(c, nodes);
  }

  function renderGames(games) {
    var c = document.getElementById('games-list');
    if (!games || !games.length) { c.textContent = ''; c.appendChild(el('div', { className: 'queue-empty', textContent: 'No projects' })); return; }
    clearAndAppend(c, games.map(function (g) {
      var tile = el('div', { className: 'queue-tile tile-game' });
      tile.appendChild(el('div', { className: 'tile-row' }, [
        el('span', { className: 'tile-dot dot-game' }),
        el('span', { className: 'tile-label', textContent: g.name })
      ]));
      var detail = el('div', { className: 'tile-detail' });
      detail.appendChild(el('div', { className: 'tile-meta', textContent: g.description }));
      tile.appendChild(detail);
      return tile;
    }));
  }
  function renderBugs(bugs, counts) {
    var c = document.getElementById('bugs-list');
    var countEl = document.getElementById('bug-count');
    if (!c) return;
    var openCount = counts ? (counts.open || 0) : 0;
    if (countEl) countEl.textContent = openCount || '';
    if (!bugs || !bugs.length) { c.textContent = ''; c.appendChild(el('div', { className: 'queue-empty', textContent: 'No bugs' })); return; }
    clearAndAppend(c, bugs.map(function (b) {
      var sevCls = (b.severity === 'critical' || b.severity === 'high') ? ' tile-bug-' + b.severity : '';
      var tile = el('div', { className: 'queue-tile tile-bug' + sevCls, onclick: function () { showBugDetail(b); } });
      tile.appendChild(el('div', { className: 'tile-row' }, [
        el('span', { className: 'tile-dot dot-bug' }),
        el('span', { className: 'tile-label', textContent: '#' + b.id + ' ' + b.title })
      ]));
      var detail = el('div', { className: 'tile-detail' });
      var badges = el('div', { className: 'tile-badges' });
      badges.appendChild(el('span', { className: 'tile-badge tile-badge-' + b.status, textContent: b.status }));
      if (b.severity === 'high' || b.severity === 'critical') {
        badges.appendChild(el('span', { className: 'tile-badge tile-badge-sev-' + b.severity, textContent: b.severity }));
      }
      badges.appendChild(el('span', { className: 'tile-badge tile-badge-game', textContent: b.game }));
      detail.appendChild(badges);
      detail.appendChild(el('div', { className: 'tile-meta', textContent: (b.reporter || '?') + ' \u00B7 ' + timeAgo(b.created_at) }));
      tile.appendChild(detail);
      return tile;
    }));
  }

  function showBugDetail(b) {
    document.getElementById('bug-detail-title').textContent = 'Bug #' + b.id + ': ' + esc(b.title);
    var body = document.getElementById('bug-detail-body');
    body.textContent = '';

    var meta = el('div', { className: 'detail-meta' });
    [['Project', b.game], ['Status', b.status], ['Severity', b.severity || 'normal'],
     ['Category', b.category || 'other'], ['Reporter', b.reporter || '?'],
     ['Assignee', b.assignee || 'unassigned'], ['Filed', b.created_at || '']].forEach(function (pair) {
      meta.appendChild(el('div', {}, [el('span', { className: 'detail-label', textContent: pair[0] + ': ' }), el('span', { textContent: pair[1] })]));
    });
    body.appendChild(meta);

    if (b.description) {
      body.appendChild(el('div', { className: 'detail-section' }, [
        el('label', {}, 'Description'), el('p', { textContent: b.description })
      ]));
    }

    if (b.admin_notes) {
      body.appendChild(el('div', { className: 'detail-section' }, [
        el('label', {}, 'Admin Notes'), el('p', { textContent: b.admin_notes })
      ]));
    }

    if (b.diagnostic_data) {
      var diagSection = el('div', { className: 'detail-section' });
      diagSection.appendChild(el('label', {}, 'Diagnostic Data'));
      var pretty = '';
      try { pretty = JSON.stringify(JSON.parse(b.diagnostic_data), null, 2); } catch (e) { pretty = b.diagnostic_data; }
      diagSection.appendChild(el('pre', { className: 'bug-diag', textContent: pretty }));
      body.appendChild(diagSection);
    }

    // Status buttons
    var actions = el('div', { className: 'detail-actions' });
    ['open', 'acknowledged', 'in_progress', 'fixed', 'wontfix'].forEach(function (s) {
      actions.appendChild(el('button', {
        className: 'btn-status' + (s === b.status ? ' active' : ''), textContent: s,
        onclick: function () {
          apiPut('/bugs/' + b.id, { status: s }, function (err) {
            if (err) { alert('Error: ' + err.message); return; }
            closeAllModals(); fetchOverview();
          });
        }
      }));
    });
    body.appendChild(actions);

    // Notes field
    var notesSection = el('div', { className: 'detail-section' });
    notesSection.style.marginTop = '0.6rem';
    notesSection.appendChild(el('label', {}, 'Update Notes'));
    var notesInput = document.createElement('textarea');
    notesInput.rows = 2;
    notesInput.style.cssText = 'width:100%;padding:0.4rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.8rem;font-family:inherit;resize:vertical;';
    notesInput.value = b.admin_notes || '';
    notesSection.appendChild(notesInput);
    var saveBtn = el('button', { className: 'btn-primary', textContent: 'Save Notes', onclick: function () {
      apiPut('/bugs/' + b.id, { admin_notes: notesInput.value }, function (err) {
        if (err) { alert('Error: ' + err.message); return; }
        closeAllModals(); fetchOverview();
      });
    }});
    saveBtn.style.marginTop = '0.3rem';
    notesSection.appendChild(saveBtn);
    body.appendChild(notesSection);

    openModal(modalBugDetail);
  }

  // =============== PLANS ===============
  function renderPlans(plans) {
    var c = document.getElementById('plans-list');
    var countEl = document.getElementById('plan-count');
    if (!c) return;
    if (!plans || !plans.length) { c.textContent = ''; c.appendChild(el('div', { className: 'queue-empty', textContent: 'No plans' })); if (countEl) countEl.textContent = ''; return; }
    var active = plans.filter(function (p) { return p.status === 'active' || p.status === 'draft'; });
    if (countEl) countEl.textContent = active.length || '';
    // Sort: active first, then draft, then paused, then completed/cancelled last
    var statusOrder = { active: 0, draft: 1, paused: 2, completed: 3, cancelled: 4 };
    var sorted = plans.slice().sort(function (a, b) {
      var sa = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 3;
      var sb = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 3;
      if (sa !== sb) return sa - sb;
      return (b.updated_at || '').localeCompare(a.updated_at || '');
    });
    clearAndAppend(c, sorted.map(function (p) {
      var prog = p.progress || { total: 0, completed: 0, percent: 0 };
      var dotCls = 'tile-dot dot-plan-' + p.status;
      var tile = el('div', { className: 'queue-tile tile-plan tile-plan-' + p.status, onclick: function () { showPlanDetail(p.id); } });
      var row = el('div', { className: 'tile-row' });
      row.appendChild(el('span', { className: dotCls }));
      row.appendChild(el('span', { className: 'tile-label', textContent: '#' + p.id + ' ' + p.title }));
      tile.appendChild(row);
      if (prog.total > 0) {
        var bar = el('div', { className: 'tile-progress-bar' });
        var fill = el('div', { className: 'tile-progress-fill' });
        fill.style.width = prog.percent + '%';
        bar.appendChild(fill);
        tile.appendChild(bar);
      }
      var detail = el('div', { className: 'tile-detail' });
      var badges = el('div', { className: 'tile-badges' });
      badges.appendChild(el('span', { className: 'tile-badge tile-badge-plan-' + p.status, textContent: p.status }));
      badges.appendChild(el('span', { className: 'tile-badge tile-badge-game', textContent: p.game }));
      detail.appendChild(badges);
      detail.appendChild(el('div', { className: 'tile-meta', textContent: (p.owner || 'unowned') + ' \u00B7 ' + timeAgo(p.updated_at) }));
      if (prog.total > 0) {
        detail.appendChild(el('div', { className: 'tile-meta', textContent: prog.completed + '/' + prog.total + ' steps (' + prog.percent + '%)' }));
      }
      // Show current in-progress or next pending step on the tile
      if (p.current_step) {
        var stepLine = el('div', { className: 'tile-current-step' });
        stepLine.appendChild(el('span', { className: 'tile-current-step-indicator', textContent: '\u25B6' }));
        stepLine.appendChild(el('span', { textContent: p.current_step }));
        detail.appendChild(stepLine);
      }
      tile.appendChild(detail);
      return tile;
    }));
  }

  function showPlanDetail(planId) {
    apiGet('/plans/' + planId, function (err, plan) {
      if (err) { alert('Error loading plan: ' + err.message); return; }
      document.getElementById('plan-detail-title').textContent = '#' + plan.id + ': ' + esc(plan.title);
      var body = document.getElementById('plan-detail-body');
      body.textContent = '';

      if (plan.description) {
        body.appendChild(el('div', { className: 'detail-section' }, [
          el('label', {}, 'Description'), el('p', { textContent: plan.description })
        ]));
      }

      var meta = el('div', { className: 'detail-meta' });
      [['Project', plan.game], ['Status', plan.status], ['Priority', plan.priority || 'normal'],
       ['Owner', plan.owner || 'unowned'], ['Created by', plan.created_by || '?'],
       ['Created', plan.created_at || '']].forEach(function (pair) {
        meta.appendChild(el('div', {}, [el('span', { className: 'detail-label', textContent: pair[0] + ': ' }), el('span', { textContent: pair[1] })]));
      });
      body.appendChild(meta);

      // Progress bar
      var prog = plan.progress || { total: 0, completed: 0, percent: 0 };
      if (prog.total > 0) {
        var progSection = el('div', { className: 'detail-section' });
        progSection.appendChild(el('label', {}, 'Progress: ' + prog.completed + '/' + prog.total + ' (' + prog.percent + '%)'));
        var bar = el('div', { className: 'plan-progress-bar' });
        bar.style.height = '8px';
        var fill = el('div', { className: 'plan-progress-fill' });
        fill.style.width = prog.percent + '%';
        bar.appendChild(fill);
        progSection.appendChild(bar);
        body.appendChild(progSection);
      }

      // Status buttons
      var statusActions = el('div', { className: 'detail-actions' });
      ['draft', 'active', 'paused', 'completed', 'cancelled'].forEach(function (s) {
        statusActions.appendChild(el('button', {
          className: 'btn-status' + (s === plan.status ? ' active' : ''), textContent: s,
          onclick: function () {
            apiPut('/plans/' + plan.id, { status: s }, function (err) {
              if (err) { alert('Error: ' + err.message); return; }
              showPlanDetail(plan.id); fetchOverview();
            });
          }
        }));
      });
      body.appendChild(statusActions);

      // Steps checklist
      var stepsSection = el('div', { className: 'plan-steps-list' });
      stepsSection.appendChild(el('label', { style: 'font-weight:600;color:var(--accent);margin-bottom:0.3rem;display:block;font-size:0.75rem;' }, 'Steps'));
      var steps = plan.steps || [];
      if (steps.length === 0) {
        stepsSection.appendChild(el('div', { style: 'font-size:0.7rem;color:var(--text-dim);' }, 'No steps yet'));
      }
      var lastPhase = '';
      steps.forEach(function (step) {
        // Phase header
        if (step.phase && step.phase !== lastPhase) {
          lastPhase = step.phase;
          var phaseSteps = steps.filter(function (s) { return s.phase === step.phase; });
          var phaseDone = phaseSteps.filter(function (s) { return s.status === 'completed' || s.status === 'skipped'; }).length;
          var phaseHeader = el('div', { className: 'plan-phase-header' });
          phaseHeader.appendChild(el('span', { textContent: step.phase }));
          phaseHeader.appendChild(el('span', { className: 'plan-phase-count', textContent: phaseDone + '/' + phaseSteps.length }));
          stepsSection.appendChild(phaseHeader);
        }
        var item = el('div', { className: 'plan-step-item' });
        // Checkbox
        var checkCls = 'plan-step-check ' + step.status;
        var checkText = step.status === 'completed' ? '\u2713' : step.status === 'skipped' ? '\u2014' : '';
        var check = el('div', { className: checkCls, textContent: checkText, onclick: function () {
          var nextStatus = step.status === 'completed' ? 'pending' : 'completed';
          apiPut('/plans/' + plan.id + '/steps/' + step.id, { status: nextStatus }, function (err) {
            if (err) { alert('Error: ' + err.message); return; }
            showPlanDetail(plan.id); fetchOverview();
          });
        }});
        item.appendChild(check);
        // Content
        var content = el('div', { className: 'plan-step-content' });
        var titleCls = 'plan-step-title' + (step.status === 'completed' ? ' completed' : '');
        var titleEl = el('div', { className: titleCls, textContent: step.title });
        titleEl.onclick = function (e) {
          e.stopPropagation();
          var input = document.createElement('input');
          input.type = 'text'; input.value = step.title;
          input.className = 'plan-step-title editing';
          titleEl.replaceWith(input);
          input.focus(); input.select();
          function save() {
            var newTitle = input.value.trim();
            if (newTitle && newTitle !== step.title) {
              apiPut('/plans/' + plan.id + '/steps/' + step.id, { title: newTitle }, function (err) {
                if (err) alert('Error: ' + err.message);
                showPlanDetail(plan.id); fetchOverview();
              });
            } else {
              input.replaceWith(titleEl);
            }
          }
          input.onblur = save;
          input.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); save(); } if (ev.key === 'Escape') input.replaceWith(titleEl); };
        };
        content.appendChild(titleEl);
        // Status label + assignee row
        var metaRow = el('div', { style: 'display:flex;gap:0.3rem;align-items:center;margin-top:0.1rem;' });
        if (step.status !== 'pending') {
          metaRow.appendChild(el('span', { className: 'plan-step-status-label ' + step.status, textContent: step.status === 'in_progress' ? 'in progress' : step.status }));
        }
        if (step.assignee) metaRow.appendChild(el('div', { className: 'plan-step-assignee', textContent: step.assignee }));
        if (metaRow.children.length) content.appendChild(metaRow);
        // Links
        var linksText = [];
        if (step.linked_task_id) linksText.push('Task #' + step.linked_task_id);
        if (step.linked_branch) linksText.push(step.linked_branch);
        if (linksText.length) content.appendChild(el('div', { className: 'plan-step-links', textContent: linksText.join(' \u00B7 ') }));
        item.appendChild(content);
        // Actions
        var actions = el('div', { className: 'plan-step-actions' });
        var statusOpts = ['pending', 'in_progress', 'completed', 'skipped', 'blocked'];
        statusOpts.forEach(function (s) {
          if (s === step.status) return;
          var short = s === 'in_progress' ? 'wip' : s === 'completed' ? 'done' : s;
          actions.appendChild(el('button', { className: 'plan-step-btn', textContent: short, onclick: function () {
            apiPut('/plans/' + plan.id + '/steps/' + step.id, { status: s }, function (err) {
              if (err) { alert('Error: ' + err.message); return; }
              showPlanDetail(plan.id); fetchOverview();
            });
          }}));
        });
        actions.appendChild(el('button', { className: 'plan-step-btn btn-del', textContent: 'x', onclick: function () {
          apiDelete('/plans/' + plan.id + '/steps/' + step.id, function (err) {
            if (err) { alert('Error: ' + err.message); return; }
            showPlanDetail(plan.id); fetchOverview();
          });
        }}));
        item.appendChild(actions);
        stepsSection.appendChild(item);
      });

      // Add step form
      var addSection = el('div', { className: 'plan-add-step' });
      var addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.placeholder = 'Add a step...';
      addSection.appendChild(addInput);
      var addRow = el('div', { className: 'form-row' });
      var addPhase = document.createElement('input');
      addPhase.type = 'text';
      addPhase.placeholder = 'Phase (optional)';
      addPhase.style.cssText = 'padding:0.3rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.75rem;';
      if (lastPhase) addPhase.value = lastPhase;
      var addAssignee = document.createElement('input');
      addAssignee.type = 'text';
      addAssignee.placeholder = 'Assignee (optional)';
      addAssignee.style.cssText = 'padding:0.3rem;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:0.75rem;';
      var addBtn = el('button', { className: 'btn-primary', textContent: 'Add Step', onclick: function () {
        var title = addInput.value.trim();
        if (!title) return;
        var stepBody = { title: title };
        var ass = addAssignee.value.trim();
        if (ass) stepBody.assignee = ass;
        var ph = addPhase.value.trim();
        if (ph) stepBody.phase = ph;
        apiPost('/plans/' + plan.id + '/steps', stepBody, function (err) {
          if (err) { alert('Error: ' + err.message); return; }
          showPlanDetail(plan.id); fetchOverview();
        });
      }});
      addBtn.style.fontSize = '0.7rem';
      addBtn.style.padding = '0.25rem 0.5rem';
      addRow.appendChild(addPhase);
      addRow.appendChild(addAssignee);
      addRow.appendChild(addBtn);
      addSection.appendChild(addRow);
      stepsSection.appendChild(addSection);
      body.appendChild(stepsSection);

      openModal(modalPlanDetail);
    });
  }

  // =============== CONCEPTS ===============
  function renderConcepts(concepts) {
    var c = document.getElementById('concepts-list');
    var countEl = document.getElementById('concept-count');
    if (!c) return;
    if (!concepts || !concepts.length) { c.textContent = ''; c.appendChild(el('div', { className: 'queue-empty', textContent: 'No concepts' })); if (countEl) countEl.textContent = ''; return; }
    if (countEl) countEl.textContent = concepts.length;
    clearAndAppend(c, concepts.map(function (con) {
      var tile = el('div', { className: 'queue-tile tile-concept', onclick: function () { showConceptDetail(con.id); } });
      var row = el('div', { className: 'tile-row' });
      row.appendChild(el('span', { className: 'tile-dot dot-concept' }));
      row.appendChild(el('span', { className: 'tile-label', textContent: con.name }));
      var typeCls = 'concept-type-badge concept-type-' + (con.type || 'custom');
      row.appendChild(el('span', { className: typeCls, textContent: con.type || 'custom' }));
      tile.appendChild(row);
      var detail = el('div', { className: 'tile-detail' });
      if (con.description) {
        var desc = con.description;
        if (desc.length > 120) desc = desc.substring(0, 120) + '...';
        detail.appendChild(el('div', { className: 'concept-desc', textContent: desc }));
      }
      var projects = con.projects || [];
      if (projects.length) {
        var chips = el('div', { className: 'concept-projects' });
        projects.forEach(function (p) {
          var name = typeof p === 'string' ? p : (p.name || p.project_id || '');
          chips.appendChild(el('span', { className: 'concept-project-chip', textContent: name }));
        });
        detail.appendChild(chips);
      }
      if (con.version) {
        detail.appendChild(el('div', { className: 'concept-version', textContent: 'v' + con.version }));
      }
      tile.appendChild(detail);
      return tile;
    }));
  }

  function showConceptDetail(conceptId) {
    apiGet('/concepts/' + conceptId, function (err, con) {
      if (err) { alert('Error loading concept: ' + err.message); return; }
      var titleEl = document.getElementById('concept-detail-title');
      var body = document.getElementById('concept-detail-body');
      body.textContent = '';

      // Header with name + type badge
      var header = el('div', { className: 'concept-detail-header' });
      header.appendChild(el('span', { className: 'concept-detail-name', textContent: con.name }));
      var typeCls = 'concept-type-badge concept-type-' + (con.type || 'custom');
      header.appendChild(el('span', { className: typeCls, textContent: con.type || 'custom' }));
      if (con.version) header.appendChild(el('span', { className: 'concept-version', textContent: 'v' + con.version }));
      body.appendChild(header);
      titleEl.textContent = con.name;

      // Meta
      var meta = el('div', { className: 'concept-detail-meta' });
      [['Type', con.type || 'custom'], ['Version', con.version || '1'],
       ['Created', timeAgo(con.created_at)], ['Updated', timeAgo(con.updated_at)]].forEach(function (pair) {
        meta.appendChild(el('span', { className: 'detail-label', textContent: pair[0] }));
        meta.appendChild(el('span', { textContent: pair[1] }));
      });
      body.appendChild(meta);

      // Linked projects
      var projects = con.projects || [];
      if (projects.length) {
        var projSection = el('div', { className: 'concept-detail-projects' });
        projects.forEach(function (p) {
          var name = typeof p === 'string' ? p : (p.name || p.project_id || '');
          projSection.appendChild(el('span', { className: 'concept-detail-chip', textContent: name }));
        });
        body.appendChild(projSection);
      }

      // Description
      if (con.description) {
        body.appendChild(el('div', { className: 'concept-detail-desc', textContent: con.description }));
      }

      // Data (JSON)
      var data = con.data;
      if (data) {
        var dataSection = el('div', { className: 'detail-section' });
        dataSection.appendChild(el('label', { style: 'font-weight:600;color:var(--accent);margin-bottom:0.3rem;display:block;font-size:0.75rem;' }, 'Data'));
        var dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        dataSection.appendChild(el('pre', { className: 'concept-detail-data', textContent: dataStr }));
        body.appendChild(dataSection);
      }

      openModal(modalConceptDetail);
    });
  }

  // =============== DICTATE TO AGENT (Speech-to-Text) ===============
  var dictRecognition = null;
  var dictRecording = false;
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  var dictateBtn = document.getElementById('dictate-btn');
  var dictateMic = document.getElementById('dictate-mic');
  var dictateStatus = document.getElementById('dictate-status');
  var dictateTranscript = document.getElementById('dictate-transcript');
  var dictateSend = document.getElementById('dictate-send');
  var dictateClear = document.getElementById('dictate-clear');
  var dictateError = document.getElementById('dictate-error');

  if (dictateBtn) {
    dictateBtn.addEventListener('click', function () {
      if (!SpeechRecognition) {
        alert('Speech recognition not supported in this browser. Use Chrome.');
        return;
      }
      dictateTranscript.textContent = '';
      dictateError.textContent = '';
      dictateStatus.textContent = 'Click the mic to start';
      dictateStatus.classList.remove('recording');
      dictateMic.classList.remove('recording');
      openModal(modalDictate);
    });
  }

  if (dictateMic) {
    dictateMic.addEventListener('click', function () {
      if (!SpeechRecognition) return;

      if (dictRecording) {
        // Stop
        dictRecognition.stop();
        dictRecording = false;
        dictateMic.classList.remove('recording');
        dictateStatus.textContent = 'Stopped — edit text below if needed';
        dictateStatus.classList.remove('recording');
        return;
      }

      // Start
      dictRecognition = new SpeechRecognition();
      dictRecognition.continuous = true;
      dictRecognition.interimResults = true;
      dictRecognition.lang = 'en-US';

      var finalText = dictateTranscript.textContent || '';

      dictRecognition.onresult = function (event) {
        var interim = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalText += event.results[i][0].transcript + ' ';
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        dictateTranscript.textContent = finalText + interim;
      };

      dictRecognition.onerror = function (event) {
        if (event.error === 'no-speech') return; // silent, not an error
        dictateStatus.textContent = 'Error: ' + event.error;
        dictateStatus.classList.remove('recording');
        dictateMic.classList.remove('recording');
        dictRecording = false;
      };

      dictRecognition.onend = function () {
        if (dictRecording) {
          // Auto-restart if still in recording mode (browser stops after silence)
          try { dictRecognition.start(); } catch (e) { /* ignore */ }
        }
      };

      dictRecognition.start();
      dictRecording = true;
      dictateMic.classList.add('recording');
      dictateStatus.textContent = 'Listening...';
      dictateStatus.classList.add('recording');
    });
  }

  if (dictateClear) {
    dictateClear.addEventListener('click', function () {
      dictateTranscript.textContent = '';
    });
  }

  if (dictateSend) {
    dictateSend.addEventListener('click', function () {
      var text = dictateTranscript.textContent.trim();
      if (!text) { dictateError.textContent = 'Nothing to send'; return; }
      var agent = document.getElementById('dictate-agent').value;
      var sendType = document.getElementById('dictate-type').value;
      dictateError.textContent = 'Sending...';

      if (sendType === 'request') {
        apiPost('/requests', {
          from_agent: 'admin',
          to_agent: agent,
          content: text,
          game: 'dioverse'
        }, function (err) {
          if (err) { dictateError.textContent = 'Error: ' + err.message; return; }
          closeAllModals(); fetchOverview();
        });
      } else {
        apiPost('/messages', {
          from_agent: 'admin',
          to_agent: agent,
          content: text,
          game: 'dioverse'
        }, function (err) {
          if (err) { dictateError.textContent = 'Error: ' + err.message; return; }
          closeAllModals(); fetchOverview();
        });
      }
    });
  }

  // =============== VOICE CHAT (WebRTC) ===============

  // Bug #7: Notification tones for join/leave (Web Audio API)
  var voiceAudioCtx = null;
  function playVoiceTone(type) {
    try {
      if (!voiceAudioCtx) voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ctx = voiceAudioCtx;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.value = 0.15;
      if (type === 'join') {
        // Rising two-tone (like Google Meet join)
        osc.frequency.value = 440;
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.setValueAtTime(554, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
      } else {
        // Falling tone (leave)
        osc.frequency.value = 554;
        osc.frequency.setValueAtTime(554, ctx.currentTime);
        osc.frequency.setValueAtTime(370, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.25);
      }
    } catch (e) { /* audio not available */ }
  }

  var voiceWs = null;
  var voiceMyId = null;
  var voiceConnections = {};  // peerId -> { name, muted, pc, stream }
  var voiceLocalStream = null;
  var voiceMuted = false;
  var voiceConnected = false;
  var voiceChannel = document.getElementById('voice-channel');
  var voiceStatusEl = document.getElementById('voice-status');
  var voicePeersEl = document.getElementById('voice-peers');
  var voiceJoinBtn = document.getElementById('voice-join');
  var voiceMuteBtn = document.getElementById('voice-mute');
  var voiceLeaveBtn = document.getElementById('voice-leave');
  var voiceBtn = document.getElementById('voice-btn');

  var ICE_SERVERS = []; // Fetched from server with TURN credentials

  // Poll voice room state (who's in channel) — runs even when not connected
  function pollVoiceRoom() {
    fetch('/api/voice/peers').then(function (r) { return r.json(); }).then(function (data) {
      if (!voiceConnected) {
        // Not in voice — show who's in room from REST poll
        renderVoiceRoomState(data.peers);
      }
    }).catch(function () { /* ignore */ });
  }

  function renderVoiceRoomState(peers) {
    voicePeersEl.textContent = '';
    if (!peers || !peers.length) {
      voiceStatusEl.textContent = 'Empty';
      voicePeersEl.appendChild(el('span', { className: 'voice-empty', textContent: 'No one in voice' }));
    } else {
      voiceStatusEl.textContent = peers.length + ' in channel';
      peers.forEach(function (p) {
        var peerEl = el('div', { className: 'voice-peer' + (p.muted ? ' muted' : '') });
        peerEl.appendChild(el('span', { className: 'peer-dot' }));
        peerEl.appendChild(el('span', { textContent: p.name || p.id }));
        voicePeersEl.appendChild(peerEl);
      });
    }
  }

  // Poll voice room every 5 seconds
  setInterval(function () {
    if (!voiceConnected) pollVoiceRoom();
  }, 5000);
  // Initial poll
  setTimeout(pollVoiceRoom, 1000);

  function voiceConnect() {
    if (voiceConnected) return;

    // Fetch TURN credentials then get mic
    fetch('/api/voice/turn-credentials').then(function (r) { return r.json(); }).then(function (data) {
      ICE_SERVERS = data.iceServers;
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1
        },
        video: false
      });
    }).then(function (rawStream) {
        // Audio processing pipeline: highpass → lowpass → compressor → gate
        var audioCtx = new AudioContext({ sampleRate: 48000 });
        var source = audioCtx.createMediaStreamSource(rawStream);

        // Highpass at 80Hz — kills keyboard rumble, AC hum, desk vibration
        var highpass = audioCtx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 80;
        highpass.Q.value = 0.7;

        // No gain boost — prevents feedback loop
        var gain = audioCtx.createGain();
        gain.gain.value = 1.0;

        // Chain: mic → highpass → gain → output
        // Browser already handles noise suppression + auto gain control
        // No lowpass filter (was cutting sibilants at 14kHz, muffling voices)
        // No compressor (double-compressing with browser AGC = unnatural sound)
        source.connect(highpass);
        highpass.connect(gain);

        // Bug #7: Speaking indicator via analyser
        var analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        gain.connect(analyser);

        var dest = audioCtx.createMediaStreamDestination();
        gain.connect(dest);

        voiceLocalStream = dest.stream;
        // Keep raw stream ref so we can stop mic on disconnect
        voiceLocalStream._rawStream = rawStream;
        voiceLocalStream._audioCtx = audioCtx;
        voiceLocalStream._analyser = analyser;
        voiceConnected = true;

        // Speaking detection loop
        var analyserData = new Uint8Array(analyser.frequencyBinCount);
        var wasSpeaking = false;
        voiceLocalStream._speakingInterval = setInterval(function () {
          if (!voiceConnected || voiceMuted) {
            if (wasSpeaking) { wasSpeaking = false; voiceChannel.classList.remove('voice-speaking'); }
            return;
          }
          analyser.getByteFrequencyData(analyserData);
          var sum = 0;
          for (var i = 0; i < analyserData.length; i++) sum += analyserData[i];
          var avg = sum / analyserData.length;
          var speaking = avg > 15;
          if (speaking !== wasSpeaking) {
            wasSpeaking = speaking;
            voiceChannel.classList.toggle('voice-speaking', speaking);
          }
        }, 100);
        voiceChannel.classList.add('voice-active');
        voiceJoinBtn.style.display = 'none';
        voiceMuteBtn.style.display = '';
        voiceLeaveBtn.style.display = '';

        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        voiceWs = new WebSocket(proto + '//' + location.host + '/voice');

        voiceWs.onopen = function () {
          voiceStatusEl.textContent = 'Connected';
          voiceStatusEl.style.color = '';
        };

        voiceWs.onclose = function () {
          voiceDisconnect();
        };

        voiceWs.onerror = function () {
          voiceStatusEl.textContent = 'Connection error';
          voiceStatusEl.style.color = '';
        };

        voiceWs.onmessage = function (evt) {
          try {
            var msg = JSON.parse(evt.data);
            handleVoiceMessage(msg);
          } catch (e) { /* ignore */ }
        };
      })
      .catch(function (err) {
        alert('Microphone access denied: ' + err.message);
      });
  }

  function voiceDisconnect() {
    voiceConnected = false;
    voiceMyId = null;

    for (var pid in voiceConnections) {
      if (voiceConnections[pid].pc) voiceConnections[pid].pc.close();
      var audioEl = document.getElementById('audio-' + pid);
      if (audioEl) audioEl.remove();
    }
    voiceConnections = {};

    voiceChannel.classList.remove('voice-speaking');

    if (voiceLocalStream) {
      // Stop speaking detection
      if (voiceLocalStream._speakingInterval) clearInterval(voiceLocalStream._speakingInterval);
      // Stop the processed stream
      voiceLocalStream.getTracks().forEach(function (t) { t.stop(); });
      // Stop the raw mic stream
      if (voiceLocalStream._rawStream) {
        voiceLocalStream._rawStream.getTracks().forEach(function (t) { t.stop(); });
      }
      // Close audio context
      if (voiceLocalStream._audioCtx) {
        voiceLocalStream._audioCtx.close().catch(function () {});
      }
      voiceLocalStream = null;
    }

    if (voiceWs) {
      voiceWs.close();
      voiceWs = null;
    }

    voiceMuted = false;
    voiceMuteBtn.textContent = 'Mute';
    voiceMuteBtn.classList.remove('voice-muted');
    voiceMuteBtn.style.display = 'none';
    voiceLeaveBtn.style.display = 'none';
    voiceJoinBtn.style.display = '';
    voiceChannel.classList.remove('voice-active');
    voiceStatusEl.style.color = '';
    // Immediately poll to show current room state
    pollVoiceRoom();
  }

  function handleVoiceMessage(msg) {
    if (msg.type === 'welcome') {
      voiceMyId = msg.id;
      voiceWs.send(JSON.stringify({ type: 'set_name', name: (currentUser && currentUser.display_name) || 'Guest' }));
      if (msg.peers) {
        msg.peers.forEach(function (p) {
          voiceConnections[p.id] = { name: p.name, muted: p.muted, pc: null, stream: null };
          createPeerConnection(p.id, true);
        });
      }
      renderVoicePeersLive();

    } else if (msg.type === 'peer_joined') {
      voiceConnections[msg.peer.id] = { name: msg.peer.name, muted: msg.peer.muted, pc: null, stream: null };
      playVoiceTone('join');
      renderVoicePeersLive();

    } else if (msg.type === 'peer_left') {
      if (voiceConnections[msg.id]) {
        if (voiceConnections[msg.id].pc) voiceConnections[msg.id].pc.close();
        var audioEl = document.getElementById('audio-' + msg.id);
        if (audioEl) audioEl.remove();
        delete voiceConnections[msg.id];
      }
      playVoiceTone('leave');
      renderVoicePeersLive();

    } else if (msg.type === 'peer_updated') {
      if (voiceConnections[msg.peer.id]) {
        voiceConnections[msg.peer.id].name = msg.peer.name;
        voiceConnections[msg.peer.id].muted = msg.peer.muted;
      }
      renderVoicePeersLive();

    } else if (msg.type === 'offer') {
      if (!voiceConnections[msg.from]) {
        voiceConnections[msg.from] = { name: msg.from, muted: false, pc: null, stream: null };
      }
      createPeerConnection(msg.from, false);
      var pc = voiceConnections[msg.from].pc;
      pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }))
        .then(function () { return pc.createAnswer(); })
        .then(function (answer) {
          answer.sdp = boostOpusSDP(answer.sdp);
          return pc.setLocalDescription(answer);
        })
        .then(function () {
          voiceWs.send(JSON.stringify({ type: 'answer', to: msg.from, sdp: pc.localDescription.sdp }));
        })
        .catch(function (e) { console.error('Voice answer error:', e); });

    } else if (msg.type === 'answer') {
      if (voiceConnections[msg.from] && voiceConnections[msg.from].pc) {
        voiceConnections[msg.from].pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }))
          .catch(function (e) { console.error('Voice set answer error:', e); });
      }

    } else if (msg.type === 'ice') {
      if (voiceConnections[msg.from] && voiceConnections[msg.from].pc && msg.candidate) {
        voiceConnections[msg.from].pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
          .catch(function () { /* non-fatal */ });
      }
    }
  }

  // Boost Opus to max quality (128kbps, wideband, FEC for packet loss resilience)
  function boostOpusSDP(sdp) {
    return sdp.replace(/a=fmtp:111 /g, 'a=fmtp:111 maxaveragebitrate=128000;maxplaybackrate=48000;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;cbr=0;');
  }

  function createPeerConnection(peerId, isOfferer) {
    var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    voiceConnections[peerId].pc = pc;

    if (voiceLocalStream) {
      voiceLocalStream.getTracks().forEach(function (track) {
        pc.addTrack(track, voiceLocalStream);
      });
    }

    pc.ontrack = function (event) {
      voiceConnections[peerId].stream = event.streams[0];
      var audioId = 'audio-' + peerId;
      var audio = document.getElementById(audioId);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = audioId;
        audio.autoplay = true;
        audio.volume = 1.0;
        document.body.appendChild(audio);
      }
      audio.srcObject = event.streams[0];
      // Force play (autoplay policy workaround)
      var playPromise = audio.play();
      if (playPromise) {
        playPromise.catch(function () {
          // Browser blocked autoplay — user interaction needed
          console.warn('Audio autoplay blocked for ' + peerId + ', will retry on interaction');
          document.addEventListener('click', function retryPlay() {
            audio.play().catch(function () {});
            document.removeEventListener('click', retryPlay);
          }, { once: true });
        });
      }
    };

    pc.onicecandidate = function (event) {
      if (event.candidate && voiceWs && voiceWs.readyState === 1) {
        voiceWs.send(JSON.stringify({ type: 'ice', to: peerId, candidate: event.candidate }));
      }
    };

    pc.onconnectionstatechange = function () {
      console.log('[Voice] Peer ' + peerId + ' connection: ' + pc.connectionState);
      renderVoicePeersLive();
    };

    pc.oniceconnectionstatechange = function () {
      console.log('[Voice] Peer ' + peerId + ' ICE: ' + pc.iceConnectionState);
    };

    if (isOfferer) {
      pc.createOffer()
        .then(function (offer) {
          offer.sdp = boostOpusSDP(offer.sdp);
          return pc.setLocalDescription(offer);
        })
        .then(function () {
          voiceWs.send(JSON.stringify({ type: 'offer', to: peerId, sdp: pc.localDescription.sdp }));
        })
        .catch(function (e) { console.error('Voice offer error:', e); });
    }
  }

  function renderVoicePeersLive() {
    voicePeersEl.textContent = '';
    // Show self
    var selfEl = el('div', { className: 'voice-peer is-me' + (voiceMuted ? ' muted' : '') });
    selfEl.appendChild(el('span', { className: 'peer-dot' }));
    selfEl.appendChild(el('span', { textContent: 'You' }));
    voicePeersEl.appendChild(selfEl);

    var peerCount = 1;
    for (var pid in voiceConnections) {
      var p = voiceConnections[pid];
      var connState = p.pc ? p.pc.connectionState : 'no-pc';
      var peerEl = el('div', { className: 'voice-peer' + (p.muted ? ' muted' : '') });
      peerEl.appendChild(el('span', { className: 'peer-dot' }));
      var label = (p.name || pid);
      if (connState !== 'connected') label += ' (' + connState + ')';
      peerEl.appendChild(el('span', { textContent: label }));
      voicePeersEl.appendChild(peerEl);
      peerCount++;
    }
    voiceStatusEl.textContent = peerCount + ' in channel';
  }

  // Button handlers
  if (voiceBtn) {
    voiceBtn.addEventListener('click', function () {
      if (voiceConnected) voiceDisconnect();
      else voiceConnect();
    });
  }

  if (voiceJoinBtn) {
    voiceJoinBtn.addEventListener('click', function () {
      voiceConnect();
    });
  }

  if (voiceMuteBtn) {
    voiceMuteBtn.addEventListener('click', function () {
      voiceMuted = !voiceMuted;
      voiceMuteBtn.textContent = voiceMuted ? 'Unmute' : 'Mute';
      voiceMuteBtn.classList.toggle('voice-muted', voiceMuted);
      if (voiceLocalStream) {
        voiceLocalStream.getAudioTracks().forEach(function (t) { t.enabled = !voiceMuted; });
        if (voiceLocalStream._rawStream) {
          voiceLocalStream._rawStream.getAudioTracks().forEach(function (t) { t.enabled = !voiceMuted; });
        }
      }
      if (voiceWs && voiceWs.readyState === 1) {
        voiceWs.send(JSON.stringify({ type: 'mute', muted: voiceMuted }));
      }
      renderVoicePeersLive();
    });
  }

  if (voiceLeaveBtn) {
    voiceLeaveBtn.addEventListener('click', function () {
      voiceDisconnect();
    });
  }
})();
