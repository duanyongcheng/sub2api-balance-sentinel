import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb, createStore } from '../src/db/store.js';
import { Monitor } from '../src/lib/monitor.js';
import { Reconciler } from '../src/lib/reconciliation.js';
import { config } from '../src/config.js';
import { instanceIdentity } from '../src/lib/instance.js';
import { Sub2ApiClient } from '../src/lib/sub2api.js';

const TARGET = { baseUrl: 'https://instance.fixture.invalid/service', instanceId: 'deployment-1' };
const RULE = { userId: 1, email: 'original@example.invalid', threshold: 20, amount: 10 };

function fixture(t, { legacy = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-instance-'));
  const file = path.join(directory, 'ledger.db');
  const db = openDb(file);
  const otherDb = openDb(file);
  const store = createStore(db, legacy ? {} : { instance: TARGET });
  const other = createStore(otherDb);
  const original = config.monitor.autoTopUpEnabled;
  config.monitor.autoTopUpEnabled = true;
  t.after(() => {
    config.monitor.autoTopUpEnabled = original;
    otherDb.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const calls = { reads: 0, writes: 0, histories: 0 };
  let balance = 5;
  const client = { ...TARGET,
    async getUser(id) { calls.reads += 1; return { id, email: 'fresh@example.invalid', balance }; },
    async addBalance(id, amount) { calls.writes += 1; balance += amount; return { data: { id, balance }, status: 200 }; },
    async getBalanceHistory() { calls.histories += 1; return { items: [], page: 1, page_size: 100, total: 0, pages: 1 }; },
  };
  const monitor = new Monitor({ store, client });
  return { db, otherDb, file, store, other, client, calls, monitor };
}

test('empty ledgers bind atomically to canonical full URL and instance ID; keys never enter the binding', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.instanceBindingStatus(f.client).expected, TARGET);
  assert.equal(f.store.instanceBindingStatus({ baseUrl: 'HTTPS://INSTANCE.FIXTURE.INVALID:443/service///', instanceId: 'deployment-1', adminKey: 'rotated' }).ok, true);
  assert.equal(f.other.ensureInstanceBinding({ baseUrl: 'https://elsewhere.invalid' }).status, 'mismatch');
  assert.deepEqual(f.store.instanceBindingStatus(f.client).expected, TARGET);
  const reopened = openDb(f.file);
  try { assert.equal(createStore(reopened).instanceBindingStatus(f.client).ok, true); } finally { reopened.close(); }
  const serialized = f.db.prepare("SELECT value FROM settings WHERE key = 'instance_binding'").get().value;
  assert.equal(serialized.includes('adminKey'), false);
  assert.deepEqual(instanceIdentity({ baseUrl: 'https://INSTANCE.FIXTURE.INVALID:443/a/../service/' }), { baseUrl: TARGET.baseUrl, instanceId: '' });
});

test('nonempty legacy ledgers never auto-bind and require explicit local confirmation with writes disabled', (t) => {
  const f = fixture(t, { legacy: true });
  // fixture() saw an empty ledger before the monitor was created; remove only
  // this synthetic binding to represent a genuine old-version ledger.
  f.db.prepare("DELETE FROM settings WHERE key = 'instance_binding'").run();
  f.store.upsertUser(RULE);
  assert.equal(f.store.ensureInstanceBinding(TARGET).status, 'unbound');
  assert.throws(() => f.store.confirmInstanceBinding(TARGET, { writesEnabled: true, confirmation: TARGET.baseUrl }), /writes|AUTO_TOPUP/);
  assert.throws(() => f.store.confirmInstanceBinding(TARGET, { writesEnabled: false, confirmation: new URL(TARGET.baseUrl).origin }), /confirmation/);
  assert.equal(f.store.instanceBindingStatus(TARGET).status, 'unbound');
  assert.equal(f.store.confirmInstanceBinding(TARGET, { writesEnabled: false, confirmation: TARGET.baseUrl }).ok, true);
  assert.equal(f.store.recentEvents()[0].kind, 'instance_bound');
  assert.deepEqual(f.calls, { reads: 0, writes: 0, histories: 0 });
});

test('authentication-only legacy ledgers require confirmation rather than silently adopting a new target', async (t) => {
  for (const state of ['account', 'login attempt', 'used TOTP']) {
    await t.test(state, (t) => {
      const f = fixture(t);
      f.db.prepare("DELETE FROM settings WHERE key = 'instance_binding'").run();
      const ts = new Date().toISOString();
      if (state === 'account') {
        f.db.prepare(`INSERT INTO auth_accounts (id, username, role, enabled,
          totp_ciphertext, created_at, updated_at, created_by)
          VALUES ('legacy', 'legacy', 'operator', 0, '', ?, ?, 'test')`).run(ts, ts);
      } else if (state === 'login attempt') {
        assert.equal(f.store.consumeLoginAttempt('synthetic-ip-hash', Date.now(), 60_000, 5), true);
      } else {
        assert.equal(f.store.consumeTotpCounter(1), true);
      }
      assert.equal(f.store.listUsers().length, 0);
      assert.equal(f.store.countTopupRecords(), 0);
      const changed = { ...TARGET, baseUrl: 'https://new-target.fixture.invalid' };
      assert.equal(f.store.ensureInstanceBinding(changed).status, 'unbound');
      assert.equal(f.other.instanceBindingStatus(TARGET).status, 'unbound');
      assert.equal(f.store.confirmInstanceBinding(TARGET, {
        writesEnabled: false, confirmation: TARGET.baseUrl,
      }).ok, true);
      assert.deepEqual(f.calls, { reads: 0, writes: 0, histories: 0 });
    });
  }
});

test('legacy confirmation refuses recorded different hosts or non-root base paths but supports legacy origin-only history', async (t) => {
  for (const recorded of ['https://another.invalid', 'https://instance.fixture.invalid/other-service', 'malformed']) {
    await t.test(recorded, (t) => {
      const f = fixture(t);
      f.db.prepare("DELETE FROM settings WHERE key = 'instance_binding'").run();
      f.store.beginTopup({ id: 'legacy', ...RULE, balanceBefore: 5, source: 'auto', providerOrigin: recorded });
      assert.throws(() => f.store.confirmInstanceBinding(TARGET, { writesEnabled: false, confirmation: TARGET.baseUrl }), /different Sub2API/);
      assert.equal(f.store.instanceBindingStatus(TARGET).status, 'unbound');
    });
  }
  await t.test('legacy origin', (t) => {
    const f = fixture(t);
    f.db.prepare("DELETE FROM settings WHERE key = 'instance_binding'").run();
    f.store.beginTopup({ id: 'legacy', ...RULE, balanceBefore: 5, source: 'auto', providerOrigin: new URL(TARGET.baseUrl).origin });
    assert.equal(f.store.confirmInstanceBinding(TARGET, { writesEnabled: false, confirmation: TARGET.baseUrl }).ok, true);
  });
});

test('changed origin, base path, and instance ID block every money path, identity refresh, proposal, and rule creation before upstream reads', async (t) => {
  for (const changed of [
    { baseUrl: 'https://another.fixture.invalid/service', instanceId: TARGET.instanceId },
    { baseUrl: 'https://instance.fixture.invalid/other', instanceId: TARGET.instanceId },
    { baseUrl: TARGET.baseUrl, instanceId: 'deployment-2' },
    { baseUrl: TARGET.baseUrl, instanceId: '' },
    { baseUrl: undefined, instanceId: TARGET.instanceId },
  ]) await t.test(JSON.stringify(changed), async (t) => {
    const f = fixture(t);
    f.store.upsertUser({ ...RULE, mode: 'approval' });
    const rule = f.store.getUser(1);
    f.store.createProposal({ id: 'proposal', ...RULE, balance: 5, ruleRevision: rule.rule_revision });
    const saved = f.store.getUser(1);
    Object.assign(f.client, changed);
    const wrong = new Monitor({ store: f.store, client: f.client });
    for (const source of ['auto', 'manual', 'approval']) {
      const out = await wrong.performTopUp({ ...RULE, source, ruleRevision: rule.rule_revision, proposalId: 'proposal' });
      assert.equal(out.attempted, false);
      assert.match(out.reason, /instance|identity/);
    }
    assert.equal((await wrong.approveProposal('proposal')).ok, false);
    assert.equal(f.store.getProposal('proposal').status, 'pending');
    await assert.rejects(() => wrong.syncIdentity(saved), /instance|identity/);
    assert.throws(() => wrong.proposeTopUp({ ...RULE, balance: 5, ruleRevision: rule.rule_revision }), /instance|identity/);
    assert.throws(() => f.store.createUser({ ...RULE, userId: 2 }, { instance: f.client }), /instance|identity/);
    assert.deepEqual(f.store.getUser(1), saved);
    assert.deepEqual(f.calls, { reads: 0, writes: 0, histories: 0 });
    assert.equal(f.store.countTopupRecords(), 0);
    assert.throws(() => f.store.confirmInstanceBinding(f.client, { writesEnabled: false, confirmation: changed.baseUrl }), /instance|identity/);
  });
});

test('unbound legacy ledger blocks reads, credits and approvals without silently initializing', async (t) => {
  const f = fixture(t);
  f.db.prepare("DELETE FROM settings WHERE key = 'instance_binding'").run();
  f.store.upsertUser(RULE);
  const monitor = new Monitor({ store: f.store, client: f.client });
  await monitor.tick();
  assert.equal(f.store.instanceBindingStatus(TARGET).status, 'unbound');
  assert.equal((await monitor.performTopUp({ ...RULE, source: 'manual' })).attempted, false);
  assert.equal((await monitor.approveProposal('not-important')).attempted, false);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.writes, 0);
});

