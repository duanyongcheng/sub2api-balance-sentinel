import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb, createStore } from '../src/db/store.js';
import { AuthManager, hashPassword } from '../src/lib/auth.js';
import { createApp } from '../src/app.js';
import { Monitor } from '../src/lib/monitor.js';

const INSTANCE = { baseUrl: 'https://rules.fixture.invalid/base' };
const PASSWORD = 'synthetic-rule-safety-password';
const INPUT = { userId: 1, threshold: 20, amount: 30, enabled: false, mode: 'approval', note: 'Keep this disabled until reviewed' };

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-rules-'));
  const db = openDb(path.join(dir, 'shared.db'));
  const otherDb = openDb(path.join(dir, 'shared.db'));
  const store = createStore(db, { instance: INSTANCE });
  const other = createStore(otherDb, { instance: INSTANCE });
  const hash = hashPassword(PASSWORD);
  const ts = new Date().toISOString();
  db.prepare(`INSERT INTO auth_accounts (id, username, role, enabled, password_hash,
    totp_ciphertext, enrolled_at, created_at, updated_at, created_by)
    VALUES ('worker', 'worker', 'operator', 1, ?, '', ?, ?, ?, 'test')`).run(hash, ts, ts, ts);
  const auth = new AuthManager({ store, username: 'bootstrap', passwordHash: hash, requireTotp: false,
    sessionTtlMs: 3_600_000, idleTimeoutMs: 3_600_000, maxLoginAttempts: 5, loginWindowMs: 900_000 });
  let readCount = 0;
  let wait = async () => {};
  const client = { ...INSTANCE, async getUser(id) {
    readCount += 1;
    await wait();
    return { id, email: 'synthetic@example.invalid', balance: 5 };
  } };
  const monitor = new Monitor({ store, client });
  const server = http.createServer(createApp({ store, client, monitor, auth }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const oldPort = process.env.PORT;
  process.env.PORT = String(server.address().port);
  t.after(async () => {
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
    await new Promise((resolve) => server.close(resolve));
    otherDb.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sentinel': '1', Origin: base },
    body: JSON.stringify({ username: 'worker', password: PASSWORD }) });
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie().map((value) => value.split(';')[0]);
  const csrf = decodeURIComponent(cookies.find((value) => value.startsWith('sentinel_csrf=')).slice('sentinel_csrf='.length));
  async function call(route, method = 'GET', body) {
    const result = await fetch(base + route, { method, headers: {
      Cookie: cookies.join('; '), 'X-Sentinel': '1', 'X-CSRF-Token': csrf, Origin: base,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, data: await result.json() };
  }
  function pause(expectedReads = 1) {
    let release;
    let entered;
    let arrivals = 0;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    wait = async () => { arrivals += 1; if (arrivals >= expectedReads) entered(); await gate; };
    return { waiting, release };
  }
  return { db, store, other, client, call, pause, reads: () => readCount };
}

test('duplicate POST never overwrites enabled, approval mode, note, or revision', async (t) => {
  const f = await fixture(t);
  const created = await f.call('/api/users', 'POST', INPUT);
  assert.equal(created.status, 200);
  const saved = f.store.getUser(1);
  const duplicate = await f.call('/api/users', 'POST', { userId: 1, threshold: 10, amount: 10 });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(f.store.getUser(1), saved);
  assert.equal(f.reads(), 1, 'duplicate is rejected before an upstream lookup');
});

test('concurrent POSTs create only one rule and preserve the winning policy', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const gate = f.pause(2);
  const first = f.call('/api/users', 'POST', INPUT);
  const second = f.call('/api/users', 'POST', { ...INPUT, enabled: true, mode: 'auto', note: 'different' });
  await gate.waiting;
  assert.equal(f.reads(), 2, 'both requests passed the preliminary duplicate check');
  // Both requests are awaiting upstream, so only the transaction can prevent
  // the second completion from overwriting the winning policy.
  gate.release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results.find((r) => r.status === 200).data;
  assert.deepEqual(f.store.getUser(1), { ...winner, enabled: Number(winner.enabled) });
  assert.equal(f.store.listUsers().length, 1);
});

test('operator revocation, demotion, disablement, or reset during lookup cannot save a rule', async (t) => {
  for (const kind of ['session revoked', 'demoted', 'disabled', 'credentials reset']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const gate = f.pause();
      const pending = f.call('/api/users', 'POST', INPUT);
      await gate.waiting;
      const account = f.other.getAuthAccount('worker');
      if (kind === 'session revoked') f.other.revokeAllAuthSessions();
      else if (kind === 'credentials reset') f.other.reinviteAuthAccount({
        id: account.id, version: account.credential_version, actor: 'test', totp_ciphertext: '',
        invitation_hash: 'synthetic-token-hash', invitation_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }, () => true);
      else f.other.updateAuthAccount({ id: account.id, role: kind === 'demoted' ? 'auditor' : 'operator',
        enabled: kind !== 'disabled', version: account.credential_version, actor: 'test' }, () => true);
      gate.release();
      assert.equal((await pending).status, 403);
      assert.equal(f.store.listUsers().length, 0);
    });
  }
});

