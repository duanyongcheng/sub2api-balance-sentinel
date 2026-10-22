import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { decryptAccountSecret } from './account-secrets.js';

const PASSWORD_PREFIX = 'scrypt';
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 1024;
const MAX_ATTEMPT_KEYS = 10_000;
const scrypt = promisify(crypto.scrypt);
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Password hashing and cookie-session handling live in this module so the
 * credential material stays transient during login, enrollment, and step-up.
 * Passwords are stored as an encoded scrypt hash; sessions are represented by
 * random bearer tokens whose SHA-256 digest is the only value persisted.
 */
export function hashPassword(password) {
  assertPassword(password);
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * 1024 * 1024,
  });
  return encodePasswordHash(salt, derived);
}

export async function hashPasswordAsync(password) {
  assertPassword(password);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024,
  });
  return encodePasswordHash(salt, derived);
}

function encodePasswordHash(salt, derived) {
  return [
    PASSWORD_PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join(':');
}

export function isPasswordHash(value) {
  return typeof value === 'string' && parseHash(value) !== null;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  try {
    const actual = await scrypt(password, parsed.salt, parsed.key.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: 128 * 1024 * 1024,
    });
    return actual.length === parsed.key.length && crypto.timingSafeEqual(actual, parsed.key);
  } catch {
    return false;
  }
}

function parseHash(encoded) {
  if (typeof encoded !== 'string') return null;
  const parts = encoded.split(':');
  if (parts.length !== 6 || parts[0] !== PASSWORD_PREFIX) return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || n < (1 << 14) || n > (1 << 20) || (n & (n - 1)) !== 0 ||
      !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const key = Buffer.from(parts[5], 'base64url');
    if (salt.length < 16 || key.length < 32) return null;
    return { n, r, p, salt, key };
  } catch {
    return null;
  }
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('Password must contain 12 to 1024 characters');
  }
}

export function normalizeUsername(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._@-]{3,128}$/.test(value) ? value.toLowerCase() : null;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function generateTotpSecret() {
  const input = crypto.randomBytes(20);
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32[(value << (5 - bits)) & 31];
  return result;
}

export function totpCode(secret, counter) {
  const key = decodeBase32(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

export function verifyTotpCode(secret, code, now = Date.now(), lastCounter = -1) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const currentCounter = Math.floor(now / 30_000);
  let matched = null;
  for (const candidate of [currentCounter - 1, currentCounter, currentCounter + 1]) {
    if (candidate <= lastCounter || candidate < 0) continue;
    const expected = Buffer.from(totpCode(secret, candidate));
    const supplied = Buffer.from(String(code));
    if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) matched = candidate;
  }
  return matched;
}

