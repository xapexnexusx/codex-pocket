const state = {
  threads: [],
  activeThreadId: null,
  threadDetails: new Map(),
  pendingApprovals: [],
  connection: {
    connected: false,
    lastError: null
  },
  auth: {
    configured: true,
    mode: 'login'
  }
};

let socket = null;

const elements = {
  threadList: document.getElementById('threadList'),
  threadTitle: document.getElementById('threadTitle'),
  threadWorkspace: document.getElementById('threadWorkspace'),
  threadSource: document.getElementById('threadSource'),
  threadStatus: document.getElementById('threadStatus'),
  timeline: document.getElementById('timeline'),
  planBody: document.getElementById('planBody'),
  diffBody: document.getElementById('diffBody'),
  approvalBody: document.getElementById('approvalBody'),
  approvalCount: document.getElementById('approvalCount'),
  connectionLabel: document.getElementById('connectionLabel'),
  composerInput: document.getElementById('composerInput'),
  sendButton: document.getElementById('sendButton'),
  interruptButton: document.getElementById('interruptButton'),
  newThreadButton: document.getElementById('newThreadButton'),
  authGate: document.getElementById('authGate'),
  authTitle: document.getElementById('authTitle'),
  authCopy: document.getElementById('authCopy'),
  authInput: document.getElementById('authInput'),
  authConfirmInput: document.getElementById('authConfirmInput'),
  authButton: document.getElementById('authButton'),
  authError: document.getElementById('authError')
};

async function bootstrap() {
  registerServiceWorker();
  bindEvents();
  await loadAuthState();
}

async function loadAuthState() {
  const payload = await fetchJson('/api/auth/state', false);
  state.auth.configured = Boolean(payload.configured);
  state.auth.mode = state.auth.configured ? 'login' : 'setup';
  syncAuthGate();

  if (!state.auth.configured) {
    showAuthGate();
    return;
  }

  try {
    await loadProtectedState();
  } catch (error) {
    if (error.code === 'AUTH_REQUIRED') {
      showAuthGate('Enter your password to unlock the bridge.');
      return;
    }
    throw error;
  }
}

async function loadProtectedState() {
  const payload = await fetchJson('/api/bootstrap');
  state.threads = sortThreads(payload.threads || []);
  state.pendingApprovals = payload.pendingApprovals || [];
  state.connection = payload.connection || state.connection;
  render();
  hideAuthGate();

  const initialThread = state.threads[0];
  if (initialThread) {
    await selectThread(initialThread.id);
  }

  connectSocket();
}

function bindEvents() {
  elements.sendButton.addEventListener('click', sendPrompt);
  elements.interruptButton.addEventListener('click', interruptTurn);
  elements.newThreadButton.addEventListener('click', createThread);
  elements.authButton.addEventListener('click', submitPassword);
  elements.composerInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      sendPrompt();
    }
  });

  document.querySelectorAll('[data-panel-target]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelector('.app-shell').dataset.panel = button.dataset.panelTarget;
    });
  });

  elements.authInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      submitPassword();
    }
  });

  elements.authConfirmInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      submitPassword();
    }
  });
}

async function createThread() {
  const response = await postJson('/api/threads', {});
  if (response.thread) {
    state.threads = sortThreads([response.thread, ...state.threads.filter((thread) => thread.id !== response.thread.id)]);
    await selectThread(response.thread.id);
  }
}

async function selectThread(threadId) {
  state.activeThreadId = threadId;
  const response = await fetchJson(`/api/threads/${threadId}`);
  state.threadDetails.set(threadId, response.thread);
  render();
}

async function sendPrompt() {
  const threadId = state.activeThreadId;
  if (!threadId) {
    return;
  }

  const text = elements.composerInput.value.trim();
  if (!text) {
    return;
  }

  elements.sendButton.disabled = true;
  try {
    await postJson(`/api/threads/${threadId}/prompt`, { text });
    elements.composerInput.value = '';
  } finally {
    elements.sendButton.disabled = false;
  }
}

async function interruptTurn() {
  if (!state.activeThreadId) {
    return;
  }
  try {
    await postJson(`/api/threads/${state.activeThreadId}/interrupt`, {});
  } catch (error) {
    console.error(error);
  }
}