test('PATCH and DELETE require the current rule revision and preserve omitted fields', async (t) => {
  const f = await fixture(t);
  const row = (await f.call('/api/users', 'POST', INPUT)).data;
  assert.equal((await f.call('/api/users/1', 'PATCH', { amount: 12 })).status, 400);
  const changed = await f.call('/api/users/1', 'PATCH', { amount: 12, ruleRevision: row.rule_revision });
  assert.equal(changed.status, 200);
  for (const key of ['enabled', 'mode', 'note', 'threshold']) assert.equal(changed.data[key], row[key]);
  assert.notEqual(changed.data.rule_revision, row.rule_revision);
  assert.equal((await f.call('/api/users/1', 'PATCH', { enabled: true, ruleRevision: row.rule_revision })).status, 409);
  assert.equal((await f.call('/api/users/1', 'DELETE', { ruleRevision: row.rule_revision })).status, 409);
  assert.equal((await f.call('/api/users/1', 'DELETE', {})).status, 400);
  assert.equal(f.store.getUser(1).enabled, 0);
  assert.equal((await f.call('/api/users/1', 'DELETE', { ruleRevision: changed.data.rule_revision })).status, 200);
});

test('rule authorization is inside the SQLite write transaction', async (t) => {
  const f = await fixture(t);
  const authorization = { instance: INSTANCE, authorizeActor: () => {
    assert.equal(f.db.inTransaction, true);
    return false;
  } };
  assert.equal(f.store.createUser(INPUT, authorization).status, 403);
  f.store.upsertUser(INPUT);
  const row = f.store.getUser(1);
  assert.equal(f.store.updateUser({ userId: 1, enabled: true }, row.rule_revision, authorization).status, 403);
  assert.equal(f.store.removeUser(1, row.rule_revision, authorization).status, 403);
  assert.deepEqual(f.store.getUser(1), row);
});

test('HTTP operations on a mismatched instance preserve the ledger and never read the new same-ID user', async (t) => {
  const f = await fixture(t);
  const row = (await f.call('/api/users', 'POST', INPUT)).data;
  const saved = f.store.getUser(1);
  const reads = f.reads();
  f.client.baseUrl = 'https://another-instance.fixture.invalid/base';
  for (const [route, method, body] of [
    ['/api/users', 'POST', { ...INPUT, userId: 2 }],
    ['/api/users/1', 'PATCH', { enabled: true, ruleRevision: row.rule_revision }],
    ['/api/users/1', 'DELETE', { ruleRevision: row.rule_revision }],
    ['/api/users/1/topup', 'POST', { amount: 10 }],
    ['/api/proposals/missing/approve', 'POST', {}],
    ['/api/tick', 'POST', {}],
    ['/api/test-connection', 'GET', undefined],
  ]) assert.equal((await f.call(route, method, body)).status, 409, route);
  const cfg = await f.call('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.data.instanceBinding.ok, false);
  assert.equal(cfg.data.instanceBinding.status, 'mismatch');
  assert.equal((await f.call('/api/users')).status, 200, 'original local ledger remains viewable');
  assert.deepEqual(f.store.getUser(1), saved);
  assert.equal(f.reads(), reads);
});

test('unresolved records remain reachable after more than 200 newer successes with accurate filtered totals', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 240; i += 1) {
    f.store.beginTopup({ id: `row-${String(i).padStart(3, '0')}`, userId: i === 1 ? 2 : 1,
      balanceBefore: 5, amount: 10, threshold: 20, source: 'auto' });
    if (i !== 2) f.store.finishTopup({ id: `row-${String(i).padStart(3, '0')}`, status: i < 2 ? 'unknown' : 'success' });
  }
  const all = await f.call('/api/records?limit=50&offset=50');
  assert.equal(all.data.total, 240);
  assert.equal(all.data.items.length, 50);
  assert.equal(all.data.offset, 50);
  const pending = await f.call('/api/records?status=unresolved&limit=2');
  assert.equal(pending.status, 200);
  assert.equal(pending.data.total, 3);
  assert.equal(pending.data.items.length, 2);
  assert.ok(pending.data.items.every((r) => ['pending', 'unknown'].includes(r.status)));
  const filtered = await f.call('/api/records?status=unresolved&userId=2&offset=0');
  assert.equal(filtered.data.total, 1);
  assert.equal(filtered.data.items[0].id, 'row-001');
  const last = await f.call('/api/records?status=unresolved&limit=2&offset=2');
  assert.equal(last.data.total, 3);
  assert.equal(last.data.items.length, 1);
  const empty = await f.call('/api/records?status=unresolved&offset=1000');
  assert.equal(empty.data.total, 3);
  assert.deepEqual(empty.data.items, []);
  assert.equal((await f.call('/api/records?status=invalid')).status, 400);
});
