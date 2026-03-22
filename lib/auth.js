'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

class AuthManager {
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(process.env.HOME || os.homedir(), '.codex-pocket');
    this.authPath = path.join(this.baseDir, 'auth.json');
    this.sessions = new Map();
    this.authRecord = this._load();
  }

  isConfigured() {
    return Boolean(this.authRecord && this.authRecord.passwordHash && this.authRecord.salt);
  }

  createPassword(password) {
    this._assertValidPassword(password);
    if (this.isConfigured()) {
      throw new Error('Password already configured.');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = this._hashPassword(password, salt);
    this.authRecord = {
      salt,
      passwordHash,
      createdAt: new Date().toISOString()
    };
    this._save();
    return this.issueSession();
  }

  verifyPassword(password) {
    if (!this.isConfigured()) {
      throw new Error('Password is not configured.');
    }

    const candidate = Buffer.from(this._hashPassword(password, this.authRecord.salt), 'hex');
    const stored = Buffer.from(this.authRecord.passwordHash, 'hex');
    if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) {
      return false;
    }

    return true;
  }

  issueSession() {
    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(token, { createdAt: Date.now() });
    return token;
  }

  hasSession(token) {
    return Boolean(token) && this.sessions.has(token);
  }

  revokeSession(token) {
    if (token) {
      this.sessions.delete(token);
    }
  }

  _assertValidPassword(password) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }
  }

  _hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.authPath, 'utf8'));
    } catch {
      return null;
    }
  }

  _save() {
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.authPath, `${JSON.stringify(this.authRecord, null, 2)}\n`, { mode: 0o600 });
  }
}

module.exports = {
  AuthManager
};
