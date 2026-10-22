import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, createStore } from '../src/db/store.js';
import { AuthManager, hashPassword, totpCode } from '../src/lib/auth.js';
import { AccountManager } from '../src/lib/accounts.js';
import { createApp } from '../src/app.js';

const PASSWORD = 'synthetic-password-only-test';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-password-only-'));
  const db = openDb(path.join(directory, 'test.db'));
  const store = createStore(db);
  const options = {
    store, username: 'bootstrap_admin', passwordHash: hashPassword(PASSWORD),
    sessionTtlMs: 3_600_000, idleTimeoutMs: 3_600_000, maxLoginAttempts: 5, loginWindowMs: 900_000,
    ...overrides,
  };
  const auth = new AuthManager(options);
  const accounts = new AccountManager({ store, auth, accountKey: options.accountKey });
  const rootLogin = await auth.login('bootstrap_admin', PASSWORD, overrides.requireTotp ? totpCode(SECRET, Math.floor(Date.now() / 30_000)) : undefined);
  assert.equal(rootLogin.ok, true);
  const root = auth.authenticate(rootLogin.token);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  async function member(username = 'worker', role = 'operator') {
    const invitation = accounts.create({ username, role }, root);
    assert.equal(invitation.ok, true, invitation.reason);
    assert.equal((await accounts.finishEnrollment({ token: invitation.enrollmentToken, password: PASSWORD })).ok, true);
    const login = await auth.login(username, PASSWORD);
    assert.equal(login.ok, true);
    return { invitation, login, principal: auth.authenticate(login.token) };
  }
  return { directory, db, store, auth, accounts, options, root, rootLogin, member };
}

test('default authentication uses only the password, not hidden MFA secrets or counters', async (t) => {
  const f = await fixture(t);
  assert.equal(f.auth.requireTotp, false);
  for (const otp of [undefined, '', 'not-a-code']) {
    assert.equal((await f.auth.login('bootstrap_admin', PASSWORD, otp)).ok, true);
  }
  assert.equal((await f.auth.login('bootstrap_admin', 'wrong-password')).ok, false);
  assert.equal((await f.auth.login('unknown', PASSWORD)).ok, false);
  assert.equal(f.store.lastTotpCounter(), -1);
  assert.equal((await f.auth.verifyStepUp(f.root, undefined)).ok, false);
  assert.equal((await f.auth.verifyStepUp(f.root, PASSWORD)).ok, true);
  assert.equal(f.auth.verifyCsrf(f.root, f.rootLogin.csrfToken), true);
  assert.equal(f.auth.verifyCsrf(f.root, 'wrong'), false);
});

test('password-only accounts enroll once without an encryption key or generated MFA material', async (t) => {
  const f = await fixture(t);
  const listing = f.accounts.list(f.root);
  assert.equal(listing.accountManagementEnabled, true);
  assert.equal(listing.accountKeyConfigured, false);
  const invitation = f.accounts.create({ username: 'new_auditor', role: 'auditor' }, f.root);
  const info = f.accounts.startEnrollment(invitation.enrollmentToken);
  assert.equal(info.ok, true);
  assert.equal(info.totpRequired, false);
  assert.equal('secret' in info, false);
  assert.equal('otpAuthUri' in info, false);
  assert.equal((await f.auth.login('new_auditor', PASSWORD)).ok, false, 'invited users cannot log in before setting a password');
  assert.equal((await f.accounts.finishEnrollment({ token: invitation.enrollmentToken, password: 'short' })).ok, false);
  assert.equal((await f.accounts.finishEnrollment({ token: invitation.enrollmentToken, password: PASSWORD })).ok, true);
  assert.equal((await f.accounts.finishEnrollment({ token: invitation.enrollmentToken, password: PASSWORD })).ok, false);
  const row = f.store.getAuthAccount(invitation.account.id);
  assert.equal(row.totp_ciphertext, '');
  assert.equal(row.last_totp_counter, -1);
  assert.equal(row.enabled, 1);
  const login = await f.auth.login('new_auditor', PASSWORD);
  assert.equal(login.role, 'auditor');
});

test('password-only enrollment remains one-time under concurrent submissions and expiry', async (t) => {
  const f = await fixture(t);
  const invitation = f.accounts.create({ username: 'concurrent' }, f.root);
  const body = { token: invitation.enrollmentToken, password: PASSWORD };
  const results = await Promise.all([f.accounts.finishEnrollment(body), f.accounts.finishEnrollment(body)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const expired = f.accounts.create({ username: 'expired' }, f.root);
  f.db.prepare('UPDATE auth_accounts SET invitation_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', expired.account.id);
  assert.equal((await f.accounts.finishEnrollment({ token: expired.enrollmentToken, password: PASSWORD })).ok, false);
});

test('password-only authentication is rate limited across client addresses for the same username', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i += 1) {
    const result = await f.auth.login('bootstrap_admin', 'wrong-password', undefined, { ip: `192.0.2.${i}` });
    assert.equal(result.ok, false);
    assert.equal(result.rateLimited, false);
  }
  const locked = await f.auth.login('BOOTSTRAP_ADMIN', PASSWORD, undefined, { ip: '192.0.2.99' });
  assert.equal(locked.ok, false);
  assert.equal(locked.rateLimited, true);
});

test('password-only login rechecks enabled state after asynchronous password verification', async (t) => {
  const f = await fixture(t);
  const user = await f.member();
  const login = f.auth.login('worker', PASSWORD);
  const result = f.accounts.update(user.invitation.account.id, { version: user.principal.account_version, enabled: false }, f.root);
  assert.equal(result.ok, true);
  assert.equal((await login).ok, false);
  assert.equal(f.auth.authenticate(user.login.token), null);
});

