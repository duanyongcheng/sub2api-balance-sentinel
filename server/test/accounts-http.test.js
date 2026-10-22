import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, createStore } from '../src/db/store.js';
import { AuthManager, hashPassword, totpCode } from '../src/lib/auth.js';
import { AccountManager } from '../src/lib/accounts.js';
import { Monitor } from '../src/lib/monitor.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

const KEY = 'ab'.repeat(32);
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'account-http-test-password-is-not-real';

async function fixture(t) {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const advance = () => { clock += 30_000; };
  const code = (secret) => totpCode(secret, Math.floor(clock / 30_000));
  const proof = (secret = SECRET, password = PASSWORD) => { advance(); return { currentPassword: password, otp: code(secret) }; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-accounts-http-'));
  const db = openDb(path.join(dir, 'test.db'));
  const store = createStore(db);
  const auth = new AuthManager({
    store, username: 'bootstrap_admin', passwordHash: hashPassword(PASSWORD), totpSecret: SECRET, accountKey: KEY, requireTotp: true,
    sessionTtlMs: 8 * 60 * 60_000, idleTimeoutMs: 60 * 60_000, maxLoginAttempts: 5, loginWindowMs: 15 * 60_000,
  });
  let balance = 5;
  let writes = 0;
  const client = {
    async getUser(id) { return { id, email: 'a@example.com', balance }; },
    async addBalance(id, amount) { writes += 1; balance += amount; return { status: 200, replay: false, data: { id, balance } }; },
  };
  const monitor = new Monitor({ store, client, logger: { log() {} } });
  const server = http.createServer(createApp({ store, monitor, client, auth }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const previousPort = process.env.PORT;
  process.env.PORT = String(server.address().port);
  t.after(async () => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await new Promise((resolve) => server.close(resolve));
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  async function call(route, { method = 'GET', body, as = null, csrf = true, sentinel = true, origin = base } = {}) {
    const headers = {};
    if (as) headers.Cookie = as.cookie;
    if (method !== 'GET') {
      headers.Origin = origin;
      headers['Content-Type'] = 'application/json';
      if (sentinel) headers['X-Sentinel'] = '1';
      if (as && csrf) headers['X-CSRF-Token'] = as.csrfToken;
    }
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
  }
  async function login(username, secret, password = PASSWORD) {
    advance();
    const result = await call('/api/auth/login', { method: 'POST', body: { username, password, otp: code(secret) } });
    if (result.status !== 200) return result;
    const cookies = result.headers.getSetCookie().map((value) => value.split(';')[0]);
    const token = decodeURIComponent(cookies.find((value) => value.startsWith('sentinel_session=')).slice('sentinel_session='.length));
    const csrfToken = decodeURIComponent(cookies.find((value) => value.startsWith('sentinel_csrf=')).slice('sentinel_csrf='.length));
    return { ...result, cookie: cookies.join('; '), token, csrfToken };
  }
  const root = await login('bootstrap_admin', SECRET);
  assert.equal(root.status, 200);
  const accounts = new AccountManager({ store, auth, accountKey: KEY });
  async function member(username, role) {
    const invite = accounts.create({ username, role }, auth.authenticate(root.token));
    const enrollment = accounts.startEnrollment(invite.enrollmentToken, { ip: username });
    const result = await accounts.finishEnrollment({ token: invite.enrollmentToken, password: PASSWORD, otp: code(enrollment.secret) }, { ip: username });
    assert.equal(result.ok, true);
    const session = await login(username, enrollment.secret);
    assert.equal(session.status, 200);
    return { ...session, secret: enrollment.secret, id: invite.account.id };
  }
  return { store, auth, monitor, client, root, accounts, call, login, member, proof, code, advance, writes: () => writes };
}

test('HTTP invitations require an administrator, CSRF, and fresh step-up credentials', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/auth/session')).data.totpRequired, true);
  assert.equal((await f.call('/api/auth/login', { method: 'POST', body: {
    username: 'bootstrap_admin', password: PASSWORD, totpRequired: false, requireTotp: false,
  } })).status, 401, 'request fields cannot turn off the server MFA policy');
  assert.equal((await f.call('/api/accounts')).status, 401);
  assert.equal((await f.call('/api/accounts', { method: 'POST', as: f.root, body: { username: 'alice', role: 'auditor' } })).status, 401);
  const fresh = f.proof();
  assert.equal((await f.call('/api/accounts', { method: 'POST', as: f.root, csrf: false, body: { username: 'alice', role: 'auditor', ...fresh } })).status, 403);
  const invited = await f.call('/api/accounts', { method: 'POST', as: f.root, body: { username: 'alice', role: 'auditor', actor: 'forged', ...fresh } });
  assert.equal(invited.status, 201);
  const token = invited.data.enrollmentToken;
  const listing = await f.call('/api/accounts', { as: f.root });
  assert.equal(listing.status, 200);
  assert.equal(listing.data.items[0].createdBy, 'bootstrap_admin');
  assert.equal(JSON.stringify(listing.data).includes(token), false);
  assert.equal(JSON.stringify(listing.data).includes('totp_ciphertext'), false);
  assert.equal((await f.call('/api/auth/enroll/start', { method: 'POST', body: { token }, origin: 'https://other.invalid' })).status, 403);
  assert.equal((await f.call('/api/auth/enroll/start', { method: 'POST', body: { token }, sentinel: false })).status, 403);
  const enrollment = await f.call('/api/auth/enroll/start', { method: 'POST', body: { token } });
  assert.equal(enrollment.status, 200);
  assert.equal(enrollment.headers.get('cache-control'), 'no-store');
  assert.equal((await f.call('/api/auth/enroll/finish', { method: 'POST', body: { token, password: PASSWORD, otp: 'invalid' } })).status, 401);
  assert.equal((await f.call('/api/auth/enroll/finish', { method: 'POST', body: { token, password: PASSWORD, otp: f.code(enrollment.data.secret) } })).status, 200);
  assert.equal((await f.call('/api/auth/enroll/start', { method: 'POST', body: { token } })).status, 401);
  const loggedIn = await f.login('alice', enrollment.data.secret);
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.data.role, 'auditor');
  assert.equal((await f.call('/api/auth/session', { as: loggedIn })).data.role, 'auditor');
  assert.equal((await f.call('/api/accounts', { as: loggedIn })).status, 403);
});

test('auditors cannot call any business mutation; operators cannot administer accounts', async (t) => {
  const f = await fixture(t);
  const reader = await f.member('reader', 'auditor');
  const operator = await f.member('operator', 'operator');
  const mutations = [
    ['POST', '/api/users', { userId: 1, threshold: 20, amount: 100 }],
    ['PATCH', '/api/users/1', { enabled: false }], ['DELETE', '/api/users/1', {}],
    ['POST', '/api/users/1/topup', { amount: 100 }], ['POST', '/api/proposals/p1/approve', {}],
    ['POST', '/api/proposals/p1/reject', {}], ['POST', '/api/notify/test', {}],
    ['POST', '/api/records/r1/verify', {}], ['POST', '/api/records/r1/resolve', { decision: 'applied', confirmation: 'r1' }],
    ['POST', '/api/records/r1/reconcile', {}], ['POST', '/api/kill-switch', { on: true }],
    ['POST', '/api/circuit-breaker/reset', {}], ['POST', '/api/tick', {}],
    ['POST', '/api/accounts', {}], ['PATCH', `/api/accounts/${reader.id}`, {}], ['POST', `/api/accounts/${reader.id}/reinvite`, {}],
  ];
  for (const [method, route, body] of mutations) assert.equal((await f.call(route, { method, body, as: reader })).status, 403, route);
  for (const route of ['/api/config', '/api/users', '/api/records', '/api/reconciliation', '/api/events', '/api/proposals']) {
    assert.equal((await f.call(route, { as: reader })).status, 200, route);
  }
  assert.equal(f.writes(), 0);
  assert.equal((await f.call('/api/accounts', { as: operator })).status, 403);
  assert.equal((await f.call('/api/accounts', { method: 'POST', body: { username: 'intruder', role: 'admin' }, as: operator })).status, 403);
  assert.equal((await f.call('/api/users', { method: 'POST', as: operator, body: { userId: 1, threshold: 20, amount: 100 } })).status, 200);
  const original = config.monitor.autoTopUpEnabled;
  config.monitor.autoTopUpEnabled = true;
  t.after(() => { config.monitor.autoTopUpEnabled = original; });
  const money = await f.call('/api/users/1/topup', { method: 'POST', as: operator, body: { amount: 100 } });
  assert.equal(money.status, 200);
  assert.equal(money.data.record.actor, 'operator');
  const account = f.store.getAuthAccount(operator.id);
  const changed = await f.call(`/api/accounts/${operator.id}`, { method: 'PATCH', as: f.root, body: { role: 'auditor', version: account.credential_version, ...f.proof() } });
  assert.equal(changed.status, 200);
  assert.equal((await f.call('/api/config', { as: operator })).status, 401);
  const freshSession = await f.login('operator', operator.secret);
  assert.equal(freshSession.data.role, 'auditor');
  assert.equal((await f.call('/api/users/1/topup', { method: 'POST', as: freshSession, body: { amount: 100 } })).status, 403);
  assert.equal(f.writes(), 1);
});

test('self-service passwords and administrator resets revoke old cookies without MFA bypass', async (t) => {
  const f = await fixture(t);
  const reader = await f.member('reader', 'auditor');
  const replacement = 'replacement-password-with-enough-entropy';
  assert.equal((await f.call('/api/auth/password', { method: 'POST', as: reader, body: { currentPassword: PASSWORD, newPassword: replacement, otp: f.code(reader.secret) } })).status, 401);
  const changed = await f.call('/api/auth/password', { method: 'POST', as: reader, body: { newPassword: replacement, ...f.proof(reader.secret) } });
  assert.equal(changed.status, 200);
  assert.match(changed.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.call('/api/config', { as: reader })).status, 401);
  assert.equal((await f.login('reader', reader.secret, PASSWORD)).status, 401);
  const newSession = await f.login('reader', reader.secret, replacement);
  assert.equal(newSession.status, 200);
  const account = f.store.getAuthAccount(reader.id);
  const reset = await f.call(`/api/accounts/${reader.id}/reinvite`, { method: 'POST', as: f.root, body: { version: account.credential_version, ...f.proof() } });
  assert.equal(reset.status, 200);
  assert.equal((await f.call('/api/config', { as: newSession })).status, 401);
  const row = f.store.getAuthAccount(reader.id);
  assert.equal((await f.call(`/api/accounts/${reader.id}`, { method: 'PATCH', as: f.root, body: { enabled: true, version: row.credential_version, ...f.proof() } })).status, 409);
  const enrollment = await f.call('/api/auth/enroll/start', { method: 'POST', body: { token: reset.data.enrollmentToken } });
  assert.equal(enrollment.status, 200);
  assert.notEqual(enrollment.data.secret, reader.secret);
  const original = config.auth.secureCookies;
  config.auth.secureCookies = true;
  t.after(() => { config.auth.secureCookies = original; });
  assert.equal((await f.call('/api/auth/enroll/start', { method: 'POST', body: { token: reset.data.enrollmentToken } })).status, 403, 'remote-mode credential submissions require an HTTPS Origin');
});
