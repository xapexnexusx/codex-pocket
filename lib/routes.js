'use strict';

const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function createRouter({ publicDir, bridge, auth }) {
  return async function route(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/auth/state' && req.method === 'GET') {
      return sendJson(res, 200, {
        configured: auth.isConfigured()
      });
    }

    if (pathname === '/api/auth/setup' && req.method === 'POST') {
      ensureSameOrigin(req);
      const body = await readJsonBody(req);
      let sessionToken;
      try {
        sessionToken = auth.createPassword(body.password || '');
      } catch (error) {
        const statusCode = error.message === 'Password already configured.' ? 409 : 400;
        return sendJson(res, statusCode, { error: error.message });
      }
      return sendJson(res, 201, { sessionToken });
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      ensureSameOrigin(req);
      const body = await readJsonBody(req);
      if (!auth.verifyPassword(body.password || '')) {
        return sendJson(res, 401, { error: 'Incorrect password.' });
      }
      return sendJson(res, 200, { sessionToken: auth.issueSession() });
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      ensureSameOrigin(req);
      auth.revokeSession(readSessionToken(req, url));
      return sendJson(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) {
      if (!isAllowedOrigin(req)) {
        return sendJson(res, 403, { error: 'Forbidden origin.' });
      }
      if (!isAuthorizedRequest(req, auth, url)) {
        return sendJson(res, 401, { error: 'Authentication required.' });
      }
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        ...bridge.getConnectionState(),
        pendingApprovals: bridge.listApprovals().length
      });
    }

    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      return sendJson(res, 200, await bridge.getBootstrap());
    }

    if (pathname === '/api/threads' && req.method === 'GET') {
      return sendJson(res, 200, {
        data: await bridge.listThreads()
      });
    }

    if (pathname === '/api/threads' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const thread = await bridge.startThread(body || {});
      return sendJson(res, 201, { thread });
    }

    if (pathname === '/api/approvals' && req.method === 'GET') {
      return sendJson(res, 200, {
        data: bridge.listApprovals()
      });
    }

    const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (threadMatch && req.method === 'GET') {
      const thread = await bridge.readThread(threadMatch[1]);
      return sendJson(res, 200, { thread });
    }

    const promptMatch = pathname.match(/^\/api\/threads\/([^/]+)\/prompt$/);
    if (promptMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      const turn = await bridge.startTurn(promptMatch[1], body.text || '');
      return sendJson(res, 202, { turn });
    }

    const interruptMatch = pathname.match(/^\/api\/threads\/([^/]+)\/interrupt$/);
    if (interruptMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await bridge.interruptTurn(interruptMatch[1], body.turnId));
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (approvalMatch && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await bridge.respondApproval(approvalMatch[1], body.decision));
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    return sendStatic(publicDir, pathname, res);
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sendStatic(publicDir, pathname, res) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  let resolvedPath = filePath;
  if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
    resolvedPath = path.join(publicDir, 'index.html');
  }

  const ext = path.extname(resolvedPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const body = fs.readFileSync(resolvedPath);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

module.exports = {
  createRouter
};

function isAuthorizedRequest(req, auth, url) {
  return auth.hasSession(readSessionToken(req, url));
}

function readSessionToken(req, url) {
  const headerToken = req.headers['x-codex-pocket-session'];
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = url.searchParams.get('session');
  return headerToken || bearerToken || queryToken || '';
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') {
    return true;
  }
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const expectedOrigin = `${protocol}://${req.headers.host}`;
  return origin === expectedOrigin;
}

function ensureSameOrigin(req) {
  if (!isAllowedOrigin(req)) {
    const error = new Error('Forbidden origin.');
    error.statusCode = 403;
    throw error;
  }
}