async function respondApproval(id, decision) {
  await postJson(`/api/approvals/${id}`, { decision });
  state.pendingApprovals = state.pendingApprovals.filter((approval) => approval.id !== id);
  renderApprovalPanel();
}

function connectSocket() {
  if (socket) {
    socket.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  socket.addEventListener('open', () => {
    state.connection.connected = true;
    state.connection.lastError = null;
    renderConnection();
  });

  socket.addEventListener('close', () => {
    state.connection.connected = false;
    renderConnection();
    window.setTimeout(connectSocket, 2000);
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    handleBridgeEvent(message);
  });
}

function handleBridgeEvent(message) {
  switch (message.type) {
    case 'connection':
      state.connection = message.payload;
      renderConnection();
      break;
    case 'snapshot':
      state.pendingApprovals = message.payload.pendingApprovals || [];
      renderApprovalPanel();
      break;
    case 'server-request':
      state.pendingApprovals = dedupeApprovals([message.payload, ...state.pendingApprovals]);
      renderApprovalPanel();
      break;
    case 'approval-resolved':
      state.pendingApprovals = state.pendingApprovals.filter((approval) => approval.id !== message.payload.id);
      renderApprovalPanel();
      break;
    case 'notification':
      applyNotification(message.payload.method, message.payload.params || {});
      break;
    default:
      break;
  }
}

function applyNotification(method, params) {
  const activeThread = getActiveThread();

  if (method === 'thread/started' && params.thread) {
    upsertThread(params.thread);
  }

  if (method === 'thread/name/updated') {
    updateThread(params.threadId, (thread) => {
      thread.name = params.name;
    });
  }

  if (method === 'thread/status/changed') {
    updateThread(params.threadId, (thread) => {
      thread.status = params.status;
    });
  }

  if (method === 'turn/started') {
    const turn = ensureTurn(params.threadId, params.turn);
    turn.status = params.turn.status;
  }

  if (method === 'turn/completed') {
    const turn = ensureTurn(params.threadId, params.turn);
    turn.status = params.turn.status;
    refetchThread(params.threadId);
  }

  if (method === 'item/started') {
    const turn = ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
    upsertItem(turn, params.item);
  }

  if (method === 'item/completed') {
    const turn = ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
    upsertItem(turn, params.item);
  }

  if (method === 'item/agentMessage/delta') {
    const turn = ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
    const item = ensureAgentMessage(turn, params.itemId);
    item.text += params.delta || '';
  }

  if (method === 'item/commandExecution/outputDelta') {
    const turn = ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
    const item = ensureCommandItem(turn, params.itemId);
    item.aggregatedOutput = `${item.aggregatedOutput || ''}${params.delta || ''}`;
  }

  if (method === 'item/fileChange/outputDelta') {
    const turn = ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
    const item = ensureFileChange(turn, params.itemId);
    item.output = `${item.output || ''}${params.delta || ''}`;
  }

  if (method === 'turn/diff/updated') {
    const turn = ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
    turn.diff = params.diff || '';
  }

  if (method === 'turn/plan/updated') {
    const turn = ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
    turn.plan = params.plan || [];
    turn.planExplanation = params.explanation || '';
  }

  if (method === 'serverRequest/resolved') {
    state.pendingApprovals = state.pendingApprovals.filter((approval) => approval.id !== String(params.requestId));
    renderApprovalPanel();
  }

  if (activeThread && activeThread.id === state.activeThreadId) {
    renderStage();
  }

  renderThreads();
}

function upsertThread(thread) {
  const index = state.threads.findIndex((candidate) => candidate.id === thread.id);
  if (index === -1) {
    state.threads.unshift(thread);
  } else {
    state.threads[index] = { ...state.threads[index], ...thread };
  }
  state.threads = sortThreads(state.threads);
}

function updateThread(threadId, updater) {
  let detail = state.threadDetails.get(threadId);
  if (detail) {
    updater(detail);
  }
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (thread) {
    updater(thread);
  }
}

function ensureTurn(threadId, seed) {
  let detail = state.threadDetails.get(threadId);
  if (!detail) {
    detail = {
      id: threadId,
      name: null,
      preview: '',
      cwd: '',
      source: '',
      status: 'active',
      turns: []
    };
    state.threadDetails.set(threadId, detail);
  }

  let turn = detail.turns.find((candidate) => candidate.id === seed.id);
  if (!turn) {
    turn = {
      id: seed.id,
      items: [],
      status: seed.status || 'inProgress',
      error: seed.error || null,
      diff: '',
      plan: [],
      planExplanation: ''
    };
    detail.turns.push(turn);
  }
  return turn;
}

function upsertItem(turn, item) {
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) {
    turn.items.push({ ...item });
    return;
  }
  turn.items[index] = { ...turn.items[index], ...item };
}