function decodeBase32(secret) {
  const normalized = String(secret || '').replace(/\s|=/g, '').toUpperCase();
  if (normalized.length < 26 || !/^[A-Z2-7]+$/.test(normalized)) throw new Error('Invalid TOTP secret');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of normalized) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export class AuthManager {
  constructor({ store, username, passwordHash, requireTotp = false, totpSecret, accountKey = '', sessionTtlMs, idleTimeoutMs, maxLoginAttempts, loginWindowMs, logger = console }) {
    this.store = store;
    this.username = username;
    this.passwordHash = passwordHash;
    this.requireTotp = requireTotp;
    this.totpSecret = totpSecret;
    this.accountKey = accountKey;
    this.sessionTtlMs = sessionTtlMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxLoginAttempts = maxLoginAttempts;
    this.loginWindowMs = loginWindowMs;
    this.logger = logger;
    this.attempts = new Map();
    this.activeChecks = 0;
    if (normalizeUsername(username) && this.store.findAuthAccount?.(normalizeUsername(username))) {
      throw new Error('The bootstrap administrator username conflicts with a managed account');
    }
    // A process restart (including a password-hash rotation) invalidates all
    // browser sessions so a stolen pre-restart cookie cannot remain usable.
    this.store.revokeAllAuthSessions?.();
  }

  async login(username, password, otp, context = {}) {
    const principal = await this.checkCredentials(username, password, otp, context, 'login');
    if (!principal.ok) return principal;
    const now = Date.now();
    const token = newToken();
    const csrfToken = newToken(24);
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.sessionTtlMs).toISOString();
    this.store.purgeAuthSessions(createdAt);
    const id = this.store.createAuthSession({
      tokenHash: sha256(token), csrfHash: sha256(csrfToken), username: principal.username,
      accountId: principal.accountId, accountVersion: principal.accountVersion,
      createdAt, expiresAt, ip: context.ip || null,
      userAgent: context.userAgent ? String(context.userAgent).slice(0, 512) : null,
    });
    this.store.log('info', 'auth_login', 'login succeeded', null, principal.username);
    return { ok: true, id, token, csrfToken, username: principal.username, role: principal.role, bootstrap: !principal.accountId, expiresAt };
  }

  async checkCredentials(username, password, otp, context, operation) {
    const key = operation === 'login' ? context.ip || 'unknown' : `${operation}:${context.ip || 'unknown'}:${normalizeUsername(username) || 'invalid'}`;
    const now = Date.now();
    if (this.activeChecks >= 2) return { ok: false, rateLimited: true };
    let rateAllowed = true;
    if (this.store.consumeLoginAttempt) {
      rateAllowed = this.store.consumeLoginAttempt(sha256(key), now, this.loginWindowMs, this.maxLoginAttempts);
    } else {
      const recent = (this.attempts.get(key) || []).filter((at) => now - at < this.loginWindowMs);
      rateAllowed = recent.length < this.maxLoginAttempts;
      recent.push(now);
      this.attempts.set(key, recent);
      if (this.attempts.size > MAX_ATTEMPT_KEYS) {
        for (const [candidate, timestamps] of this.attempts) {
          if (timestamps.every((at) => now - at >= this.loginWindowMs)) this.attempts.delete(candidate);
        }
        while (this.attempts.size > MAX_ATTEMPT_KEYS) this.attempts.delete(this.attempts.keys().next().value);
      }
    }
    if (!rateAllowed) return { ok: false, rateLimited: true };

    const normalized = normalizeUsername(username);
    const bootstrap = Boolean(normalized && normalized === normalizeUsername(this.username));
    const account = !bootstrap && normalized ? this.store.findAuthAccount?.(normalized) : null;
    const validUser = bootstrap || Boolean(account?.enabled && account.enrolled_at && ['admin', 'operator', 'auditor'].includes(account.role));
    const passwordAttemptKey = sha256(`password:${normalized || 'invalid'}`);
    if (!this.requireTotp && this.store.consumeLoginAttempt &&
        !this.store.consumeLoginAttempt(passwordAttemptKey, now, this.loginWindowMs, this.maxLoginAttempts)) {
      return { ok: false, rateLimited: true };
    }
    this.activeChecks += 1;
    let validPassword;
    let matchedCounter = null;
    try {
      // Always verify a hash, even for an unknown username, to reduce timing
      // differences that would otherwise disclose the configured username.
      validPassword = await verifyPassword(password, account && validUser ? account.password_hash : this.passwordHash);
      if (this.requireTotp) {
        try {
          const secret = bootstrap ? this.totpSecret : account && validUser ? decryptAccountSecret(account.totp_ciphertext, account.id, this.accountKey) : this.totpSecret;
          const previousCounter = bootstrap ? this.store.lastTotpCounter() : account?.last_totp_counter ?? -1;
          matchedCounter = verifyTotpCode(secret, otp, Date.now(), previousCounter);
        } catch { /* Invalid or unavailable secrets must fail closed. */ }
      }
    } finally {
      this.activeChecks -= 1;
    }
    const mfaAttemptKey = sha256(`mfa:${bootstrap ? this.username : account?.id || 'invalid'}`);
    if (this.requireTotp && validUser && validPassword && this.store.consumeLoginAttempt &&
        !this.store.consumeLoginAttempt(mfaAttemptKey, Date.now(), this.loginWindowMs, this.maxLoginAttempts)) {
      return { ok: false, rateLimited: true };
    }
    if (!validUser || !validPassword || (this.requireTotp && matchedCounter === null)) {
      this.store.log('warn', `auth_${operation}_failed`, 'credentials rejected');
      return { ok: false, rateLimited: false };
    }
    const current = account ? this.store.getAuthAccount(account.id) : null;
    const consumed = this.requireTotp
      ? bootstrap ? this.store.consumeTotpCounter(matchedCounter) : this.store.consumeAccountTotp(account.id, account.credential_version, matchedCounter)
      : bootstrap || Boolean(current?.enabled && current.enrolled_at && current.credential_version === account.credential_version);
    if (!consumed) {
      this.store.log('warn', `auth_${operation}_failed`, 'credentials rejected');
      return { ok: false, rateLimited: false };
    }

    this.store.clearLoginAttempts?.(sha256(key));
    this.store.clearLoginAttempts?.(mfaAttemptKey);
    if (!this.requireTotp) this.store.clearLoginAttempts?.(passwordAttemptKey);
    this.attempts.delete(key);
    return {
      ok: true, username: bootstrap ? this.username : account.username,
      role: bootstrap ? 'admin' : account.role, accountId: account?.id ?? null,
      accountVersion: account?.credential_version ?? null,
    };
  }

  authenticate(token) {
    if (!token || typeof token !== 'string' || token.length > 256) return null;
    const session = this.store.getAuthSession(sha256(token));
    if (!session) return null;
    const principal = this.principalForSession(session);
    if (!principal) { this.store.revokeAuthSession(session.id); return null; }
    const now = Date.now();
    // Avoid a write on every request while still extending activity promptly.
    if (now - Date.parse(session.last_seen_at || session.created_at) > 60_000) this.store.touchAuthSession(session.id, new Date(now).toISOString());
    return { ...session, ...principal, expiresAt: session.expires_at, csrfHash: session.csrf_hash };
  }

  principalForSession(session) {
    const now = Date.now();
    const expires = Date.parse(session.expires_at);
    const lastSeen = Date.parse(session.last_seen_at || session.created_at);
    if (session.revoked_at || !Number.isFinite(expires) || expires <= now || !Number.isFinite(lastSeen) || now - lastSeen > this.idleTimeoutMs) {
      return null;
    }
    if (!session.account_id) {
      return session.username === this.username ? { role: 'admin', bootstrap: true } : null;
    }
    const account = this.store.getAuthAccount(session.account_id);
    if (!account?.enabled || !account.enrolled_at || account.credential_version !== session.account_version ||
        account.username !== session.username || !['admin', 'operator', 'auditor'].includes(account.role)) return null;
    return { role: account.role, bootstrap: false };
  }

  isCurrentPrincipal(session, requiredRole = null) {
    if (!session) return false;
    const stored = this.store.getAuthSessionById?.(session.id) ?? this.store.getAuthSession(session.token_hash);
    if (!stored) return false;
    const principal = this.principalForSession(stored);
    return Boolean(principal && (!requiredRole || (Array.isArray(requiredRole) ? requiredRole.includes(principal.role) : principal.role === requiredRole)));
  }

  async verifyStepUp(session, password, otp, context = {}) {
    if (!this.isCurrentPrincipal(session)) return { ok: false, rateLimited: false };
    const result = await this.checkCredentials(session.username, password, otp, context, 'stepup');
    if (!result.ok) return result;
    if (result.accountId !== (session.account_id ?? null) || result.accountVersion !== (session.account_version ?? null) || !this.isCurrentPrincipal(session)) {
      return { ok: false, rateLimited: false };
    }
    return { ok: true };
  }

  verifyCsrf(session, token) {
    if (!session || typeof token !== 'string' || token.length > 256) return false;
    const actual = Buffer.from(sha256(token), 'hex');
    const expected = Buffer.from(session.csrf_hash || '', 'hex');
    return actual.length === expected.length && expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  }

  rotateCsrf(session) {
    const token = newToken(24);
    this.store.rotateAuthCsrf(session.id, sha256(token));
    return token;
  }

  logout(session) {
    if (!session) return;
    this.store.revokeAuthSession(session.id);
    this.store.log('info', 'auth_logout', 'logout succeeded', null, session.username);
  }

  purgeExpired() {
    return this.store.purgeAuthSessions(new Date().toISOString());
  }
}

export function parseCookies(header) {
  const out = {};
  for (const piece of String(header || '').split(';')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key) out[key] = key in out ? '' : decodeCookie(value);
  }
  return out;
}

function decodeCookie(value) {
  try { return decodeURIComponent(value); } catch { return ''; }
}

export function cookieValue(value) {
  return encodeURIComponent(String(value));
}
