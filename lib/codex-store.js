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

  readFallbackThread(threadId) {
    const indexedThread = this.listIndexedThreads(500).find((thread) => thread.id === threadId);
    const thread = indexedThread || {
      id: threadId,
      name: null,
      preview: threadId,
      ephemeral: false,
      modelProvider: 'openai',
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
      status: 'cached',
      path: null,
      cwd: null,
      cliVersion: '',
      source: 'fallback',
      agentNickname: null,
      agentRole: null,
      turns: []
    };

    const rolloutPath = this.findRolloutPath(threadId);
    if (!rolloutPath) {
      return thread;
    }

    thread.path = rolloutPath;

    try {
      const raw = fs.readFileSync(rolloutPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const turns = [];
      let currentTurn = null;

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

        if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'user_message') {
          currentTurn = {
            id: `fallback-turn-${turns.length + 1}`,
            status: 'completed',
            error: null,
            diff: '',
            plan: [],
            planExplanation: '',
            items: [
              {
                type: 'userMessage',
                id: `fallback-user-${turns.length + 1}`,
                content: [
                  {
                    type: 'text',
                    text: entry.payload.message || '',
                    text_elements: []
                  }
                ]
              }
            ]
          };
          turns.push(currentTurn);
          if (!thread.name && entry.payload.message) {
            thread.name = entry.payload.message.slice(0, 72);
          }
          if (!thread.preview && entry.payload.message) {
            thread.preview = entry.payload.message.slice(0, 120);
          }
          continue;
        }

        if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'agent_message') {
          if (!currentTurn) {
            currentTurn = {
              id: `fallback-turn-${turns.length + 1}`,
              status: 'completed',
              error: null,
              diff: '',
              plan: [],
              planExplanation: '',
              items: []
            };
            turns.push(currentTurn);
          }

          currentTurn.items.push({
            type: 'agentMessage',
            id: `fallback-agent-${turns.length}-${currentTurn.items.length + 1}`,
            text: entry.payload.message || '',
            phase: null
          });
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
}

module.exports = {
  CodexStore
};
