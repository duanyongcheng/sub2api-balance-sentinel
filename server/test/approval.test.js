import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, createStore } from '../src/db/store.js';
import { Monitor } from '../src/lib/monitor.js';
import { Sub2ApiClient } from '../src/lib/sub2api.js';
import { Notifier } from '../src/lib/notify.js';
import { config } from '../src/config.js';

// Tests that exercise real credit writes opt in explicitly; production defaults
// to observe-only until the operator changes AUTO_TOPUP_ENABLED.
config.monitor.autoTopUpEnabled = true;

/** Minimal sub2api stand-in: read user fields + atomic add. */
function mockSub2Api() {
  const users = new Map();
  const calls = { writes: 0 };
  const server = http.createServer((req, res) => {
    const send = (s, o) => { res.statusCode = s; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.headers['x-api-key'] !== 'k') return send(401, { code: 401 });

    let m = req.url.match(/^\/api\/v1\/admin\/users\/(\d+)$/);
    if (m && req.method === 'GET') {
      const u = users.get(Number(m[1]));
      return u ? send(200, { code: 0, data: u }) : send(404, { code: 404 });
    }
    m = req.url.match(/^\/api\/v1\/admin\/users\/(\d+)\/balance$/);
    if (m && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = JSON.parse(body || '{}');
        const u = users.get(Number(m[1]));
        if (!u) return send(404, { code: 404 });
        u.balance = Number((u.balance + p.balance).toFixed(8));
        calls.writes += 1;
        send(200, { code: 0, data: u });
      });
      return;
    }
    send(404, { code: 404 });
  });
  let base;
  return {
    users, calls,
    start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(base); })),
    stop: () => new Promise((r) => server.close(r)),
  };
}

function tempStore(baseUrl = 'https://fixture.invalid') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-approval-'));
  return createStore(openDb(path.join(dir, 'test.db')), { instance: { baseUrl } });
}

const quiet = { log() {}, warn() {}, error() {} };

function makeMonitor(store, base, notifier = null) {
  return new Monitor({ store, client: new Sub2ApiClient({ baseUrl: base, adminKey: 'k' }), logger: quiet, notifier });
}

test('approval mode creates a proposal and writes nothing', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore(base);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100, mode: 'approval' });

  await makeMonitor(store, base).tick();

  assert.equal(mock.calls.writes, 0, 'must not write in approval mode');
  assert.equal(mock.users.get(1).balance, 5);
  const pending = store.listProposals({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].amount, 100);
  assert.equal(pending[0].balance_at_proposal, 5);
  assert.equal(store.recentTopups({}).length, 0, 'ledger stays clean until approved');
  await mock.stop();
});

test('refreshing a monitored user identity does not downgrade approval mode', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore(base);
  mock.users.set(1, { id: 1, email: 'new@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'old@example.com', threshold: 20, amount: 100, mode: 'approval' });

  await makeMonitor(store, base).tick();

  assert.equal(mock.calls.writes, 0);
  assert.equal(store.getUser(1).mode, 'approval');
  assert.equal(store.listProposals({ status: 'pending' }).length, 1);
  await mock.stop();
});

test('repeated ticks do not stack duplicate proposals', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore(base);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100, mode: 'approval' });

  const monitor = makeMonitor(store, base);
  await monitor.tick();
  await monitor.tick();
  await monitor.tick();

  assert.equal(store.listProposals({ status: 'pending' }).length, 1);
  await mock.stop();
});

test('approving a proposal performs the top-up and records before/after', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore(base);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100, mode: 'approval' });

  const monitor = makeMonitor(store, base);
  await monitor.tick();
  const [p] = store.listProposals({ status: 'pending' });

  const outcome = await monitor.approveProposal(p.id);
  assert.equal(outcome.ok, true);
  assert.equal(mock.users.get(1).balance, 105);

  const [rec] = store.recentTopups({});
  assert.equal(rec.status, 'success');
  assert.equal(rec.balance_before, 5);
  assert.equal(rec.balance_after, 105);
  assert.equal(rec.source, 'approval');
  assert.equal(store.getProposal(p.id).status, 'approved');
  await mock.stop();
});

test('a proposal cannot be approved twice', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore(base);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100, mode: 'approval' });

  const monitor = makeMonitor(store, base);
  await monitor.tick();
  const [p] = store.listProposals({ status: 'pending' });

  assert.equal((await monitor.approveProposal(p.id)).ok, true);
  assert.equal((await monitor.approveProposal(p.id)).ok, false);
  assert.equal(mock.calls.writes, 1, 'double approval must not double charge');
  await mock.stop();
});

test('approving a stale proposal expires it instead of charging', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore(base);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100, mode: 'approval' });

  const monitor = makeMonitor(store, base);
  await monitor.tick();
  const [p] = store.listProposals({ status: 'pending' });

  // User pays manually in the meantime.
  mock.users.get(1).balance = 500;

  const outcome = await monitor.approveProposal(p.id);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /recovered/);
  assert.equal(mock.calls.writes, 0, 'must not top up a user who recovered');
  assert.equal(store.getProposal(p.id).status, 'expired');
  await mock.stop();
});

