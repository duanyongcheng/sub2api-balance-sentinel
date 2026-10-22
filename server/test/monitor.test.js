import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, createStore } from '../src/db/store.js';
import { Monitor } from '../src/lib/monitor.js';
import { Sub2ApiClient } from '../src/lib/sub2api.js';
import { Sub2ApiError } from '../src/lib/sub2api.js';
import { config } from '../src/config.js';

// Credit-writing tests opt in explicitly; the production default is fail-closed.
config.monitor.autoTopUpEnabled = true;

/**
 * A stand-in for sub2api that implements the real contract:
 *  - GET  /api/v1/admin/users/:id
 *  - POST /api/v1/admin/users/:id/balance  (operation: add, atomic, idempotent)
 */
function mockSub2Api({ failMode = null } = {}) {
  const users = new Map();
  const idem = new Map();
  const calls = { writes: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, obj) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };

    if (req.headers['x-api-key'] !== 'admin-testkey') return send(401, { code: 401, reason: 'INVALID_ADMIN_KEY' });
    if (failMode === 'compliance-required') {
      return send(423, { code: 'ADMIN_COMPLIANCE_ACK_REQUIRED', message: 'administrator compliance acknowledgement is required' });
    }

    let m = url.pathname.match(/^\/api\/v1\/admin\/users\/(\d+)$/);
    if (m && req.method === 'GET') {
      const u = users.get(Number(m[1]));
      return u ? send(200, { code: 0, data: u }) : send(404, { code: 404, message: 'not found' });
    }

    m = url.pathname.match(/^\/api\/v1\/admin\/users\/(\d+)\/balance$/);
    if (m && req.method === 'POST') {
      const key = req.headers['idempotency-key'];
      if (!key) return send(400, { code: 400, reason: 'IDEMPOTENCY_KEY_REQUIRED' });
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        // Simulated partial failure: applied server-side, then connection drops.
        if (failMode === 'apply-then-500') {
          const u = users.get(Number(m[1]));
          if (u) u.balance = Number((u.balance + payload.balance).toFixed(8));
          calls.writes += 1;
          res.statusCode = 500;
          return res.end('gateway error');
        }
        if (failMode === 'html-200') {
          calls.writes += 1;
          res.setHeader('content-type', 'text/html');
          return res.end('<html>Proxy sign-in page</html>');
        }
        if (idem.has(key)) {
          res.setHeader('x-idempotency-replayed', 'true');
          return send(200, { code: 0, data: idem.get(key) });
        }
        const u = users.get(Number(m[1]));
        if (!u) return send(404, { code: 404, message: 'not found' });
        if (!(payload.balance > 0)) return send(400, { code: 400, message: 'balance must be > 0' });
        if (payload.operation !== 'add') return send(400, { code: 400, message: 'bad op' });
        u.balance = Number((u.balance + payload.balance).toFixed(8));
        calls.writes += 1;
        idem.set(key, u);
        send(200, { code: 0, data: u });
      });
      return;
    }
    send(404, { code: 404 });
  });

  return {
    users,
    calls,
    start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    stop: () => new Promise((r) => server.close(r)),
  };
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-'));
  return createStore(openDb(path.join(dir, 'test.db')));
}

function quietMonitor(store, client) {
  return new Monitor({ store, client, logger: { log() {}, warn() {}, error() {} } });
}

test('tops up a low-balance user and records before/after', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore();
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });

  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });
  const monitor = quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' }));
  await monitor.tick();

  assert.equal(mock.users.get(1).balance, 105);
  const [rec] = store.recentTopups({});
  assert.equal(rec.status, 'success');
  assert.equal(rec.balance_before, 5);
  assert.equal(rec.balance_after, 105);
  assert.equal(rec.amount, 100);
  await mock.stop();
});

test('upstream compliance guard blocks polling without reserving or sending a credit', async (t) => {
  const mock = mockSub2Api({ failMode: 'compliance-required' });
  const base = await mock.start();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-compliance-'));
  const db = openDb(path.join(directory, 'ledger.db'));
  const store = createStore(db);
  t.after(async () => {
    await mock.stop();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });
  const monitor = quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' }));

  await monitor.tick();

  assert.equal(mock.users.get(1).balance, 5);
  assert.equal(mock.calls.writes, 0);
  assert.equal(store.countTopupRecords(), 0);
  assert.equal(monitor.getUserObservation(1), null);
  assert.ok(store.recentEvents().some((event) => event.kind === 'check_failed' && event.message.includes('compliance')));
});

