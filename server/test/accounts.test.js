import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStore } from '../src/db/store.js';
import { AuthManager, hashPassword, sha256, totpCode, verifyPassword } from '../src/lib/auth.js';
import { AccountManager } from '../src/lib/accounts.js';
import { decryptAccountSecret, encryptAccountSecret } from '../src/lib/account-secrets.js';
import { Monitor } from '../src/lib/monitor.js';
import { Reconciler } from '../src/lib/reconciliation.js';
import { config } from '../src/config.js';

const KEY = '12'.repeat(32);
const ROOT_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const PASSWORD = 'a-different-password-per-real-account';

async function setup(t) {
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const advance = (ms = 30_000) => { clock += ms; };
  const code = (secret, offset = 0) => totpCode(secret, Math.floor(clock / 30_000) + offset);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-accounts-'));
  const file = path.join(dir, 'shared.db');
  const db = openDb(file);
  const dbB = openDb(file);
  const store = createStore(db);
  const other = createStore(dbB);
  const options = {
    store, username: 'root_admin', passwordHash: hashPassword(PASSWORD), totpSecret: ROOT_SECRET, requireTotp: true,
    accountKey: KEY, sessionTtlMs: 8 * 60 * 60_000, idleTimeoutMs: 60 * 60_000,
    maxLoginAttempts: 5, loginWindowMs: 15 * 60_000,
  };
  const auth = new AuthManager(options);
  const accounts = new AccountManager({ store, auth, accountKey: KEY });
  const rootLogin = await auth.login('ROOT_ADMIN', PASSWORD, code(ROOT_SECRET, -1), { ip: 'root' });
  assert.equal(rootLogin.ok, true);
  const root = auth.authenticate(rootLogin.token);
  t.after(() => { dbB.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function member(username = 'worker', role = 'operator') {
    const invitation = accounts.create({ username, role }, root);
    assert.equal(invitation.ok, true, invitation.reason);
    const enrollment = accounts.startEnrollment(invitation.enrollmentToken, { ip: username });
    const result = await accounts.finishEnrollment({ token: invitation.enrollmentToken, password: PASSWORD, otp: code(enrollment.secret, -1) }, { ip: username });
    assert.equal(result.ok, true, result.reason);
    const login = await auth.login(username, PASSWORD, code(enrollment.secret), { ip: username });
    assert.equal(login.ok, true);
    return { invitation, secret: enrollment.secret, login, principal: auth.authenticate(login.token), account: store.getAuthAccount(invitation.account.id) };
  }
  return { dir, file, db, store, other, auth, accounts, options, root, advance, code, member };
}

test('MFA secrets use authenticated encryption bound to an immutable account ID', () => {
  const secret = 'TEST-SECRET';
  const one = encryptAccountSecret(secret, 'account-a', KEY);
  const two = encryptAccountSecret(secret, 'account-a', KEY);
  assert.notEqual(one, two);
  assert.equal(one.includes(secret), false);
  assert.equal(decryptAccountSecret(one, 'account-a', KEY), secret);
  for (const [value, id, key] of [[one, 'account-b', KEY], [one, 'account-a', '34'.repeat(32)], ['v1.invalid.data', 'account-a', KEY], [one, 'account-a', '']]) {
    assert.throws(() => decryptAccountSecret(value, id, key), /unavailable/);
  }
});

test('invitations expose no stored password, token, or MFA plaintext and are single use', async (t) => {
  const f = await setup(t);
  const invitation = f.accounts.create({ username: 'Alice', role: 'auditor' }, f.root);
  assert.equal(invitation.ok, true);
  const row = f.store.getAuthAccount(invitation.account.id);
  assert.equal(row.username, 'alice');
  assert.equal(row.enabled, 0);
  assert.equal(row.password_hash, null);
  assert.equal(row.invitation_hash, sha256(invitation.enrollmentToken));
  const enrollment = f.accounts.startEnrollment(invitation.enrollmentToken);
  assert.equal(enrollment.ok, true);
  assert.equal(row.totp_ciphertext.includes(enrollment.secret), false);
  const listing = JSON.stringify(f.accounts.list(f.root));
  for (const secret of [invitation.enrollmentToken, enrollment.secret, row.invitation_hash, row.totp_ciphertext]) assert.equal(listing.includes(secret), false);
  assert.equal((await f.auth.login('alice', PASSWORD, f.code(enrollment.secret))).ok, false);
  assert.equal((await f.accounts.finishEnrollment({ token: invitation.enrollmentToken, password: 'short', otp: f.code(enrollment.secret, -1) })).ok, false);
  assert.equal((await f.accounts.finishEnrollment({ token: invitation.enrollmentToken, password: PASSWORD, otp: f.code(enrollment.secret, -1) })).ok, true);
  assert.equal(f.accounts.startEnrollment(invitation.enrollmentToken).ok, false);
  assert.equal((await f.accounts.finishEnrollment({ token: invitation.enrollmentToken, password: PASSWORD, otp: f.code(enrollment.secret) })).ok, false);
  const login = await f.auth.login('ALICE', PASSWORD, f.code(enrollment.secret));
  assert.equal(login.role, 'auditor');
  assert.equal(f.auth.authenticate(login.token).account_id, row.id);
});

test('expired, disabled, and concurrently consumed invitations cannot activate accounts', async (t) => {
  const f = await setup(t);
  const invite = f.accounts.create({ username: 'racer' }, f.root);
  const enrollment = f.accounts.startEnrollment(invite.enrollmentToken);
  const payload = { token: invite.enrollmentToken, password: PASSWORD, otp: f.code(enrollment.secret, -1) };
  const results = await Promise.all([f.accounts.finishEnrollment(payload), f.accounts.finishEnrollment(payload)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(f.store.getAuthAccount(invite.account.id).credential_version, 2);
  const expired = f.accounts.create({ username: 'expired' }, f.root);
  f.db.prepare('UPDATE auth_accounts SET invitation_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expired.account.id);
  assert.equal(f.accounts.startEnrollment(expired.enrollmentToken).ok, false);
  const canceled = f.accounts.create({ username: 'canceled' }, f.root);
  assert.equal(f.accounts.update(canceled.account.id, { enabled: false, version: 1 }, f.root).ok, true);
  assert.equal(f.accounts.startEnrollment(canceled.enrollmentToken).ok, false);
  assert.equal(f.accounts.update(canceled.account.id, { enabled: true, version: 2 }, f.root).ok, false, 'MFA cannot be bypassed by enabling an invited user');
});

test('changing role and disabling an account revoke all sessions across SQLite connections', async (t) => {
  const f = await setup(t);
  const user = await f.member();
  assert.equal(user.principal.role, 'operator');
  const changed = f.accounts.update(user.account.id, { role: 'auditor', version: user.account.credential_version }, f.root);
  assert.equal(changed.ok, true);
  assert.equal(f.auth.authenticate(user.login.token), null);
  assert.ok(f.other.getAuthSession(sha256(user.login.token)).revoked_at);
  f.advance();
  const newLogin = await f.auth.login('worker', PASSWORD, f.code(user.secret));
  assert.equal(newLogin.role, 'auditor');
  const disabled = f.accounts.update(user.account.id, { enabled: false, version: changed.account.version }, f.root);
  assert.equal(disabled.ok, true);
  assert.equal(f.auth.authenticate(newLogin.token), null);
  f.advance();
  assert.equal((await f.auth.login('worker', PASSWORD, f.code(user.secret))).ok, false);
});

test('stale edits, self-demotion, reserved usernames and non-admin management are rejected', async (t) => {
  const f = await setup(t);
  const operator = await f.member();
  for (const username of ['root_admin', 'ROOT_ADMIN']) assert.equal(f.accounts.create({ username }, f.root).ok, false);
  assert.equal(f.accounts.create({ username: 'bad role', role: 'owner' }, f.root).ok, false);
  assert.equal(f.accounts.create({ username: 'newuser', role: 'admin' }, operator.principal).ok, false);
  assert.equal(f.accounts.list(operator.principal).status, 403);
  const admin = await f.member('second_admin', 'admin');
  assert.equal(f.accounts.update(admin.account.id, { role: 'auditor', version: admin.account.credential_version }, admin.principal).ok, false);
  assert.equal(f.accounts.update(operator.account.id, { enabled: false, version: 999 }, f.root).ok, false);
  assert.equal(f.store.getAuthAccount(operator.account.id).enabled, 1);
});

test('resetting credentials invalidates sessions and invites, with a new per-account MFA secret', async (t) => {
  const f = await setup(t);
  const user = await f.member();
  const reset = f.accounts.reinvite(user.account.id, user.account.credential_version, f.root);
  assert.equal(reset.ok, true);
  assert.equal(f.auth.authenticate(user.login.token), null);
  assert.equal(f.store.getAuthAccount(user.account.id).password_hash, null);
  const enrollment = f.accounts.startEnrollment(reset.enrollmentToken);
  assert.notEqual(enrollment.secret, user.secret);
  assert.equal(f.accounts.startEnrollment(user.invitation.enrollmentToken).ok, false);
  assert.equal((await f.accounts.finishEnrollment({ token: reset.enrollmentToken, password: PASSWORD, otp: f.code(enrollment.secret, -1) })).ok, true);
  assert.equal((await f.auth.login('worker', PASSWORD, f.code(enrollment.secret))).ok, true);
});

test('password changes require step-up credentials and revoke every old session', async (t) => {
  const f = await setup(t);
  const user = await f.member();
  assert.equal((await f.auth.verifyStepUp(user.principal, PASSWORD, f.code(user.secret))).ok, false, 'login OTP cannot be reused for step-up');
  f.advance();
  assert.equal((await f.auth.verifyStepUp(user.principal, PASSWORD, f.code(user.secret))).ok, true);
  const replacement = 'new-password-different-from-the-old-one';
  assert.equal((await f.accounts.changePassword(user.principal, replacement)).ok, true);
  assert.equal(f.auth.authenticate(user.login.token), null);
  const account = f.store.getAuthAccount(user.account.id);
  assert.equal(await verifyPassword(replacement, account.password_hash), true);
  assert.equal(await verifyPassword(PASSWORD, account.password_hash), false);
  assert.equal((await f.accounts.changePassword(f.root, replacement)).status, 409);
  f.advance();
  assert.equal((await f.auth.login('worker', PASSWORD, f.code(user.secret))).ok, false);
  assert.equal((await f.auth.login('worker', replacement, f.code(user.secret))).ok, true);
});

test('a wrong encryption key fails managed-user login closed but preserves bootstrap recovery', async (t) => {
  const f = await setup(t);
  const user = await f.member();
  const auth = new AuthManager({ ...f.options, accountKey: 'ff'.repeat(32) });
  f.advance();
  assert.equal((await auth.login('worker', PASSWORD, f.code(user.secret))).ok, false);
  assert.equal((await auth.login('root_admin', PASSWORD, f.code(ROOT_SECRET))).role, 'admin');
  assert.throws(() => new AuthManager({ ...f.options, username: 'worker' }), /conflicts/);
});

test('revocation while an operator is awaiting a balance prevents the final money request', async (t) => {
  const f = await setup(t);
  const user = await f.member();
  f.store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });
  let resume;
  let entered;
  const gate = new Promise((resolve) => { resume = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  let writes = 0;
  const monitor = new Monitor({ store: f.store, client: {
    async getUser(id) { entered(); await gate; return { id, balance: 5 }; },
    async addBalance() { writes += 1; },
  } });
  const original = config.monitor.autoTopUpEnabled;
  config.monitor.autoTopUpEnabled = true;
  t.after(() => { config.monitor.autoTopUpEnabled = original; });
  const pending = monitor.performTopUp({ userId: 1, threshold: 20, amount: 100, source: 'manual', actor: 'worker', authorizeActor: () => f.auth.isCurrentPrincipal(user.principal, ['admin', 'operator']) });
  await waiting;
  f.other.updateAuthAccount({ id: user.account.id, role: 'auditor', enabled: true, version: user.account.credential_version, actor: 'root_admin' }, () => true);
  resume();
  const outcome = await pending;
  assert.equal(outcome.attempted, false);
  assert.match(outcome.reason, /authorization changed/);
  assert.equal(writes, 0);
  assert.equal(f.store.recentTopups({}).length, 0);
});

test('revocation during reconciliation prevents a financial status change', async (t) => {
  const f = await setup(t);
  const user = await f.member();
  f.store.beginTopup({ id: 'unresolved', userId: 1, email: 'a@example.com', balanceBefore: 5, amount: 100, threshold: 20, source: 'auto' });
  f.store.finishTopup({ id: 'unresolved', status: 'unknown' });
  let resume;
  let entered;
  const gate = new Promise((resolve) => { resume = resolve; });
  const waiting = new Promise((resolve) => { entered = resolve; });
  const reconciler = new Reconciler({ store: f.store, client: {
    async getBalanceHistory() {
      entered(); await gate;
      return { page: 1, page_size: 100, total: 1, pages: 1, items: [{ id: 1, notes: 'sentinel_id=unresolved;', used_by: 1, value: 100, type: 'admin_balance', status: 'used', used_at: new Date().toISOString() }] };
    },
  } });
  const pending = reconciler.resolveApplied('unresolved', 'worker', () => f.auth.isCurrentPrincipal(user.principal, ['admin', 'operator']));
  await waiting;
  f.other.updateAuthAccount({ id: user.account.id, role: 'auditor', enabled: true, version: user.account.credential_version, actor: 'root_admin' }, () => true);
  resume();
  assert.equal((await pending).ok, false);
  assert.equal(f.store.getTopup('unresolved').status, 'unknown');
});

test('administrator demotion during step-up cannot authorize a later account mutation', async (t) => {
  const f = await setup(t);
  const admin = await f.member('managed_admin', 'admin');
  f.advance();
  const pending = f.auth.verifyStepUp(admin.principal, PASSWORD, f.code(admin.secret));
  f.other.updateAuthAccount({ id: admin.account.id, role: 'auditor', enabled: true, version: admin.account.credential_version, actor: 'root_admin' }, () => true);
  assert.equal((await pending).ok, false);
  assert.equal(f.accounts.create({ username: 'not_created', role: 'admin' }, admin.principal).ok, false);
  assert.equal(f.store.findAuthAccount('not_created'), undefined);
});

test('canceling an invitation while password hashing is in flight prevents activation', async (t) => {
  const f = await setup(t);
  const invite = f.accounts.create({ username: 'canceled_during_hash' }, f.root);
  const enrollment = f.accounts.startEnrollment(invite.enrollmentToken);
  const pending = f.accounts.finishEnrollment({ token: invite.enrollmentToken, password: PASSWORD, otp: f.code(enrollment.secret) });
  f.accounts.update(invite.account.id, { enabled: false, version: invite.account.version }, f.root);
  assert.equal((await pending).ok, false);
  assert.equal(f.store.getAuthAccount(invite.account.id).enabled, 0);
  assert.equal(f.store.getAuthAccount(invite.account.id).password_hash, null);
});

test('MFA guessing is bounded across client IPs once the first factor is known', async (t) => {
  const f = await setup(t);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await f.auth.login('root_admin', PASSWORD, 'invalid', { ip: `bot-${attempt}` });
    assert.equal(result.ok, false);
    assert.equal(result.rateLimited, false);
  }
  assert.equal((await f.auth.login('root_admin', PASSWORD, 'invalid', { ip: 'another-ip' })).rateLimited, true);
});

test('capability enrollment is rate limited and never falls back to plaintext without a key', async (t) => {
  const f = await setup(t);
  const unavailable = new AccountManager({ store: f.store, auth: f.auth });
  assert.equal(unavailable.create({ username: 'never_plaintext' }, f.root).status, 503);
  for (let attempt = 0; attempt < 20; attempt += 1) assert.equal(f.accounts.startEnrollment('a'.repeat(43), { ip: 'guesser' }).status, 401);
  assert.equal(f.accounts.startEnrollment('a'.repeat(43), { ip: 'guesser' }).status, 429);
});

test('a new authentication instance preserves encrypted accounts and MFA replay state', async (t) => {
  const f = await setup(t);
  const user = await f.member();
  const restarted = new AuthManager({ ...f.options, store: f.other });
  assert.equal(restarted.authenticate(user.login.token), null);
  assert.equal((await restarted.login('worker', PASSWORD, f.code(user.secret))).ok, false);
  f.advance();
  const fresh = await restarted.login('worker', PASSWORD, f.code(user.secret));
  assert.equal(fresh.ok, true);
  assert.equal(restarted.authenticate(fresh.token).role, 'operator');
});