test('cross-connection binding changes during a balance read cannot refresh identities or reserve a credit', async (t) => {
  for (const operation of ['identity', 'manual', 'approval']) await t.test(operation, async (t) => {
    const f = fixture(t);
    f.store.upsertUser({ ...RULE, mode: operation === 'approval' ? 'approval' : 'auto' });
    const rule = f.store.getUser(1);
    if (operation === 'approval') f.store.createProposal({ id: 'proposal', ...RULE, balance: 5, ruleRevision: rule.rule_revision });
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const waiting = new Promise((resolve) => { entered = resolve; });
    f.client.getUser = async (id) => { f.calls.reads += 1; entered(); await gate; return { id, email: 'wrong-instance@example.invalid', balance: 5 }; };
    const pending = operation === 'identity' ? f.monitor.syncIdentity(rule)
      : operation === 'approval' ? f.monitor.approveProposal('proposal')
        : f.monitor.performTopUp({ ...RULE, source: 'manual', ruleRevision: rule.rule_revision });
    await waiting;
    f.other.setSetting('instance_binding', JSON.stringify({ version: 1, ...TARGET, instanceId: 'other-process-target' }));
    release();
    if (operation === 'identity') await assert.rejects(() => pending, /instance differs/);
    else assert.equal((await pending).ok, false);
    assert.equal(f.store.getUser(1).email, RULE.email);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.store.countTopupRecords(), 0);
    if (operation === 'approval') assert.equal(f.store.getProposal('proposal').status, 'pending');
  });
});