test('does not top up a user above the threshold', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore();
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 50 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });

  await quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' })).tick();
  assert.equal(mock.users.get(1).balance, 50);
  assert.equal(mock.calls.writes, 0);
  await mock.stop();
});

test('only touches whitelisted users', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore();
  mock.users.set(1, { id: 1, email: 'monitored@example.com', balance: 0 });
  mock.users.set(2, { id: 2, email: 'stranger@example.com', balance: 0 });
  store.upsertUser({ userId: 1, email: 'monitored@example.com', threshold: 20, amount: 100 });

  await quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' })).tick();
  assert.equal(mock.users.get(1).balance, 100);
  assert.equal(mock.users.get(2).balance, 0, 'non-monitored user must never be credited');
  await mock.stop();
});

test('a second tick does not double top-up', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore();
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });

  const monitor = quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' }));
  await monitor.tick();
  await monitor.tick();
  assert.equal(mock.users.get(1).balance, 105, 'must not top up twice');
  assert.equal(mock.calls.writes, 1);
  await mock.stop();
});

test('concurrent monitors serialize per-user credits across SQLite connections', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-lock-'));
  const dbFile = path.join(dir, 'shared.db');
  const dbA = openDb(dbFile);
  const dbB = openDb(dbFile);
  const storeA = createStore(dbA);
  const storeB = createStore(dbB);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  storeA.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });
  const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' });
  const monitorA = quietMonitor(storeA, client);
  const monitorB = quietMonitor(storeB, client);

  await Promise.all([
    monitorA.performTopUp({ userId: 1, email: 'a@example.com', balanceBefore: 5, threshold: 20, amount: 100, source: 'auto' }),
    monitorB.performTopUp({ userId: 1, email: 'a@example.com', balanceBefore: 5, threshold: 20, amount: 100, source: 'auto' }),
  ]);

  assert.equal(mock.calls.writes, 1);
  assert.equal(mock.users.get(1).balance, 105);
  assert.equal(storeA.recentTopups({}).length, 1);
  dbA.close();
  dbB.close();
  await mock.stop();
});

test('the circuit breaker persists across Monitor instances and restarts', async () => {
  const store = tempStore();
  let reads = 0;
  let writes = 0;
  const client = {
    async getUser(id) { reads += 1; return { id, email: `u${id}@example.com`, balance: 1 }; },
    async addBalance() { writes += 1; throw new Sub2ApiError('rejected', { kind: 'rejected', httpStatus: 400 }); },
  };
  const first = quietMonitor(store, client);
  for (let userId = 1; userId <= 4; userId += 1) {
    store.upsertUser({ userId, email: `u${userId}@example.com`, threshold: 10, amount: 1 });
  }
  for (let userId = 1; userId <= 3; userId += 1) {
    const result = await first.performTopUp({ userId, email: `u${userId}@example.com`, balanceBefore: 1, threshold: 10, amount: 1, source: 'auto' });
    assert.equal(result.ok, false);
  }
  assert.equal(store.getConsecutiveFailures(), 3);

  const beforeFourth = reads;
  const restarted = quietMonitor(store, client);
  const blocked = await restarted.performTopUp({ userId: 4, email: 'u4@example.com', balanceBefore: 1, threshold: 10, amount: 1, source: 'auto' });
  assert.equal(blocked.attempted, false);
  assert.match(blocked.reason, /circuit breaker/);
  assert.equal(reads, beforeFourth, 'the persisted breaker blocks before another upstream call');
  assert.equal(writes, 3);
  restarted.resetCircuitBreaker();
  assert.equal(store.getConsecutiveFailures(), 0);
});