function ensureAgentMessage(turn, itemId) {
  let item = turn.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    item = { type: 'agentMessage', id: itemId, text: '', phase: null };
    turn.items.push(item);
  }
  return item;
}

function ensureCommandItem(turn, itemId) {
  let item = turn.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    item = {
      type: 'commandExecution',
      id: itemId,
      command: '',
      cwd: '',
      processId: null,
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: ''
    };
    turn.items.push(item);
  }
  return item;
}

function ensureFileChange(turn, itemId) {
  let item = turn.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    item = { type: 'fileChange', id: itemId, changes: [], status: 'inProgress', output: '' };
    turn.items.push(item);
  }
  return item;
}

function render() {
  renderConnection();
  renderThreads();
  renderStage();
  renderApprovalPanel();
}

function renderConnection() {
  elements.connectionLabel.textContent = state.connection.connected ? 'Live' : 'Degraded';
  elements.approvalCount.textContent = String(state.pendingApprovals.length);
}

function renderThreads() {
  const activeId = state.activeThreadId;
  elements.threadList.innerHTML = '';

  if (state.threads.length === 0) {
    elements.threadList.innerHTML = '<p class="empty-copy">No threads surfaced yet.</p>';
    return;
  }

  for (const thread of state.threads) {
    const status = normalizeStatus(thread.status);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `thread-card ${thread.id === activeId ? 'active' : ''}`;
    card.innerHTML = `
      <span class="thread-status ${status}"></span>
      <div class="thread-card-copy">
        <strong>${escapeHtml(thread.name || clip(thread.preview || thread.id, 68))}</strong>
        <p>${escapeHtml(clip(thread.preview || 'No preview', 104))}</p>
        <small>${escapeHtml(thread.cwd || 'Local cache')}</small>
      </div>
    `;
    card.addEventListener('click', async () => {
      document.querySelector('.app-shell').dataset.panel = 'chat';
      await selectThread(thread.id);
    });
    elements.threadList.appendChild(card);
  }
}

function renderStage() {
  const thread = getActiveThread();
  if (!thread) {
    elements.threadTitle.textContent = 'Waiting for threads';
    elements.threadWorkspace.textContent = '/Users/you';
    elements.threadSource.textContent = 'codex app-server';
    elements.threadStatus.textContent = 'Standby';
    elements.timeline.innerHTML = `
      <div class="timeline-empty">
        <p class="eyebrow">Signal Intake</p>
        <h3>Select a thread to jack in.</h3>
      </div>
    `;
    elements.planBody.innerHTML = '<p class="panel-placeholder">No active plan telemetry.</p>';
    elements.diffBody.innerHTML = '<p class="panel-placeholder">No diff emitted yet.</p>';
    return;
  }

  elements.threadTitle.textContent = thread.name || clip(thread.preview || thread.id, 96);
  elements.threadWorkspace.textContent = thread.cwd || '/Users/you';
  elements.threadSource.textContent = formatSource(thread.source);
  elements.threadStatus.textContent = normalizeStatus(thread.status);
  elements.timeline.innerHTML = '';

  if (!thread.turns || thread.turns.length === 0) {
    elements.timeline.innerHTML = '<p class="panel-placeholder">No cached turns for this thread yet.</p>';
  } else {
    thread.turns.forEach((turn) => {
      const article = document.createElement('article');
      article.className = 'turn-card';
      article.innerHTML = `
        <header class="turn-header">
          <span class="turn-badge">${escapeHtml(turn.status || 'inProgress')}</span>
          <span class="turn-id">${escapeHtml(turn.id)}</span>
        </header>
        <div class="turn-items">${turn.items.map(renderItem).join('')}</div>
      `;
      elements.timeline.appendChild(article);
    });
  }

  renderPlanPanel(thread);
  renderDiffPanel(thread);
}

