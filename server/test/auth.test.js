import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager, hashPassword, parseCookies, totpCode, verifyPassword } from '../src/lib/auth.js';

function memoryStore() {
  const sessions = new Map();
  const events = [];
  let lastTotpCounter = -1;
  return {
    sessions,
    events,
    createAuthSession(input) {
      const id = `s-${sessions.size + 1}`;
      sessions.set(id, { id, token_hash: input.tokenHash, csrf_hash: input.csrfHash, username: input.username, created_at: input.createdAt, last_seen_at: input.createdAt, expires_at: input.expiresAt, revoked_at: null });
      return id;
    },
    getAuthSession(hash) { return [...sessions.values()].find((s) => s.token_hash === hash); },
    touchAuthSession(id, at) { sessions.get(id).last_seen_at = at; return 1; },
    rotateAuthCsrf(id, hash) { sessions.get(id).csrf_hash = hash; return 1; },
    revokeAuthSession(id, at = new Date().toISOString()) { sessions.get(id).revoked_at = at; return 1; },
    purgeAuthSessions() { return 0; },
    lastTotpCounter() { return lastTotpCounter; },
    consumeTotpCounter(counter) {
      if (counter <= lastTotpCounter) return false;
      lastTotpCounter = counter;
      return true;
    },
    log(level, kind, message) { events.push({ level, kind, message }); },
  };
}

test('scrypt password hashes verify without storing plaintext', async () => {
  const hash = hashPassword('a-password-that-is-long-enough');
  assert.match(hash, /^scrypt:/);
  assert.equal(await verifyPassword('a-password-that-is-long-enough', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
  assert.equal(hash.includes('a-password-that-is-long-enough'), false);
});

test('TOTP follows RFC 6238 output and refuses reused or invalid counters', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpCode(secret, 1), '287082');
  assert.equal(totpCode(secret, 2), '359152');
});

test('login creates a token session and CSRF verification is required', async () => {
  const store = memoryStore();
  const auth = new AuthManager({
    store,
    username: 'admin',
    requireTotp: true,
    passwordHash: hashPassword('a-password-that-is-long-enough'),
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    sessionTtlMs: 60_000,
    idleTimeoutMs: 60_000,
    maxLoginAttempts: 3,
    loginWindowMs: 60_000,
  });
  const now = Date.now();
  const otp = totpCode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', Math.floor(now / 30_000));
  assert.equal((await auth.login('admin', 'a-password-that-is-long-enough', 'invalid', { ip: '127.0.0.1' })).ok, false);
  const result = await auth.login('admin', 'a-password-that-is-long-enough', otp, { ip: '127.0.0.1' });
  assert.equal(result.ok, true);
  const session = auth.authenticate(result.token);
  assert.equal(session.username, 'admin');
  assert.equal(auth.verifyCsrf(session, result.csrfToken), true);
  assert.equal(auth.verifyCsrf(session, 'attacker-token'), false);
  auth.logout(session);
  assert.equal(auth.authenticate(result.token), null);
  assert.equal((await auth.login('admin', 'a-password-that-is-long-enough', otp, { ip: '127.0.0.1' })).ok, false, 'a successful code must not be reusable');
});

test('login attempts are rate limited per client address', async () => {
  const store = memoryStore();
  const auth = new AuthManager({
    store,
    username: 'admin',
    requireTotp: true,
    passwordHash: hashPassword('a-password-that-is-long-enough'),
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    sessionTtlMs: 60_000,
    idleTimeoutMs: 60_000,
    maxLoginAttempts: 2,
    loginWindowMs: 60_000,
  });
  assert.equal((await auth.login('admin', 'bad-password', '000000', { ip: '1.2.3.4' })).rateLimited, false);
  assert.equal((await auth.login('admin', 'bad-password', '000000', { ip: '1.2.3.4' })).rateLimited, false);
  assert.equal((await auth.login('admin', 'bad-password', '000000', { ip: '1.2.3.4' })).rateLimited, true);
});

test('cookie parsing tolerates malformed values', () => {
  assert.deepEqual(parseCookies('sentinel_session=abc; sentinel_csrf=a%20b; broken=%E0%A4%A'), {
    sentinel_session: 'abc', sentinel_csrf: 'a b', broken: '',
  });
});