test('cross-user concurrent credits cannot exceed the global daily amount cap', async () => {
  const originalCap = config.guard.maxTopUpTotalPerDay;
  config.guard.maxTopUpTotalPerDay = 100;
  const mock = mockSub2Api();
  const base = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-global-cap-'));
  const dbFile = path.join(dir, 'shared.db');
  const dbA = openDb(dbFile);
  const dbB = openDb(dbFile);
  const storeA = createStore(dbA);
  const storeB = createStore(dbB);
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 1 });
  mock.users.set(2, { id: 2, email: 'b@example.com', balance: 1 });
  storeA.upsertUser({ userId: 1, email: 'a@example.com', threshold: 10, amount: 100 });
  storeA.upsertUser({ userId: 2, email: 'b@example.com', threshold: 10, amount: 100 });
  const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' });

  try {
    const results = await Promise.all([
      quietMonitor(storeA, client).performTopUp({ userId: 1, email: 'a@example.com', balanceBefore: 1, threshold: 10, amount: 100, source: 'auto' }),
      quietMonitor(storeB, client).performTopUp({ userId: 2, email: 'b@example.com', balanceBefore: 1, threshold: 10, amount: 100, source: 'auto' }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(mock.calls.writes, 1);
    assert.equal(storeA.countTopupsSince(new Date(0).toISOString(), null).total, 100);
  } finally {
    config.guard.maxTopUpTotalPerDay = originalCap;
    dbA.close();
    dbB.close();
    await mock.stop();
  }
});

test('per-user daily cap stops repeated top-ups', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore();
  // User keeps spending, so balance returns below threshold each time.
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 1 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });

  const monitor = quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' }));
  for (let i = 0; i < 8; i += 1) {
    mock.users.get(1).balance = 1; // simulate spending down
    await monitor.tick();
  }
  // Config caps this at 5 per user per day.
  assert.equal(mock.calls.writes, 5);
  await mock.stop();
});

test('an unknown outcome is recorded as unknown and not retried', async () => {
  const mock = mockSub2Api({ failMode: 'apply-then-500' });
  const base = await mock.start();
  const store = tempStore();
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });

  const monitor = quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' }));
  await monitor.tick();

  const [rec] = store.recentTopups({});
  assert.equal(rec.status, 'unknown', 'applied-but-500 must be flagged for review, not failed');

  // Next tick must NOT silently top up again.
  await monitor.tick();
  assert.equal(mock.calls.writes, 1);
  await mock.stop();
});

test('kill switch blocks writes entirely', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore();
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 0 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });

  const monitor = quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' }));
  monitor.setKillSwitch(true);
  await monitor.tick();
  assert.equal(mock.calls.writes, 0);
  assert.equal(mock.users.get(1).balance, 0);
  await mock.stop();
});

test('ledger records what is owed, and reconciliation clears it', async () => {
  const mock = mockSub2Api();
  const base = await mock.start();
  const store = tempStore();
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 0 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });

  await quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' })).tick();

  const owed = store.unreconciled();
  assert.equal(owed.length, 1);
  assert.equal(owed[0].amount, 100);

  store.markReconciled(owed[0].id, 'paid in cash');
  assert.equal(store.unreconciled().length, 0);
  await mock.stop();
});

test('unknown outcomes cannot be marked reconciled as successful credit', () => {
  const store = tempStore();
  store.beginTopup({ id: 'unknown-1', userId: 1, email: 'a@example.com', balanceBefore: 0, amount: 100, threshold: 20, source: 'auto' });
  store.finishTopup({ id: 'unknown-1', status: 'unknown', error: 'timeout' });
  assert.equal(store.markReconciled('unknown-1', 'should not clear'), 0);
  assert.equal(store.getTopup('unknown-1').reconciled, 0);
});

test('a 200 HTML write response creates no receivable and blocks the next credit', async (t) => {
  const mock = mockSub2Api({ failMode: 'html-200' });
  const base = await mock.start();
  t.after(() => mock.stop());
  const store = tempStore();
  mock.users.set(1, { id: 1, email: 'a@example.com', balance: 5 });
  store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100 });
  const monitor = quietMonitor(store, new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-testkey' }));
  await monitor.tick();
  await monitor.tick();
  assert.equal(store.recentTopups({})[0].status, 'unknown');
  assert.equal(store.recentTopups({})[0].sub2api_status, 200);
  assert.equal(store.unreconciled().length, 0);
  assert.equal(mock.calls.writes, 1);
  assert.equal(mock.users.get(1).balance, 5);
});