test('existing MFA-enrolled accounts can use password-only mode without decrypting old secrets', async (t) => {
  const f = await fixture(t, { requireTotp: true, totpSecret: SECRET, accountKey: 'ab'.repeat(32) });
  const invite = f.accounts.create({ username: 'legacy' }, f.root);
  const info = f.accounts.startEnrollment(invite.enrollmentToken);
  const counter = Math.floor(Date.now() / 30_000);
  assert.equal((await f.accounts.finishEnrollment({ token: invite.enrollmentToken, password: PASSWORD, otp: totpCode(info.secret, counter) })).ok, true);
  const before = f.store.getAuthAccount(invite.account.id);
  const passwordOnly = new AuthManager({ ...f.options, requireTotp: false, totpSecret: '', accountKey: '' });
  assert.equal((await passwordOnly.login('legacy', PASSWORD)).ok, true);
  assert.equal(f.store.getAuthAccount(invite.account.id).totp_ciphertext, before.totp_ciphertext);
  assert.equal(f.store.getAuthAccount(invite.account.id).last_totp_counter, before.last_totp_counter);
});

test('explicit MFA mode still fails closed for accounts without MFA enrollment', async (t) => {
  const f = await fixture(t);
  await f.member();
  const mfa = new AuthManager({ ...f.options, requireTotp: true, totpSecret: SECRET, accountKey: 'ab'.repeat(32) });
  assert.equal((await mfa.login('bootstrap_admin', PASSWORD)).ok, false);
  assert.equal((await mfa.login('worker', PASSWORD)).ok, false);
  assert.equal((await mfa.login('worker', PASSWORD, totpCode(SECRET, Math.floor(Date.now() / 30_000)))).ok, false);
});

test('HTTP password-only login, invitation, enrollment, step-up and password changes work without OTP', async (t) => {
  const f = await fixture(t);
  const server = http.createServer(createApp({ store: f.store, auth: f.auth,
    monitor: { lastTick: null, isKillSwitchOn: () => false }, client: {} }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalPort = process.env.PORT;
  process.env.PORT = String(server.address().port);
  t.after(async () => {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    await new Promise((resolve) => server.close(resolve));
  });
  const call = async (route, { method = 'GET', body, session, csrf = true, origin = base } = {}) => {
    const response = await fetch(base + route, { method,
      headers: { Origin: origin, 'X-Sentinel': '1', 'Content-Type': 'application/json',
        ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  const login = async (username, password = PASSWORD) => {
    const result = await call('/api/auth/login', { method: 'POST', body: { username, password } });
    if (result.status !== 200) return result;
    const cookies = result.headers.getSetCookie().map((value) => value.split(';')[0]);
    return { ...result, cookie: cookies.join('; '), csrf: decodeURIComponent(cookies.find((value) => value.startsWith('sentinel_csrf=')).slice('sentinel_csrf='.length)) };
  };
  const policy = await call('/api/auth/session');
  assert.equal(policy.data.authenticated, false);
  assert.equal(policy.data.totpRequired, false);
  const root = await login('bootstrap_admin');
  assert.equal(root.status, 200);
  assert.equal(root.data.totpRequired, false);
  assert.match(root.headers.getSetCookie().join(';'), /HttpOnly/);
  const create = { username: 'http_auditor', role: 'auditor', currentPassword: PASSWORD };
  assert.equal((await call('/api/accounts', { method: 'POST', body: create })).status, 401);
  assert.equal((await call('/api/accounts', { method: 'POST', body: create, session: root, csrf: false })).status, 403);
  assert.equal((await call('/api/accounts', { method: 'POST', body: { ...create, currentPassword: 'wrong' }, session: root })).status, 401);
  assert.equal((await call('/api/accounts', { method: 'POST', body: create, session: root, origin: 'https://other.invalid' })).status, 403);
  const invited = await call('/api/accounts', { method: 'POST', body: create, session: root });
  assert.equal(invited.status, 201);
  const token = invited.data.enrollmentToken;
  const info = await call('/api/auth/enroll/start', { method: 'POST', body: { token } });
  assert.equal(info.data.totpRequired, false);
  assert.equal('secret' in info.data, false);
  assert.equal((await call('/api/auth/enroll/finish', { method: 'POST', body: { token, password: PASSWORD } })).status, 200);
  const auditor = await login('http_auditor');
  assert.equal(auditor.status, 200);
  assert.equal((await call('/api/kill-switch', { method: 'POST', body: { on: true }, session: auditor })).status, 403);
  assert.equal((await call('/api/accounts', { session: auditor })).status, 403);
  const changedPassword = PASSWORD + '-changed';
  assert.equal((await call('/api/auth/password', { method: 'POST', session: auditor,
    body: { currentPassword: PASSWORD, newPassword: changedPassword } })).status, 200);
  assert.equal((await call('/api/records', { session: auditor })).status, 401);
  assert.equal((await login('http_auditor')).status, 401);
  assert.equal((await login('http_auditor', changedPassword)).status, 200);
  const account = f.store.findAuthAccount('http_auditor');
  assert.equal((await call(`/api/accounts/${account.id}/reinvite`, { method: 'POST', session: root,
    body: { version: account.credential_version, currentPassword: PASSWORD } })).status, 200);
  assert.equal((await login('http_auditor', changedPassword)).status, 401);
});
