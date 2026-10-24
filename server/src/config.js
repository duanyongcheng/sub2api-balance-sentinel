import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { isPasswordHash } from './lib/auth.js';
import { isAccountKey } from './lib/account-secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');

/**
 * Minimal .env loader. We deliberately do NOT use dotenv: the fewer
 * dependencies touch the admin key, the smaller the supply-chain surface.
 * Values already present in process.env always win.
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

function boundedNum(name, fallback, min, max, integer = false) {
  const value = num(name, fallback);
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return value;
}

function bool(name, fallback, strict = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (strict && !['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'].includes(String(raw).toLowerCase())) {
    throw new Error(`${name} must be a boolean`);
  }
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function text(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined ? fallback : String(raw).trim();
}

/**
 * Read a credential from an environment variable or a mounted secret file.
 * Docker/Kubernetes commonly expose secrets as files so they do not appear in
 * process listings or ordinary environment dumps. A single trailing newline
 * is ignored because secret files are often created with POSIX text tools.
 */
function secretText(name, fallback = '') {
  const file = text(`${name}_FILE`);
  const value = text(name);
  if (file && value) {
    throw new Error(`${name} and ${name}_FILE must not both be set`);
  }
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '').trim();
    } catch {
      throw new Error(`${name}_FILE could not be read`);
    }
  }
  return value || fallback;
}

function isLoopbackHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

const baseUrl = (process.env.SUB2API_BASE_URL || '').trim().replace(/\/+$/, '');
const adminKey = secretText('SUB2API_ADMIN_API_KEY');
const requireTotp = bool('AUTH_REQUIRE_TOTP', false, true);

export const config = {
  // Where the sub2api deployment lives, e.g. http://127.0.0.1:8080
  baseUrl,
  instanceId: text('SENTINEL_INSTANCE_ID'),
  adminKey,
  dbPath: process.env.SENTINEL_DB_PATH || path.join(ROOT, 'data', 'sentinel.db'),

  server: {
    port: boundedNum('PORT', 7788, 1, 65_535, true),
    // Bind loopback by default. This process holds a full-admin credential,
    // so exposing it on 0.0.0.0 would hand the whole sub2api instance to the network.
    // In Docker this is overridden to 0.0.0.0 (the compose file publishes the
    // port on the host loopback only).
    host: process.env.HOST || '127.0.0.1',
    // Extra Host headers to accept, for reverse-proxy deployments, e.g.
    // ALLOWED_HOSTS=sentinel.example.com,10.0.0.5:7788
    allowedHosts: (process.env.ALLOWED_HOSTS || '').trim(),
    // Host port(s) published by docker-compose, when they differ from PORT.
    // Set by the compose file; rarely needed by hand.
    publishedPorts: (process.env.PUBLISHED_PORTS || '').trim(),
  },

  monitor: {
    enabled: bool('MONITOR_ENABLED', true),
    intervalMs: boundedNum('MONITOR_INTERVAL_MS', 60_000, 10_000, 86_400_000, true),
    // Global kill switch for the *writing* half. When false the sentinel still
    // observes and records, but never mutates a balance.
    autoTopUpEnabled: bool('AUTO_TOPUP_ENABLED', false),
  },

  guard: {
    // Hard ceilings that apply to every user, regardless of per-user settings.
    // They exist so a misconfiguration or a runaway loop cannot drain your wallet.
    maxTopUpAmountPerEvent: boundedNum('GUARD_MAX_TOPUP_PER_EVENT', 100, 0.01, 1_000_000),
    maxTopUpsPerUserPerDay: boundedNum('GUARD_MAX_TOPUPS_PER_USER_PER_DAY', 5, 1, 100, true),
    maxTopUpTotalPerDay: boundedNum('GUARD_MAX_TOPUP_TOTAL_PER_DAY', 1000, 0.01, 100_000_000),
    // If this many top-ups fail in a row, stop writing and require a human.
    circuitBreakerFailures: boundedNum('GUARD_CIRCUIT_BREAKER_FAILURES', 3, 1, 20, true),
  },

  // Per-request HTTP timeout against sub2api
  requestTimeoutMs: boundedNum('REQUEST_TIMEOUT_MS', 15_000, 1_000, 120_000, true),

  auth: {
    // The dashboard is intentionally closed until an operator configures a
    // username and a scrypt password hash. Plaintext passwords are not accepted.
    enabled: true,
    username: text('SENTINEL_ADMIN_USERNAME'),
    passwordHash: secretText('SENTINEL_ADMIN_PASSWORD_HASH'),
    requireTotp,
    totpSecret: requireTotp ? secretText('SENTINEL_ADMIN_TOTP_SECRET').replace(/\s|=/g, '').toUpperCase() : '',
    accountKey: requireTotp ? secretText('SENTINEL_ACCOUNT_KEY') : '',
    sessionTtlMs: boundedNum('AUTH_SESSION_TTL_MS', 8 * 60 * 60_000, 5 * 60_000, 30 * 24 * 60 * 60_000, true),
    idleTimeoutMs: boundedNum('AUTH_IDLE_TIMEOUT_MS', 60 * 60_000, 60_000, 24 * 60 * 60_000, true),
    maxLoginAttempts: boundedNum('AUTH_MAX_LOGIN_ATTEMPTS', 5, 1, 20, true),
    loginWindowMs: boundedNum('AUTH_LOGIN_WINDOW_MS', 15 * 60_000, 60_000, 24 * 60 * 60_000, true),
    secureCookies: bool('AUTH_SECURE_COOKIES', false),
  },

  notify: {
    // Optional. Leave empty to disable notifications entirely.
    url: secretText('NOTIFY_WEBHOOK_URL'),
    format: (process.env.NOTIFY_FORMAT || 'generic').trim().toLowerCase(),
    // Which events should trigger a message. Comma separated, or 'all'.
    on: (process.env.NOTIFY_ON || 'topup,unknown,failure,circuit,proposal').split(',').map((s) => s.trim()).filter(Boolean),
  },
};