function renderPlanPanel(thread) {
  const latestTurn = [...(thread.turns || [])].reverse().find((turn) => Array.isArray(turn.plan) && turn.plan.length > 0);
  if (!latestTurn) {
    elements.planBody.innerHTML = '<p class="panel-placeholder">No active plan telemetry.</p>';
    return;
  }

  elements.planBody.innerHTML = `
    <p class="plan-explanation">${escapeHtml(latestTurn.planExplanation || 'Latest plan state')}</p>
    <ol class="plan-list">
      ${latestTurn.plan.map((step) => `
        <li class="plan-step ${escapeHtml(step.status || 'pending')}">
          <span>${escapeHtml(step.step || 'Untitled step')}</span>
          <strong>${escapeHtml(step.status || 'pending')}</strong>
        </li>
      `).join('')}
    </ol>
  `;
}

function renderDiffPanel(thread) {
  const latestTurn = [...(thread.turns || [])].reverse().find((turn) => turn.diff);
  if (!latestTurn) {
    elements.diffBody.innerHTML = '<p class="panel-placeholder">No diff emitted yet.</p>';
    return;
  }

  elements.diffBody.innerHTML = `<pre>${escapeHtml(latestTurn.diff)}</pre>`;
}

function renderApprovalPanel() {
  elements.approvalCount.textContent = String(state.pendingApprovals.length);
  if (state.pendingApprovals.length === 0) {
    elements.approvalBody.innerHTML = '<p class="panel-placeholder">No pending approvals.</p>';
    return;
  }

  elements.approvalBody.innerHTML = state.pendingApprovals.map((approval) => `
    <article class="approval-card">
      <header>
        <span class="approval-method">${escapeHtml(approval.method)}</span>
        <strong>${escapeHtml(approval.params.reason || approval.params.command || 'Approval required')}</strong>
      </header>
      ${approval.params.command ? `<pre>${escapeHtml(approval.params.command)}</pre>` : ''}
      <div class="approval-actions">
        ${approvalButtons(approval)}
      </div>
    </article>
  `).join('');

  elements.approvalBody.querySelectorAll('button[data-approval]').forEach((button) => {
    button.addEventListener('click', async () => {
      await respondApproval(button.dataset.approval, button.dataset.decision);
    });
  });
}

function renderItem(item) {
  switch (item.type) {
    case 'userMessage':
      return `
        <div class="message-bubble user">
          <span class="message-label">User</span>
          <p>${escapeHtml(extractUserText(item))}</p>
        </div>
      `;
    case 'agentMessage':
      return `
        <div class="message-bubble agent">
          <span class="message-label">Codex</span>
          <p>${escapeHtml(item.text || '')}</p>
        </div>
      `;
    case 'reasoning':
      return `
        <div class="telemetry-card">
          <span class="message-label">Reasoning</span>
          <p>${escapeHtml((item.summary || []).join(' ') || 'Internal reasoning stream')}</p>
        </div>
      `;
    case 'commandExecution':
      return `
        <div class="terminal-card">
          <header>
            <span class="message-label">Command</span>
            <strong>${escapeHtml(item.command || 'shell')}</strong>
          </header>
          <pre>${escapeHtml(item.aggregatedOutput || '')}</pre>
        </div>
      `;
    case 'fileChange':
      return `
        <div class="diff-card">
          <span class="message-label">File Change</span>
          <p>${escapeHtml((item.changes || []).map((change) => change.path || change.filePath || 'changed file').join(', ') || item.output || 'Patch emitted')}</p>
        </div>
      `;
    default:
      return `
        <div class="telemetry-card">
          <span class="message-label">${escapeHtml(item.type)}</span>
          <p>${escapeHtml(JSON.stringify(item).slice(0, 280))}</p>
        </div>
      `;
  }
}

function getActiveThread() {
  return state.threadDetails.get(state.activeThreadId) || state.threads.find((thread) => thread.id === state.activeThreadId) || null;
}