test('a pending proposal is closed when the balance recovers on its own', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore(base);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100, mode: 'approval' });

  const monitor = makeMonitor(store, base);
  await monitor.tick();
  assert.equal(store.listProposals({ status: 'pending' }).length, 1);

  mock.users.get(1).balance = 300;
  await monitor.tick();
  assert.equal(store.listProposals({ status: 'pending' }).length, 0);
  assert.equal(mock.calls.writes, 0);
  await mock.stop();
});

test('rejecting a proposal writes nothing', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore(base);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100, mode: 'approval' });

  const monitor = makeMonitor(store, base);
  await monitor.tick();
  const [p] = store.listProposals({ status: 'pending' });

  assert.equal(monitor.rejectProposal(p.id, '用户付现金了').ok, true);
  assert.equal(store.getProposal(p.id).status, 'rejected');
  assert.equal(mock.calls.writes, 0);
  await mock.stop();
});

// ---- notifications ----

test('notifier builds provider-specific payloads', () => {
  const mk = (format) => new Notifier({ store: null, url: 'http://x', format });
  assert.deepEqual(mk('wecom').buildBody('hi'), { msgtype: 'text', text: { content: 'hi' } });
  assert.deepEqual(mk('feishu').buildBody('hi'), { msg_type: 'text', content: { text: 'hi' } });
  assert.deepEqual(mk('slack').buildBody('hi'), { text: 'hi' });
  assert.deepEqual(mk('generic').buildBody('hi'), { text: 'hi' });
});

test('notifier posts to the webhook and treats errcode!=0 as failure', async () => {
  let received = null;
  let reply = { errcode: 0 };
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received = JSON.parse(b);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/hook`;

  const store = tempStore();
  const n = new Notifier({ store, url, format: 'wecom' });
  assert.equal(await n.send('hello'), true);
  assert.deepEqual(received, { msgtype: 'text', text: { content: 'hello' } });

  reply = { errcode: 40013, errmsg: 'invalid key' };
  assert.equal(await n.send('again'), false);

  await new Promise((r) => server.close(r));
});

test('a broken notification endpoint never throws', async () => {
  const n = new Notifier({ store: tempStore(), url: 'http://127.0.0.1:1/nope', format: 'generic', timeoutMs: 200 });
  assert.equal(await n.send('x'), false);
});

test('top-up still succeeds when notifications fail', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore(base);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });

  // Unreachable webhook: must not affect the money path.
  const notifier = new Notifier({ store, url: 'http://127.0.0.1:1/dead', format: 'generic', timeoutMs: 200 });
  await makeMonitor(store, base, notifier).tick();

  assert.equal(mock.users.get(1).balance, 105);
  assert.equal(store.recentTopups({})[0].status, 'success');
  await mock.stop();
});

test('migration adds the mode column to an old database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-migrate-'));
  const file = path.join(dir, 'old.db');
  // Simulate the previous schema (no mode column).
  const db = openDb(file);
  db.exec('ALTER TABLE monitored_users DROP COLUMN mode');
  db.exec('ALTER TABLE topup_records DROP COLUMN provider_reference');
  db.exec('ALTER TABLE topup_records DROP COLUMN provider_origin');
  db.exec('ALTER TABLE topup_records DROP COLUMN proposal_id');
  db.exec('ALTER TABLE topup_records DROP COLUMN actor');
  db.exec('ALTER TABLE topup_records DROP COLUMN reconciled_by');
  db.exec('ALTER TABLE events DROP COLUMN actor');
  db.exec('ALTER TABLE auth_sessions DROP COLUMN account_id');
  db.exec('ALTER TABLE auth_sessions DROP COLUMN account_version');
  const before = db.prepare('PRAGMA table_info(monitored_users)').all().map((c) => c.name);
  const beforeTopups = db.prepare('PRAGMA table_info(topup_records)').all().map((c) => c.name);
  const beforeEvents = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  db.close();

  assert.ok(!before.includes('mode'));
  assert.ok(!beforeTopups.includes('provider_reference'));
  assert.ok(!beforeTopups.includes('provider_origin'));
  assert.ok(!beforeTopups.includes('proposal_id'));
  assert.ok(!beforeTopups.includes('actor'));
  assert.ok(!beforeTopups.includes('reconciled_by'));
  assert.ok(!beforeEvents.includes('actor'));
  const db2 = openDb(file);
  const after = db2.prepare('PRAGMA table_info(monitored_users)').all().map((c) => c.name);
  const afterTopups = db2.prepare('PRAGMA table_info(topup_records)').all().map((c) => c.name);
  const afterEvents = db2.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  assert.ok(after.includes('mode'), 'reopening must re-add the missing column');
  assert.ok(afterTopups.includes('provider_reference'), 'reopening must re-add the reconciliation reference column');
  assert.ok(afterTopups.includes('provider_origin'));
  assert.ok(afterTopups.includes('proposal_id'));
  assert.ok(afterTopups.includes('actor'));
  assert.ok(afterTopups.includes('reconciled_by'));
  assert.ok(afterEvents.includes('actor'));
  const sessionColumns = db2.prepare('PRAGMA table_info(auth_sessions)').all().map((column) => column.name);
  assert.ok(sessionColumns.includes('account_id'));
  assert.ok(sessionColumns.includes('account_version'));
  db2.close();
});
