'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { CodexStore } = require('./codex-store');

class CodexAppServerBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.home = options.home || os.homedir();
    this.codexPath = options.codexPath || 'codex';
    this.store = new CodexStore({ home: this.home });

    this.child = null;
    this.connected = false;
    this.startPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.pendingApprovals = new Map();
    this.threadCache = new Map();
    this.activeTurns = new Map();
    this.lastError = null;
  }

  getConnectionState() {
    return {
      connected: this.connected,
      lastError: this.lastError,
      workspaceRoot: this.workspaceRoot
    };
  }

  async start() {
    if (this.connected) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this._spawnAndInitialize().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop() {
    if (!this.child) {
      return;
    }

    this.child.kill('SIGTERM');
    this.child = null;
    this.connected = false;
  }

  listApprovals() {
    return Array.from(this.pendingApprovals.values()).sort((left, right) => right.createdAt - left.createdAt);
  }

  async listThreads(options = {}) {
    const limit = Number(options.limit || 80);
    try {
      const response = await this._request('thread/list', {
        limit,
        archived: false,
        cwd: this.workspaceRoot
      });
      const threads = (response.data || [])
        .filter((thread) => !thread.ephemeral)
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
        .map((thread) => this._mergeThread(thread));
      return threads;
    } catch (error) {
      this.lastError = error.message;
      return this.store.listIndexedThreads(limit);
    }
  }

  async readThread(threadId) {
    try {
      const response = await this._request('thread/read', {
        threadId,
        includeTurns: true
      });
      const merged = this._mergeThread(response.thread);
      return this.store.readFallbackThread(threadId, merged);
    } catch (error) {
      this.lastError = error.message;
      return this.store.readFallbackThread(threadId);
    }
  }

  async startThread(options = {}) {
    const response = await this._request('thread/start', {
      cwd: options.cwd || this.workspaceRoot,
      ephemeral: Boolean(options.ephemeral),
      approvalPolicy: options.approvalPolicy || 'on-request',
      sandbox: options.sandbox || 'workspace-write',
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    return this._mergeThread(response.thread);
  }

  async startTurn(threadId, text) {
    if (!text || !text.trim()) {
      throw new Error('Prompt text is required.');
    }

    const response = await this._request('turn/start', {
      threadId,
      approvalPolicy: 'on-request',
      input: [
        {
          type: 'text',
          text: text.trim(),
          text_elements: []
        }
      ]
    });
    return response.turn;
  }

  async interruptTurn(threadId, turnId) {
    const resolvedTurnId = turnId || this.activeTurns.get(threadId);
    if (!resolvedTurnId) {
      throw new Error('No active turn found for this thread.');
    }
    await this._request('turn/interrupt', {
      threadId,
      turnId: resolvedTurnId
    });
    return { ok: true };
  }

  async respondApproval(requestId, decision) {
    const approval = this.pendingApprovals.get(String(requestId));
    if (!approval) {
      throw new Error('Approval request not found.');
    }

    let result;

    if (approval.method === 'item/commandExecution/requestApproval') {
      result = {
        decision: this._normalizeCommandDecision(decision)
      };
    } else if (approval.method === 'item/fileChange/requestApproval') {
      result = {
        decision: this._normalizeFileDecision(decision)
      };
    } else if (approval.method === 'item/permissions/requestApproval') {
      if (decision !== 'accept' && decision !== 'acceptForSession') {
        throw new Error('Permission requests only support allow-for-turn or allow-for-session.');
      }
      result = {
        permissions: approval.params.permissions,
        scope: decision === 'acceptForSession' ? 'session' : 'turn'
      };
    } else if (approval.method === 'execCommandApproval' || approval.method === 'applyPatchApproval') {
      result = {
        decision: this._normalizeLegacyReviewDecision(decision)
      };
    } else {
      throw new Error(`Unsupported approval method: ${approval.method}`);
    }

    this._sendResult(approval.id, result);
    this.pendingApprovals.delete(String(requestId));
    this.emit('event', {
      type: 'approval-resolved',
      payload: {
        id: String(requestId)
      }
    });

    return { ok: true };
  }

  async getBootstrap() {
    const threads = await this.listThreads();
    const globalState = this.store.readGlobalState();
    return {
      threads,
      pendingApprovals: this.listApprovals(),
      connection: this.getConnectionState(),
      globalState
    };
  }

  async _spawnAndInitialize() {
    this.child = spawn(this.codexPath, ['app-server'], {
      cwd: this.workspaceRoot,
      env: {
        ...process.env,
        HOME: this.home
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    const stdoutReader = readline.createInterface({ input: this.child.stdout });
    stdoutReader.on('line', (line) => this._handleLine(line));

    this.child.stderr.on('data', (chunk) => {
      const line = chunk.toString().trim();
      if (!line) {
        return;
      }
      this.emit('event', {
        type: 'stderr',
        payload: {
          line
        }
      });
    });

    this.child.on('exit', (code, signal) => {
      this.connected = false;
      this.lastError = `codex app-server exited (${code === null ? signal : code})`;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(this.lastError));
      }
      this.pending.clear();
      this.emit('connection', this.getConnectionState());
    });

    await this._requestRaw('initialize', {
      clientInfo: {
        name: 'codex-pocket',
        title: 'Codex Pocket',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.connected = true;
    this.lastError = null;
    this.emit('connection', this.getConnectionState());
  }

  async _request(method, params, timeoutMs = 30000) {
    await this.start();
    return this._requestRaw(method, params, timeoutMs);
  }

  _requestRaw(method, params, timeoutMs = 30000) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('codex app-server is not available');
    }

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer
      });

      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  _sendResult(id, result) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('codex app-server is not writable');
    }
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  _handleLine(line) {
    if (!line || !line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') &&
        (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'Unknown app-server error'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
      this._handleServerRequest(message);
      return;
    }

    if (message.method) {
      this._handleNotification(message);
    }
  }

  _handleServerRequest(message) {
    const payload = {
      id: String(message.id),
      method: message.method,
      params: message.params || {},
      createdAt: Date.now()
    };
    this.pendingApprovals.set(payload.id, payload);
    this.emit('event', {
      type: 'server-request',
      payload
    });
  }

  _handleNotification(message) {
    this._applyNotification(message);
    this.emit('event', {
      type: 'notification',
      payload: message
    });
  }

  _applyNotification(message) {
    const { method, params = {} } = message;

    switch (method) {
      case 'thread/started':
        if (params.thread) {
          this._mergeThread(params.thread);
        }
        break;
      case 'thread/status/changed':
        this._mutateThread(params.threadId, (thread) => {
          thread.status = params.status;
        });
        break;
      case 'thread/name/updated':
        this._mutateThread(params.threadId, (thread) => {
          thread.name = params.name;
        });
        break;
      case 'turn/started': {
        const turn = this._ensureTurn(params.threadId, params.turn);
        turn.status = params.turn.status;
        this.activeTurns.set(params.threadId, params.turn.id);
        break;
      }
      case 'turn/completed': {
        const turn = this._ensureTurn(params.threadId, params.turn);
        turn.status = params.turn.status;
        turn.error = params.turn.error || null;
        this.activeTurns.delete(params.threadId);
        break;
      }
      case 'item/started': {
        const turn = this._ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
        this._upsertItem(turn, params.item);
        break;
      }
      case 'item/completed': {
        const turn = this._ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
        this._upsertItem(turn, params.item);
        break;
      }
      case 'item/agentMessage/delta': {
        const turn = this._ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
        const item = this._ensureMessageItem(turn, params.itemId);
        item.text += params.delta || '';
        break;
      }
      case 'item/commandExecution/outputDelta': {
        const turn = this._ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
        const item = this._ensureCommandItem(turn, params.itemId);
        item.aggregatedOutput = `${item.aggregatedOutput || ''}${params.delta || ''}`;
        break;
      }
      case 'item/fileChange/outputDelta': {
        const turn = this._ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
        const item = this._ensureFileChangeItem(turn, params.itemId);
        item.output = `${item.output || ''}${params.delta || ''}`;
        break;
      }
      case 'turn/diff/updated': {
        const turn = this._ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
        turn.diff = params.diff || '';
        break;
      }
      case 'turn/plan/updated': {
        const turn = this._ensureTurn(params.threadId, { id: params.turnId, items: [], status: 'inProgress', error: null });
        turn.plan = params.plan || [];
        turn.planExplanation = params.explanation || '';
        break;
      }
      case 'serverRequest/resolved':
        this.pendingApprovals.delete(String(params.requestId));
        break;
      default:
        break;
    }
  }

  _mergeThread(thread) {
    const existing = this.threadCache.get(thread.id) || {
      turns: []
    };
    const merged = {
      ...existing,
      ...thread,
      turns: Array.isArray(thread.turns) && thread.turns.length > 0 ? thread.turns.map((turn) => this._normalizeTurn(turn)) : existing.turns || []
    };
    this.threadCache.set(merged.id, merged);
    return merged;
  }

  _mutateThread(threadId, updater) {
    const thread = this.threadCache.get(threadId) || {
      id: threadId,
      name: null,
      preview: threadId,
      turns: [],
      status: 'unknown',
      updatedAt: Math.floor(Date.now() / 1000)
    };
    updater(thread);
    thread.updatedAt = Math.floor(Date.now() / 1000);
    this.threadCache.set(threadId, thread);
  }

  _ensureTurn(threadId, turn) {
    let thread = this.threadCache.get(threadId);
    if (!thread) {
      thread = {
        id: threadId,
        name: null,
        preview: threadId,
        turns: [],
        status: 'active',
        updatedAt: Math.floor(Date.now() / 1000)
      };
      this.threadCache.set(threadId, thread);
    }

    let existing = thread.turns.find((candidate) => candidate.id === turn.id);
    if (!existing) {
      existing = this._normalizeTurn(turn);
      thread.turns.push(existing);
    } else {
      Object.assign(existing, this._normalizeTurn(turn), {
        items: existing.items || []
      });
    }

    thread.updatedAt = Math.floor(Date.now() / 1000);
    return existing;
  }

  _normalizeTurn(turn) {
    return {
      id: turn.id,
      items: Array.isArray(turn.items) ? turn.items.map((item) => ({ ...item })) : [],
      status: turn.status || 'inProgress',
      error: turn.error || null,
      diff: turn.diff || '',
      plan: turn.plan || [],
      planExplanation: turn.planExplanation || ''
    };
  }

  _upsertItem(turn, item) {
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index === -1) {
      turn.items.push({ ...item });
      return;
    }
    turn.items[index] = {
      ...turn.items[index],
      ...item
    };
  }

  _ensureMessageItem(turn, itemId) {
    let item = turn.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      item = {
        type: 'agentMessage',
        id: itemId,
        text: '',
        phase: null
      };
      turn.items.push(item);
    }
    return item;
  }

  _ensureCommandItem(turn, itemId) {
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
        aggregatedOutput: '',
        exitCode: null,
        durationMs: null
      };
      turn.items.push(item);
    }
    return item;
  }

  _ensureFileChangeItem(turn, itemId) {
    let item = turn.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      item = {
        type: 'fileChange',
        id: itemId,
        changes: [],
        status: 'inProgress',
        output: ''
      };
      turn.items.push(item);
    }
    return item;
  }

  _normalizeCommandDecision(decision) {
    const allowed = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
    return allowed.has(decision) ? decision : 'accept';
  }

  _normalizeFileDecision(decision) {
    const allowed = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
    return allowed.has(decision) ? decision : 'accept';
  }

  _normalizeLegacyReviewDecision(decision) {
    switch (decision) {
      case 'acceptForSession':
        return 'approved_for_session';
      case 'decline':
        return 'denied';
      case 'cancel':
        return 'abort';
      case 'accept':
      default:
        return 'approved';
    }
  }
}

module.exports = {
  CodexAppServerBridge
};
