const state = {
  threads: [],
  activeThreadId: null,
  threadDetails: new Map(),
  pendingApprovals: [],
  connection: {
    connected: false,
    lastError: null
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
  newThreadButton: document.getElementById('newThreadButton')
};

async function bootstrap() {
  cleanupServiceWorkers();
  bindEvents();
  await loadProtectedState();
}

async function loadProtectedState() {
  const response = await fetchJson('/api/bootstrap');
  state.threads = sortThreads(response.threads || []);
  state.pendingApprovals = response.pendingApprovals || [];
  state.connection = response.connection || state.connection;
  render();

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
    item.aggregatedOutput = (item.aggregatedOutput || '') + (params.delta || '');
  }

  if (method === 'item/fileChange/outputDelta') {
    const turn = ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
    const item = ensureFileChange(turn, params.itemId);
    item.output = (item.output || '') + (params.delta || '');
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

/* ── rendering ── */

function render() {
  renderConnection();
  renderThreads();
  renderStage();
  renderApprovalPanel();
}

function renderConnection() {
  const isLive = state.connection.connected;
  elements.connectionLabel.textContent = isLive ? 'Live' : 'Degraded';
  elements.connectionLabel.className = 'stat-value ' + (isLive ? 'live' : 'degraded');
  elements.approvalCount.textContent = String(state.pendingApprovals.length);
}

function renderThreads() {
  const activeId = state.activeThreadId;
  elements.threadList.textContent = '';

  if (state.threads.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-copy';
    p.textContent = 'No threads surfaced yet.';
    elements.threadList.appendChild(p);
    return;
  }

  for (const thread of state.threads) {
    const status = normalizeStatus(thread.status);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'thread-card' + (thread.id === activeId ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'thread-status ' + status;

    const copy = document.createElement('div');
    copy.className = 'thread-card-copy';

    const title = document.createElement('strong');
    title.textContent = thread.name || clip(thread.preview || thread.id, 68);

    const preview = document.createElement('p');
    preview.textContent = clip(thread.preview || 'No preview', 104);

    const meta = document.createElement('small');
    meta.textContent = thread.cwd || 'Local cache';

    copy.appendChild(title);
    copy.appendChild(preview);
    copy.appendChild(meta);
    card.appendChild(dot);
    card.appendChild(copy);

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
    elements.timeline.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    const ey = document.createElement('p');
    ey.className = 'eyebrow';
    ey.textContent = 'Signal Intake';
    const h = document.createElement('h3');
    h.textContent = 'Select a thread to jack in.';
    empty.appendChild(ey);
    empty.appendChild(h);
    elements.timeline.appendChild(empty);
    elements.planBody.textContent = '';
    appendPlaceholder(elements.planBody, 'No active plan telemetry.');
    elements.diffBody.textContent = '';
    appendPlaceholder(elements.diffBody, 'No diff emitted yet.');
    return;
  }

  elements.threadTitle.textContent = thread.name || clip(thread.preview || thread.id, 96);
  elements.threadWorkspace.textContent = thread.cwd || '/Users/you';
  elements.threadSource.textContent = formatSource(thread.source);
  elements.threadStatus.textContent = normalizeStatus(thread.status);
  elements.timeline.textContent = '';

  if (!thread.turns || thread.turns.length === 0) {
    appendPlaceholder(elements.timeline, 'No cached turns for this thread yet.');
  } else {
    thread.turns.forEach((turn) => {
      const article = document.createElement('article');
      article.className = 'turn-card';

      const header = document.createElement('header');
      header.className = 'turn-header';
      const badge = document.createElement('span');
      badge.className = 'turn-badge';
      badge.textContent = turn.status || 'inProgress';
      const tid = document.createElement('span');
      tid.className = 'turn-id';
      tid.textContent = turn.id;
      header.appendChild(badge);
      header.appendChild(tid);

      const items = document.createElement('div');
      items.className = 'turn-items';
      turn.items.forEach((item) => {
        items.appendChild(renderItemDOM(item));
      });

      article.appendChild(header);
      article.appendChild(items);
      elements.timeline.appendChild(article);
    });
  }

  renderPlanPanel(thread);
  renderDiffPanel(thread);
  requestAnimationFrame(() => {
    elements.timeline.scrollTop = elements.timeline.scrollHeight;
  });
}

function renderItemDOM(item) {
  const wrapper = document.createElement('div');

  switch (item.type) {
    case 'userMessage': {
      wrapper.className = 'message-bubble user';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = 'User';
      const p = document.createElement('p');
      p.textContent = extractUserText(item);
      wrapper.appendChild(label);
      wrapper.appendChild(p);
      break;
    }
    case 'agentMessage': {
      wrapper.className = 'message-bubble agent';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = 'Codex';
      const p = document.createElement('p');
      p.textContent = item.text || '';
      wrapper.appendChild(label);
      wrapper.appendChild(p);
      break;
    }
    case 'reasoning': {
      wrapper.className = 'telemetry-card';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = 'Reasoning';
      const p = document.createElement('p');
      p.textContent = (item.summary || []).join(' ') || 'Internal reasoning stream';
      wrapper.appendChild(label);
      wrapper.appendChild(p);
      break;
    }
    case 'commandExecution': {
      wrapper.className = 'terminal-card';
      const header = document.createElement('header');
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = 'Command';
      const cmd = document.createElement('strong');
      cmd.textContent = item.command || 'shell';
      header.appendChild(label);
      header.appendChild(cmd);
      const pre = document.createElement('pre');
      pre.textContent = item.aggregatedOutput || '';
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
      break;
    }
    case 'fileChange': {
      wrapper.className = 'diff-card';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = 'File Change';
      const p = document.createElement('p');
      p.textContent = (item.changes || []).map((c) => c.path || c.filePath || 'changed file').join(', ') || item.output || 'Patch emitted';
      wrapper.appendChild(label);
      wrapper.appendChild(p);
      break;
    }
    case 'plan': {
      wrapper.className = 'telemetry-card';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = 'Plan';
      const p = document.createElement('p');
      p.textContent = item.text || 'Plan updated';
      wrapper.appendChild(label);
      wrapper.appendChild(p);
      break;
    }
    case 'toolCall': {
      wrapper.className = 'telemetry-card';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = item.tool || 'Tool';
      const p = document.createElement('p');
      p.textContent = clip(item.arguments || '', 280);
      wrapper.appendChild(label);
      wrapper.appendChild(p);
      break;
    }
    case 'toolResult': {
      wrapper.className = 'terminal-card';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = 'Tool Output';
      const pre = document.createElement('pre');
      pre.textContent = item.text || '';
      wrapper.appendChild(label);
      wrapper.appendChild(pre);
      break;
    }
    case 'webSearch': {
      wrapper.className = 'telemetry-card';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = 'Web Search';
      const p = document.createElement('p');
      p.textContent = item.query || '';
      wrapper.appendChild(label);
      wrapper.appendChild(p);
      break;
    }
    case 'contextCompaction': {
      wrapper.className = 'telemetry-card';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = 'Context';
      const p = document.createElement('p');
      p.textContent = 'Thread context compacted.';
      wrapper.appendChild(label);
      wrapper.appendChild(p);
      break;
    }
    default: {
      wrapper.className = 'telemetry-card';
      const label = document.createElement('span');
      label.className = 'message-label';
      label.textContent = item.type;
      const p = document.createElement('p');
      p.textContent = JSON.stringify(item).slice(0, 280);
      wrapper.appendChild(label);
      wrapper.appendChild(p);
      break;
    }
  }

  return wrapper;
}

function renderPlanPanel(thread) {
  const latestTurn = [...(thread.turns || [])].reverse().find((turn) => Array.isArray(turn.plan) && turn.plan.length > 0);
  elements.planBody.textContent = '';
  if (!latestTurn) {
    appendPlaceholder(elements.planBody, 'No active plan telemetry.');
    return;
  }

  const explanation = document.createElement('p');
  explanation.className = 'plan-explanation';
  explanation.textContent = latestTurn.planExplanation || 'Latest plan state';
  elements.planBody.appendChild(explanation);

  const ol = document.createElement('ol');
  ol.className = 'plan-list';
  latestTurn.plan.forEach((step) => {
    const li = document.createElement('li');
    li.className = 'plan-step ' + (step.status || 'pending');
    const span = document.createElement('span');
    span.textContent = step.step || 'Untitled step';
    const strong = document.createElement('strong');
    strong.textContent = step.status || 'pending';
    li.appendChild(span);
    li.appendChild(strong);
    ol.appendChild(li);
  });
  elements.planBody.appendChild(ol);
}

function renderDiffPanel(thread) {
  const latestTurn = [...(thread.turns || [])].reverse().find((turn) => turn.diff);
  elements.diffBody.textContent = '';
  if (!latestTurn) {
    appendPlaceholder(elements.diffBody, 'No diff emitted yet.');
    return;
  }

  const pre = document.createElement('pre');
  pre.textContent = latestTurn.diff;
  elements.diffBody.appendChild(pre);
}

function renderApprovalPanel() {
  elements.approvalCount.textContent = String(state.pendingApprovals.length);
  elements.approvalBody.textContent = '';

  if (state.pendingApprovals.length === 0) {
    appendPlaceholder(elements.approvalBody, 'No pending approvals.');
    return;
  }

  state.pendingApprovals.forEach((approval) => {
    const article = document.createElement('article');
    article.className = 'approval-card';

    const header = document.createElement('header');
    const method = document.createElement('span');
    method.className = 'approval-method';
    method.textContent = approval.method;
    const strong = document.createElement('strong');
    strong.textContent = approval.params.reason || approval.params.command || 'Approval required';
    header.appendChild(method);
    header.appendChild(strong);
    article.appendChild(header);

    if (approval.params.command) {
      const pre = document.createElement('pre');
      pre.textContent = approval.params.command;
      article.appendChild(pre);
    }

    const actions = document.createElement('div');
    actions.className = 'approval-actions';

    const buttons = approval.method === 'item/permissions/requestApproval'
      ? [['accept', 'Allow Turn'], ['acceptForSession', 'Allow Session']]
      : [['accept', 'Approve'], ['acceptForSession', 'Allow Session'], ['decline', 'Decline']];

    buttons.forEach(([decision, label]) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => respondApproval(approval.id, decision));
      actions.appendChild(btn);
    });

    article.appendChild(actions);
    elements.approvalBody.appendChild(article);
  });
}

function appendPlaceholder(parent, text) {
  const p = document.createElement('p');
  p.className = 'panel-placeholder';
  p.textContent = text;
  parent.appendChild(p);
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
  return text.length > size ? text.slice(0, size - 3) + '...' : text;
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
  const response = await fetchJson('/api/threads/' + threadId);
  state.threadDetails.set(threadId, response.thread);
  renderStage();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json'
    }
  });
  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!response.ok) {
    throw new Error('Request failed: ' + response.status);
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
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!response.ok) {
    throw new Error('Request failed: ' + response.status);
  }
  return response.json();
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

function cleanupServiceWorkers() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch((error) => {
        console.error('service worker cleanup failed', error);
      });
  }
}

bootstrap().catch((error) => {
  console.error(error);
  const p = document.createElement('p');
  p.className = 'panel-placeholder';
  p.textContent = error.message;
  elements.timeline.textContent = '';
  elements.timeline.appendChild(p);
});