/**
 * The absolute allowed destination. We refuse to talk to anything that is not
 * explicitly configured, so a compromised DB row or log cannot redirect the
 * admin key to an attacker's host.
 */
export function assertConfigured({ requireAuth = true } = {}) {
  const errors = [];
  if (!config.baseUrl) errors.push('SUB2API_BASE_URL is not set');
  if (!config.adminKey) errors.push('SUB2API_ADMIN_API_KEY is not set');
  if (config.baseUrl && !/^https?:\/\//i.test(config.baseUrl)) {
    errors.push('SUB2API_BASE_URL must start with http:// or https://');
  }
  if (config.baseUrl) {
    try {
      const target = new URL(config.baseUrl);
      if (target.username || target.password || target.search || target.hash) {
        errors.push('SUB2API_BASE_URL must not contain credentials, a query string, or a fragment');
      }
      if (target.protocol === 'http:' && !isLoopbackHost(target.hostname) && !bool('ALLOW_INSECURE_SUB2API_HTTP', false)) {
        errors.push('SUB2API_BASE_URL must use HTTPS unless it is loopback or ALLOW_INSECURE_SUB2API_HTTP=true');
      }
    } catch {
      errors.push('SUB2API_BASE_URL must be a valid absolute URL');
    }
  }
  if (config.adminKey && !config.adminKey.startsWith('admin-')) {
    // Warn-only: sub2api uses the "admin-" prefix, but a self-built fork may differ.
    console.warn('[config] SUB2API_ADMIN_API_KEY does not start with "admin-"; continuing anyway');
  }
  if (requireAuth) {
    if (config.auth.requireTotp && config.auth.accountKey && !isAccountKey(config.auth.accountKey)) {
      errors.push('SENTINEL_ACCOUNT_KEY must contain exactly 64 hexadecimal characters');
    }
    if (!config.auth.username || !/^[A-Za-z0-9._@-]{3,128}$/.test(config.auth.username)) {
      errors.push('SENTINEL_ADMIN_USERNAME must contain 3-128 letters, digits, dot, underscore, @ or hyphen');
    }
    if (!isPasswordHash(config.auth.passwordHash)) {
      errors.push('SENTINEL_ADMIN_PASSWORD_HASH must be a scrypt hash (generate with `node server/src/hash-password.js`)');
    }
    if (config.auth.requireTotp && !/^[A-Z2-7]{26,64}$/.test(config.auth.totpSecret)) {
      errors.push('SENTINEL_ADMIN_TOTP_SECRET must be a Base32 secret (generate with `node server/src/generate-totp.js`)');
    }
    if (config.server.allowedHosts && !config.auth.secureCookies) {
      errors.push('AUTH_SECURE_COOKIES=true is required when ALLOWED_HOSTS is configured for remote access');
    }
    if (!['0.0.0.0', '::'].includes(config.server.host) && !isLoopbackHost(config.server.host) && !config.auth.secureCookies) {
      errors.push('AUTH_SECURE_COOKIES=true is required for a non-loopback bind address');
    }
  }
  if (config.notify.url) {
    try {
      const webhook = new URL(config.notify.url);
      if (!['http:', 'https:'].includes(webhook.protocol) || webhook.username || webhook.password) {
        errors.push('NOTIFY_WEBHOOK_URL must be an http(s) URL without embedded credentials');
      }
    } catch {
      errors.push('NOTIFY_WEBHOOK_URL must be a valid http(s) URL');
    }
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

/** True when this notification category is switched on. */
export function notifyOn(category) {
  return config.notify.on.includes('all') || config.notify.on.includes(category);
}

/** Redacted view of config, safe to log or return over the API. */
export function publicConfig() {
  return {
    baseUrl: safeOrigin(config.baseUrl),
    dbPath: config.dbPath,
    monitor: config.monitor,
    guard: config.guard,
    notify: {
      enabled: Boolean(config.notify.url),
      format: config.notify.format,
      on: config.notify.on,
      // Only the host is ever exposed, never the secret part of the webhook URL.
      host: config.notify.url ? safeHost(config.notify.url) : null,
    },
    adminKeyConfigured: Boolean(config.adminKey),
    auth: {
      enabled: true,
      requireTotp: config.auth.requireTotp,
      accountsEnabled: !config.auth.requireTotp || isAccountKey(config.auth.accountKey),
      sessionTtlMs: config.auth.sessionTtlMs,
      idleTimeoutMs: config.auth.idleTimeoutMs,
    },
  };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