function extractUserText(item) {
  return (item.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

function formatSource(source) {
  if (!source) {
    return 'codex app-server';
  }
  if (typeof source === 'string') {
    return source;
  }
  return JSON.stringify(source);
}

function sortThreads(threads) {
  return [...threads].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

function clip(text, size) {
  return text.length > size ? `${text.slice(0, size - 3)}...` : text;
}

function dedupeApprovals(approvals) {
  const seen = new Set();
  return approvals.filter((approval) => {
    if (seen.has(approval.id)) {
      return false;
    }
    seen.add(approval.id);
    return true;
  });
}

async function refetchThread(threadId) {
  if (!threadId) {
    return;
  }
  const response = await fetchJson(`/api/threads/${threadId}`);
  state.threadDetails.set(threadId, response.thread);
  renderStage();
}

async function fetchJson(url, requireAuth = true) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  });
  if (response.status === 401) {
    showAuthGate('Enter your password to unlock the bridge.');
    const error = new Error('AUTH_REQUIRED');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (response.status === 401) {
    showAuthGate('Enter your password to unlock the bridge.');
    const error = new Error('AUTH_REQUIRED');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function postPublicJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeStatus(status) {
  if (!status) {
    return 'unknown';
  }
  if (typeof status === 'string') {
    return status;
  }
  if (typeof status === 'object' && status.type) {
    return status.type;
  }
  return 'unknown';
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch((error) => {
        console.error('service worker cleanup failed', error);
      });
  }
}

function approvalButtons(approval) {
  if (approval.method === 'item/permissions/requestApproval') {
    return `
      <button data-approval="${escapeHtml(approval.id)}" data-decision="accept">Allow Turn</button>
      <button data-approval="${escapeHtml(approval.id)}" data-decision="acceptForSession">Allow Session</button>
    `;
  }

  return `
    <button data-approval="${escapeHtml(approval.id)}" data-decision="accept">Approve</button>
    <button data-approval="${escapeHtml(approval.id)}" data-decision="acceptForSession">Allow Session</button>
    <button data-approval="${escapeHtml(approval.id)}" data-decision="decline">Decline</button>
  `;
}

async function submitPassword() {
  const password = elements.authInput.value;
  const confirm = elements.authConfirmInput.value;
  const originalLabel = elements.authButton.textContent;
  elements.authButton.disabled = true;
  elements.authError.textContent = '';
  elements.authButton.textContent = state.auth.mode === 'setup' ? 'Creating...' : 'Unlocking...';

  try {
    let response;
    if (state.auth.mode === 'setup') {
      if (password !== confirm) {
        throw new Error('Passwords do not match.');
      }
      response = await postPublicJson('/api/auth/setup', { password });
      state.auth.configured = true;
      state.auth.mode = 'login';
    } else {
      response = await postPublicJson('/api/auth/login', { password });
    }

    elements.authInput.value = '';
    elements.authConfirmInput.value = '';
    await loadProtectedState();
  } catch (error) {
    if (error.message === 'Password already configured.') {
      state.auth.configured = true;
      state.auth.mode = 'login';
      syncAuthGate();
      showAuthGate('Password is already set. Enter it below to unlock.');
      return;
    }
    showAuthGate(error.message);
  } finally {
    elements.authButton.disabled = false;
    elements.authButton.textContent = originalLabel;
  }
}

function showAuthGate(message = '') {
  if (socket) {
    socket.close();
    socket = null;
  }
  syncAuthGate();
  elements.authGate.hidden = false;
  elements.authError.textContent = message;
  elements.authInput.focus();
}

function hideAuthGate() {
  elements.authGate.hidden = true;
  elements.authError.textContent = '';
}

function syncAuthGate() {
  if (state.auth.mode === 'setup') {
    elements.authTitle.textContent = 'Create your password';
    elements.authCopy.textContent = 'On first load, set the password you want to use for this bridge. It will be stored locally on your Mac as a salted hash.';
    elements.authButton.textContent = 'Create Password';
    elements.authConfirmInput.hidden = false;
  } else {
    elements.authTitle.textContent = 'Enter your password';
    elements.authCopy.textContent = 'Use the password you created on this Mac to unlock the local bridge from your phone or browser.';
    elements.authButton.textContent = 'Unlock Bridge';
    elements.authConfirmInput.hidden = true;
  }
}

function clearSession() {
  return undefined;
}

bootstrap().catch((error) => {
  if (error.code === 'AUTH_REQUIRED') {
    return;
  }
  console.error(error);
  elements.timeline.innerHTML = `<p class="panel-placeholder">${escapeHtml(error.message)}</p>`;
});
