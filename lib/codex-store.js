'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

class CodexStore {
  constructor(options = {}) {
    this.home = options.home || os.homedir();
    this.codexDir = options.codexDir || path.join(this.home, '.codex');
    this.sessionIndexPath = path.join(this.codexDir, 'session_index.jsonl');
    this.globalStatePath = path.join(this.codexDir, '.codex-global-state.json');
    this.sessionsDir = path.join(this.codexDir, 'sessions');
    this.rolloutPathCache = new Map();
  }

  readGlobalState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.globalStatePath, 'utf8'));
      return {
        workspaceRoots: parsed['electron-saved-workspace-roots'] || [],
        pinnedThreadIds: parsed['pinned-thread-ids'] || []
      };
    } catch {
      return {
        workspaceRoots: [],
        pinnedThreadIds: []
      };
    }
  }

  listIndexedThreads(limit = 120) {
    try {
      const raw = fs.readFileSync(this.sessionIndexPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      return lines
        .map((line) => {
          try {
            const entry = JSON.parse(line);
            return {
              id: entry.id,
              name: entry.thread_name || null,
              preview: entry.thread_name || entry.id,
              ephemeral: false,
              modelProvider: 'openai',
              createdAt: this._toUnix(entry.updated_at),
              updatedAt: this._toUnix(entry.updated_at),
              status: 'cached',
              path: null,
              cwd: null,
              cliVersion: '',
              source: 'session_index',
              agentNickname: null,
              agentRole: null,
              turns: []
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse()
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  readFallbackThread(threadId, seedThread = null) {
    const indexedThread = this.listIndexedThreads(500).find((thread) => thread.id === threadId);
    const thread = {
      ...(indexedThread || {}),
      ...(seedThread || {}),
      id: threadId,
      name: (seedThread && seedThread.name) || (indexedThread && indexedThread.name) || null,
      preview: (seedThread && seedThread.preview) || (indexedThread && indexedThread.preview) || threadId,
      ephemeral: Boolean(seedThread && seedThread.ephemeral),
      modelProvider: (seedThread && seedThread.modelProvider) || 'openai',
      createdAt: (seedThread && seedThread.createdAt) || (indexedThread && indexedThread.createdAt) || Math.floor(Date.now() / 1000),
      updatedAt: (seedThread && seedThread.updatedAt) || (indexedThread && indexedThread.updatedAt) || Math.floor(Date.now() / 1000),
      status: (seedThread && seedThread.status) || (indexedThread && indexedThread.status) || 'cached',
      path: (seedThread && seedThread.path) || null,
      cwd: (seedThread && seedThread.cwd) || null,
      cliVersion: (seedThread && seedThread.cliVersion) || '',
      source: (seedThread && seedThread.source) || 'fallback',
      agentNickname: (seedThread && seedThread.agentNickname) || null,
      agentRole: (seedThread && seedThread.agentRole) || null,
      turns: []
    };

    const rolloutPath = thread.path || this.findRolloutPath(threadId);
    if (!rolloutPath) {
      return thread;
    }

    thread.path = rolloutPath;

    try {
      const raw = fs.readFileSync(rolloutPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const turns = [];
      let currentTurn = null;
      const callMap = new Map();

      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        if (entry.type === 'session_meta' && entry.payload) {
          thread.cwd = entry.payload.cwd || thread.cwd;
          thread.cliVersion = entry.payload.cli_version || thread.cliVersion;
          thread.source = entry.payload.source || thread.source;
          thread.agentNickname = entry.payload.agent_nickname || thread.agentNickname;
          thread.agentRole = entry.payload.agent_role || thread.agentRole;
          continue;
        }

        if (entry.type === 'turn_context' && entry.payload) {
          currentTurn = this._ensureTurn(turns, entry.payload.turn_id);
          continue;
        }

        if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'user_message') {
          currentTurn = currentTurn || this._ensureTurn(turns, `fallback-turn-${turns.length + 1}`);
          currentTurn.items.push({
            type: 'userMessage',
            id: `fallback-user-${currentTurn.id}-${currentTurn.items.length + 1}`,
            content: [
              {
                type: 'text',
                text: entry.payload.message || '',
                text_elements: []
              }
            ]
          });
          if (!thread.name && entry.payload.message) {
            thread.name = entry.payload.message.slice(0, 72);
          }
          if ((!thread.preview || thread.preview === thread.id) && entry.payload.message) {
            thread.preview = entry.payload.message.slice(0, 120);
          }
          continue;
        }

        if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'agent_message') {
          currentTurn = currentTurn || this._ensureTurn(turns, `fallback-turn-${turns.length + 1}`);
          currentTurn.items.push({
            type: 'agentMessage',
            id: `fallback-agent-${currentTurn.id}-${currentTurn.items.length + 1}`,
            text: entry.payload.message || '',
            phase: entry.payload.phase || null
          });
          continue;
        }

        if (entry.type !== 'response_item' || !entry.payload) {
          continue;
        }

        if (!currentTurn) {
          continue;
        }
        const payload = entry.payload;

        if (payload.type === 'reasoning') {
          currentTurn.items.push({
            type: 'reasoning',
            id: `reasoning-${currentTurn.id}-${currentTurn.items.length + 1}`,
            summary: Array.isArray(payload.summary) ? payload.summary.map((part) => this._stringifySummary(part)) : [],
            content: []
          });
          continue;
        }

        if (payload.type === 'function_call') {
          const args = this._parseJson(payload.arguments);
          if (payload.name === 'exec_command' || payload.name === 'write_stdin') {
            const id = payload.call_id || `command-${currentTurn.id}-${currentTurn.items.length + 1}`;
            const command = args.cmd || args.chars || payload.name;
            currentTurn.items.push({
              type: 'commandExecution',
              id,
              command,
              cwd: args.workdir || args.cwd || thread.cwd || '',
              processId: args.session_id ? String(args.session_id) : null,
              status: 'completed',
              commandActions: [],
              aggregatedOutput: '',
              exitCode: null,
              durationMs: null
            });
            callMap.set(payload.call_id, { kind: 'commandExecution', itemId: id });
          } else if (payload.name === 'update_plan') {
            currentTurn.plan = Array.isArray(args.plan) ? args.plan : currentTurn.plan;
            currentTurn.planExplanation = args.explanation || currentTurn.planExplanation;
            currentTurn.items.push({
              type: 'plan',
              id: payload.call_id || `plan-${currentTurn.id}-${currentTurn.items.length + 1}`,
              text: args.explanation || 'Plan updated'
            });
            callMap.set(payload.call_id, { kind: 'plan' });
          } else {
            currentTurn.items.push({
              type: 'toolCall',
              id: payload.call_id || `tool-${currentTurn.id}-${currentTurn.items.length + 1}`,
              tool: payload.name || 'tool',
              arguments: typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments || {})
            });
            callMap.set(payload.call_id, { kind: 'toolCall', itemId: payload.call_id });
          }
          continue;
        }

        if (payload.type === 'function_call_output') {
          const meta = callMap.get(payload.call_id);
          const outputText = this._normalizeToolOutput(payload.output);
          if (meta && meta.kind === 'commandExecution') {
            const commandItem = currentTurn.items.find((item) => item.id === meta.itemId);
            if (commandItem) {
              commandItem.aggregatedOutput = `${commandItem.aggregatedOutput || ''}${outputText}`;
            }
          } else if (!meta || meta.kind !== 'plan') {
            currentTurn.items.push({
              type: 'toolResult',
              id: `tool-result-${currentTurn.id}-${currentTurn.items.length + 1}`,
              text: outputText
            });
          }
          continue;
        }

        if (payload.type === 'custom_tool_call') {
          const id = payload.call_id || `custom-${currentTurn.id}-${currentTurn.items.length + 1}`;
          currentTurn.items.push({
            type: 'fileChange',
            id,
            changes: this._extractPatchChanges(payload.input),
            status: payload.status || 'completed',
            output: ''
          });
          callMap.set(payload.call_id, { kind: 'fileChange', itemId: id });
          continue;
        }

        if (payload.type === 'custom_tool_call_output') {
          const meta = callMap.get(payload.call_id);
          const outputText = this._normalizeToolOutput(payload.output);
          if (meta && meta.kind === 'fileChange') {
            const fileItem = currentTurn.items.find((item) => item.id === meta.itemId);
            if (fileItem) {
              fileItem.output = outputText;
            }
          }
          continue;
        }

        if (payload.type === 'web_search_call') {
          currentTurn.items.push({
            type: 'webSearch',
            id: payload.call_id || `search-${currentTurn.id}-${currentTurn.items.length + 1}`,
            query: payload.query || 'web search'
          });
          continue;
        }

      }

      thread.turns = turns.slice(-40);
      return thread;
    } catch {
      return thread;
    }
  }

  findRolloutPath(threadId) {
    if (this.rolloutPathCache.has(threadId)) {
      return this.rolloutPathCache.get(threadId);
    }

    const suffix = `${threadId}.jsonl`;
    const stack = [this.sessionsDir];

    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(suffix)) {
          this.rolloutPathCache.set(threadId, fullPath);
          return fullPath;
        }
      }
    }

    return null;
  }

  _toUnix(value) {
    const millis = Date.parse(value || '');
    if (Number.isFinite(millis) && millis > 0) {
      return Math.floor(millis / 1000);
    }
    return Math.floor(Date.now() / 1000);
  }

  _ensureTurn(turns, turnId) {
    let turn = turns.find((entry) => entry.id === turnId);
    if (!turn) {
      turn = {
        id: turnId,
        status: 'completed',
        error: null,
        diff: '',
        plan: [],
        planExplanation: '',
        items: []
      };
      turns.push(turn);
    }
    return turn;
  }

  _parseJson(value) {
    if (typeof value !== 'string') {
      return value || {};
    }
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  _normalizeToolOutput(output) {
    if (typeof output !== 'string') {
      return JSON.stringify(output || {}, null, 2);
    }
    try {
      const parsed = JSON.parse(output);
      if (typeof parsed.output === 'string') {
        return parsed.output;
      }
      return JSON.stringify(parsed, null, 2);
    } catch {
      return output;
    }
  }

  _extractPatchChanges(patchText) {
    if (typeof patchText !== 'string') {
      return [];
    }
    const changes = [];
    for (const line of patchText.split('\n')) {
      const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
      if (match) {
        changes.push({ path: match[1] });
      }
      const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
      if (moveMatch) {
        changes.push({ path: moveMatch[1] });
      }
    }
    return changes;
  }

  _extractMessageText(contentItems) {
    return contentItems
      .filter((item) => item.type === 'input_text' || item.type === 'output_text' || item.type === 'text')
      .map((item) => item.text || '')
      .join('\n\n')
      .trim();
  }

  _stringifySummary(summary) {
    if (typeof summary === 'string') {
      return summary;
    }
    if (summary && typeof summary.text === 'string') {
      return summary.text;
    }
    return JSON.stringify(summary || '');
  }
}

module.exports = {
  CodexStore
};