test('the pending credit reservation independently rechecks binding in its SQLite transaction', (t) => {
  const f = fixture(t);
  f.other.setSetting('instance_binding', JSON.stringify({ version: 1, ...TARGET, instanceId: 'changed' }));
  let authorized = false;
  assert.throws(() => f.store.reserveTopup({ id: 'blocked', ...RULE, balanceBefore: 5, source: 'auto', instance: f.client }, () => {
    authorized = true; return { ok: true };
  }), /instance differs/);
  assert.equal(authorized, false);
  assert.equal(f.store.getTopup('blocked'), undefined);
});

test('key rotation leaves binding usable and new credits record the complete configured base path', async (t) => {
  const f = fixture(t);
  f.store.upsertUser(RULE);
  f.client.adminKey = 'synthetic-rotated-key';
  const out = await f.monitor.performTopUp({ ...RULE, source: 'manual' });
  assert.equal(out.ok, true);
  assert.equal(out.record.provider_origin, TARGET.baseUrl);
  assert.equal(f.store.instanceBindingStatus(f.client).ok, true);
  const client = new Sub2ApiClient({ ...TARGET, adminKey: 'synthetic-next-key' });
  assert.equal(f.store.instanceBindingStatus(client).ok, true);
});

test('wrong-instance reconciliation never queries upstream even when a legacy record has no saved provider origin', async (t) => {
  const f = fixture(t);
  f.store.beginTopup({ id: 'legacy', ...RULE, balanceBefore: 5, source: 'auto' });
  Object.assign(f.client, { baseUrl: 'https://wrong-instance.invalid' });
  const reconciler = new Reconciler({ store: f.store, client: f.client });
  const out = await reconciler.verify('legacy', 'test');
  assert.equal(out.check.outcome, 'mismatch');
  assert.equal((await reconciler.resolveApplied('legacy', 'test')).ok, false);
  assert.equal(f.calls.histories, 0);
  assert.equal(f.store.getTopup('legacy').status, 'pending');
});

test('fresh CLI processes fail closed on mismatched configuration before contacting a different same-ID instance', async (t) => {
  const f = fixture(t);
  f.store.upsertUser(RULE);
  f.store.beginTopup({ id: 'legacy', ...RULE, balanceBefore: 5, source: 'auto' });
  let calls = 0;
  const server = http.createServer((req, res) => { calls += 1; res.end('{"code":0}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const changed = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, SUB2API_BASE_URL: changed, SENTINEL_INSTANCE_ID: TARGET.instanceId,
    SUB2API_ADMIN_API_KEY: 'admin-synthetic-cli', SUB2API_ADMIN_API_KEY_FILE: '', SENTINEL_DB_PATH: f.file,
    NOTIFY_WEBHOOK_URL: '', NOTIFY_WEBHOOK_URL_FILE: '', AUTO_TOPUP_ENABLED: 'true', AUTH_REQUIRE_TOTP: 'false' };
  const invoke = (...args) => promisify(execFile)(process.execPath, ['server/src/cli.js', ...args], {
    env, cwd: path.resolve(import.meta.dirname, '../..'),
  });
  for (const args of [ ['tick'], ['tick', '--dry-run'], ['add', '2', '20', '10'], ['approve', 'not-important'],
    ['verify', 'legacy'], ['resolve-applied', 'legacy', '--confirm=legacy'] ]) {
    await assert.rejects(() => invoke(...args), (error) => Number.isInteger(error.code) && error.code > 0);
  }
  env.AUTO_TOPUP_ENABLED = 'false';
  await assert.rejects(() => invoke('bind-instance', `--confirm=${changed}`), (error) => error.code === 1);
  assert.equal(calls, 0);
  assert.equal(f.store.getUser(1).rule_revision, f.other.getUser(1).rule_revision);
  assert.equal(f.store.getTopup('legacy').status, 'pending');
  assert.equal(f.store.instanceBindingStatus(TARGET).ok, true);
});
