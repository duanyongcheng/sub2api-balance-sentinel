import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStore } from '../src/db/store.js';
import { Monitor } from '../src/lib/monitor.js';
import { config } from '../src/config.js';

config.monitor.autoTopUpEnabled = true;

function setup(t, { mode = 'auto', pauseAt = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-authorize-'));
  const db = openDb(path.join(dir, 'shared.db'));
  const dbB = openDb(path.join(dir, 'shared.db'));
  const store = createStore(db);
  const other = createStore(dbB);
  let resume;
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  let reads = 0;
  let writes = 0;
  let balance = 5;
  const client = {
    async getUser(id) {
      reads += 1;
      if (reads === pauseAt) { entered(); await gate; }
      return { id, email: 'fresh@example.com', username: 'fresh', balance };
    },
    async addBalance(id, amount) {
      writes += 1;
      balance += amount;
      return { data: { id, balance }, status: 200, replay: false };
    },
  };
  const input = { userId: 1, email: 'old@example.com', threshold: 20, amount: 100, mode };
  store.upsertUser(input);
  const monitor = new Monitor({ store, client, logger: { log() {}, warn() {}, error() {} } });
  t.after(() => { dbB.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, other, db, monitor, waiting, resume, input, counts: () => ({ reads, writes }) };
}

const mutations = [
  ['disabled user', (s, u) => s.upsertUser({ ...u, enabled: false })],
  ['deleted user', (s) => s.deleteUser(1)],
  ['approval now required', (s, u) => s.upsertUser({ ...u, mode: 'approval' })],
  ['changed amount', (s, u) => s.upsertUser({ ...u, amount: 50 })],
  ['changed threshold', (s, u) => s.upsertUser({ ...u, threshold: 10 })],
  ['delete and re-add identical rule', (s, u) => { s.deleteUser(1); s.upsertUser(u); }],
  ['kill switch engaged', (s) => s.setSetting('kill_switch', '1')],
  ['circuit opened', (s) => s.setSetting('consecutive_failures', String(config.guard.circuitBreakerFailures))],
  ['new unresolved credit', (s) => s.beginTopup({ id: 'other-write', userId: 1, email: 'a@example.com', balanceBefore: 5, amount: 100, threshold: 20, source: 'auto' })],
];

test('revalidates cross-connection authorization after the final upstream read', async (t) => {
  for (const [name, mutate] of mutations) {
    await t.test(name, async (t) => {
      const f = setup(t);
      const pending = f.monitor.performTopUp({ ...f.input, source: 'auto' });
      await f.waiting;
      mutate(f.other, f.input);
      f.resume();
      const outcome = await pending;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.attempted, false);
      assert.equal(f.counts().writes, 0);
      assert.equal(f.store.recentTopups({}).length, name === 'new unresolved credit' ? 1 : 0);
    });
  }
});

test('identity refresh never resurrects users or overwrites newly saved settings', async (t) => {
  for (const [name, mutate] of mutations.slice(0, 6)) {
    await t.test(name, async (t) => {
      const f = setup(t);
      const pending = f.monitor.tick();
      await f.waiting;
      mutate(f.other, f.input);
      const saved = f.other.getUser(1);
      f.resume();
      await pending;
      const after = f.store.getUser(1);
      assert.equal(after?.rule_revision, saved?.rule_revision);
      for (const key of ['enabled', 'mode', 'threshold', 'amount', 'note']) assert.equal(after?.[key], saved?.[key]);
      assert.equal(f.counts().writes, 0);
      assert.equal(f.store.recentTopups({}).length, 0);
    });
  }
});

test('all money paths require an enabled whitelisted user before any upstream read', async (t) => {
  for (const source of ['auto', 'manual', 'approval']) {
    for (const enabled of [false, null]) await t.test(`${source}: ${enabled === null ? 'deleted' : 'disabled'}`, async (t) => {
      const f = setup(t, { pauseAt: -1 });
      if (enabled === null) f.store.deleteUser(1);
      else f.store.upsertUser({ ...f.input, enabled });
      const result = await f.monitor.performTopUp({ ...f.input, source });
      assert.equal(result.attempted, false);
      assert.deepEqual(f.counts(), { reads: 0, writes: 0 });
    });
  }
});

test('balance observations retain their timestamp and become stale after errors', async (t) => {
  const f = setup(t, { pauseAt: -1 });
  assert.equal(f.monitor.getUserObservation(1), null);
  await f.monitor.readUser(1);
  const observed = f.monitor.getUserObservation(1);
  assert.equal(observed.balance, 5);
  assert.equal(observed.stale, false);
  f.monitor.client.getUser = async () => { throw new Error('offline'); };
  await assert.rejects(() => f.monitor.readUser(1), /offline/);
  const failed = f.monitor.getUserObservation(1);
  assert.equal(failed.balance, 5);
  assert.equal(failed.observedAt, observed.observedAt);
  assert.equal(failed.stale, true);
});

test('approvals become unusable when rules change, even if the values later match', async (t) => {
  const f = setup(t, { mode: 'approval', pauseAt: -1 });
  await f.monitor.tick();
  const [proposal] = f.store.listProposals({ status: 'pending' });
  f.other.upsertUser({ ...f.input, amount: 50 });
  f.other.upsertUser(f.input);
  assert.equal((await f.monitor.approveProposal(proposal.id)).ok, false);
  assert.equal(f.store.getProposal(proposal.id).status, 'expired');
  assert.equal(f.counts().writes, 0);
});

test('an approval in progress expires if its rule changes during the final read', async (t) => {
  const f = setup(t, { mode: 'approval', pauseAt: 3 });
  await f.monitor.tick();
  const [proposal] = f.store.listProposals({ status: 'pending' });
  const pending = f.monitor.approveProposal(proposal.id);
  await f.waiting;
  f.other.upsertUser({ ...f.input, amount: 50 });
  f.resume();
  const result = await pending;
  assert.equal(result.attempted, false);
  assert.equal(f.store.getProposal(proposal.id).status, 'expired');
  assert.equal(f.counts().writes, 0);
});

test('manual writes also recheck enabled state after their balance read', async (t) => {
  const f = setup(t);
  const pending = f.monitor.performTopUp({ ...f.input, amount: 25, source: 'manual' });
  await f.waiting;
  f.other.upsertUser({ ...f.input, enabled: false });
  f.resume();
  assert.equal((await pending).attempted, false);
  assert.equal(f.counts().writes, 0);
});

test('a reclaimed lock prevents the previous owner from sending a credit', async (t) => {
  const f = setup(t);
  const pending = f.monitor.performTopUp({ ...f.input, source: 'auto' });
  await f.waiting;
  assert.equal(f.other.acquireTopupLock(1, 'new-owner', '9999-01-01T00:00:00.000Z'), true);
  f.resume();
  assert.match((await pending).reason, /lock was lost/);
  assert.equal(f.counts().writes, 0);
  assert.equal(f.other.ownsTopupLock(1, 'new-owner'), true);
});

test('reservation authorizes inside the same transaction as the pending ledger entry', (t) => {
  const f = setup(t, { pauseAt: -1 });
  const result = f.store.reserveTopup({ id: 'reserved', ...f.input, balanceBefore: 5, source: 'auto', actor: 'test' }, () => {
    assert.equal(f.db.inTransaction, true);
    assert.equal(f.store.getTopup('reserved'), undefined);
    return { ok: false, reason: 'blocked' };
  });
  assert.equal(result.ok, false);
  assert.equal(f.store.getTopup('reserved'), undefined);
});

test('legacy pending proposals without a rule revision expire on migration', (t) => {
  const f = setup(t, { mode: 'approval', pauseAt: -1 });
  const user = f.store.getUser(1);
  f.store.createProposal({ id: 'legacy', userId: 1, email: user.email, balance: 5, threshold: 20, amount: 100, ruleRevision: user.rule_revision });
  f.db.exec('ALTER TABLE monitored_users DROP COLUMN rule_revision; ALTER TABLE proposals DROP COLUMN rule_revision');
  const migrated = openDb(f.db.name);
  try {
    const store = createStore(migrated);
    assert.ok(store.getUser(1).rule_revision);
    assert.equal(store.getProposal('legacy').status, 'expired');
  } finally { migrated.close(); }
});
