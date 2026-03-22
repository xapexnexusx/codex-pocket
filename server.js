'use strict';

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const { AuthManager } = require('./lib/auth');
const { CodexAppServerBridge } = require('./lib/codex-app-server');
const { createRouter } = require('./lib/routes');

const HOST = process.env.CODEX_POCKET_HOST || '127.0.0.1';
const PORT = Number(process.env.CODEX_POCKET_PORT || 47255);
const WORKSPACE_ROOT = process.env.CODEX_POCKET_WORKSPACE || process.env.HOME || process.cwd();
const PUBLIC_DIR = path.join(__dirname, 'public');

const auth = new AuthManager();
const bridge = new CodexAppServerBridge({ workspaceRoot: WORKSPACE_ROOT });
const router = createRouter({ publicDir: PUBLIC_DIR, bridge, auth });

const server = http.createServer((req, res) => {
  router(req, res).catch((error) => {
    const message = error && error.message ? error.message : 'Unhandled server error';
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: message }));
  });
});

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

bridge.on('event', (event) => {
  if (event.type === 'stderr') {
    console.warn('[codex-pocket]', event.payload.line);
    return;
  }
  broadcast(event);
});

bridge.on('connection', (payload) => {
  broadcast({ type: 'connection', payload });
});

wss.on('connection', (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: 'connection', payload: bridge.getConnectionState() }));
  socket.send(JSON.stringify({
    type: 'snapshot',
    payload: {
      pendingApprovals: bridge.listApprovals()
    }
  }));
  socket.on('close', () => {
    clients.delete(socket);
  });
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  if (!isAuthorizedRequest(request, auth) || !isAllowedOrigin(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

async function start() {
  try {
    await bridge.start();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('[codex-pocket] failed to start Codex bridge:', message);
  }

  server.listen(PORT, HOST, () => {
    console.log(`[codex-pocket] listening on http://${HOST}:${PORT}`);
    if (auth.isConfigured()) {
      console.log('[codex-pocket] password auth is configured.');
    } else {
      console.log('[codex-pocket] first load will prompt to create a password.');
    }
    if (HOST === '127.0.0.1') {
      console.log('[codex-pocket] phone access still requires CODEX_POCKET_HOST=0.0.0.0 or a tailnet/proxy layer.');
    }
  });
}

function shutdown(signal) {
  console.log(`[codex-pocket] shutting down on ${signal}`);
  server.close(() => {
    bridge.stop().finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
  console.error('[codex-pocket] fatal startup error:', error);
  process.exit(1);
});

function isAuthorizedRequest(request, authManager) {
  const url = new URL(request.url || '/', 'http://localhost');
  const headerToken = request.headers['x-codex-pocket-session'];
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = url.searchParams.get('session');
  const token = headerToken || bearerToken || queryToken || '';
  return authManager.hasSession(token);
}

function isAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  const protocol = request.headers['x-forwarded-proto'] || 'http';
  const expectedOrigin = `${protocol}://${request.headers.host}`;
  return origin === expectedOrigin;
}
