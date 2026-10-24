import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../src/config.js';
import { openDb, createStore } from '../src/db/store.js';
import { Monitor } from '../src/lib/monitor.js';
import { drainServer } from '../src/lib/shutdown.js';
import { hashPassword } from '../src/lib/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function bounded(promise, ms = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('test wait timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function fixture(t, { mode = 'auto', notifier = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-shutdown-'));
  const db = openDb(path.join(directory, 'ledger.db'));
  const store = createStore(db, { instance: { baseUrl: 'http://127.0.0.1:8080' } });
  store.upsertUser({ userId: 1, email: 'test@example.invalid', threshold: 20, amount: 100, mode });
  const state = { balance: 5, writes: 0, reads: [] };
  const client = {
    baseUrl: 'http://127.0.0.1:8080',
    async getUser(id) {
      state.reads.push(id);
      return { id, email: 'test@example.invalid', balance: state.balance };
    },
    async addBalance(id, amount) {
      state.writes += 1;
      state.balance += amount;
      return { data: { id, balance: state.balance }, replay: false, status: 200 };
    },
  };
  const monitor = new Monitor({ store, client, notifier, logger: { log() {}, warn() {}, error() {} } });
  monitor.notifierFor = () => true;
  const gates = [];
  const original = { ...config.monitor };
  config.monitor.autoTopUpEnabled = true;
  config.monitor.enabled = true;
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await monitor.stop();
    Object.assign(config.monitor, original);
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, state, client, monitor, gate() { const gate = deferred(); gates.push(gate); return gate; } };
}

test('stop cancels the boot timer and interval and does not permit restarting a draining monitor', async (t) => {
  const f = fixture(t);
  let ticks = 0;
  f.monitor.tick = async () => { ticks += 1; };
  f.monitor.start();
  assert.ok(f.monitor.startupTimer);
  assert.ok(f.monitor.timer);
  await f.monitor.stop();
  f.monitor.start();
  assert.equal(f.monitor.startupTimer, null);
  assert.equal(f.monitor.timer, null);
  await delay(1600);
  assert.equal(ticks, 0);
});

test('shutdown during a balance read creates neither a credit nor an approval proposal', async (t) => {
  for (const mode of ['auto', 'approval']) {
    await t.test(mode, async (t) => {
      const f = fixture(t, { mode });
      const entered = deferred();
      const gate = f.gate();
      const getUser = f.client.getUser;
      f.client.getUser = async (id) => { entered.resolve(); await gate.promise; return getUser(id); };
      f.store.upsertUser({ userId: 2, threshold: 20, amount: 100 });
      const tick = f.monitor.tick();
      await entered.promise;
      const stopped = f.monitor.stop();
      gate.resolve();
      await Promise.all([tick, stopped]);
      assert.deepEqual(f.state.reads, [1]);
      assert.equal(f.state.writes, 0);
      assert.equal(f.store.countTopupRecords(), 0);
      assert.equal(f.store.listProposals({}).length, 0);
      await f.monitor.tick();
      assert.deepEqual(f.state.reads, [1]);
    });
  }
});

test('shutdown waits for an admitted credit, readback and its later notification before releasing the ledger', async (t) => {
  const notificationStarted = deferred();
  const notificationFinished = deferred();
  const f = fixture(t, { notifier: { topUpSuccess: () => 'test', send: async () => {
    notificationStarted.resolve(); await notificationFinished.promise;
  } } });
  const gate = f.gate();
  // Ensure cleanup can release both asynchronous dependencies after an assertion failure.
  const notificationCleanup = f.gate();
  notificationCleanup.promise.then(() => notificationFinished.resolve());
  const writeStarted = deferred();
  const addBalance = f.client.addBalance;
  f.client.addBalance = async (...args) => {
    const result = await addBalance(...args);
    writeStarted.resolve();
    await gate.promise;
    return result;
  };
  const tick = f.monitor.tick();
  await writeStarted.promise;
  let drained = false;
  const stopped = f.monitor.stop().then(() => { drained = true; });
  assert.equal(f.store.lastTopupForUser(1).status, 'pending');
  assert.equal(drained, false);
  gate.resolve();
  await notificationStarted.promise;
  assert.equal(f.store.lastTopupForUser(1).status, 'success');
  assert.equal(f.store.lastTopupForUser(1).balance_after, 105);
  assert.equal(drained, false, 'newly created notification still uses the store');
  notificationFinished.resolve();
  await Promise.all([tick, stopped]);
  assert.equal(drained, true);
  assert.equal(f.state.writes, 1);
  assert.equal(f.monitor.userLocks.size, 0);
  assert.equal(f.monitor.pendingNotifications.size, 0);
});

test('queued and new manual credits cannot begin writing after shutdown', async (t) => {
  const f = fixture(t);
  const entered = deferred();
  const gate = f.gate();
  const addBalance = f.client.addBalance;
  f.client.addBalance = async (...args) => { const result = await addBalance(...args); entered.resolve(); await gate.promise; return result; };
  const intent = { userId: 1, threshold: 20, amount: 100, source: 'manual' };
  const first = f.monitor.performTopUp(intent);
  await entered.promise;
  const queued = f.monitor.performTopUp(intent);
  const stopped = f.monitor.stop();
  const refused = await f.monitor.performTopUp(intent);
  assert.equal(refused.attempted, false);
  assert.match(refused.reason, /shutting down/);
  gate.resolve();
  assert.equal((await first).ok, true);
  const cancelled = await queued;
  assert.equal(cancelled.attempted, false);
  assert.match(cancelled.reason, /shutting down/);
  await stopped;
  assert.equal(f.state.writes, 1);
  assert.equal(f.store.countTopupRecords(), 1);
});

test('database closure waits for both HTTP handlers and background monitoring', async (t) => {
  for (const first of ['http', 'monitor']) {
    await t.test(first, async () => {
      const monitoring = deferred();
      let httpDone;
      let closed = false;
      const drain = drainServer({
        server: { close(done) { httpDone = done; }, closeAllConnections() {} },
        monitor: { stop: () => monitoring.promise }, closeDatabase() { closed = true; }, timeoutMs: 1000,
      });
      if (first === 'http') httpDone();
      else monitoring.resolve();
      await Promise.resolve();
      assert.equal(closed, false);
      if (first === 'http') monitoring.resolve();
      else httpDone();
      await drain;
      assert.equal(closed, true);
    });
  }
});

test('a shutdown timeout closes connections but never closes a database with active writers', async () => {
  const monitoring = deferred();
  let connectionsClosed = false;
  let databaseClosed = false;
  let httpDone;
  const drain = drainServer({
    server: { close(done) { httpDone = done; }, closeAllConnections() { connectionsClosed = true; } },
    monitor: { stop: () => monitoring.promise }, closeDatabase() { databaseClosed = true; }, timeoutMs: 20,
  });
  await assert.rejects(drain, /unresolved ledger entries must be verified/);
  assert.equal(connectionsClosed, true);
  assert.equal(databaseClosed, false);
  httpDone();
  monitoring.resolve();
});

test('real SIGTERM during a background HTTP credit persists the final result and ignores duplicate signals', { timeout: 15_000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-signal-'));
  const writeStarted = deferred();
  const releaseResponse = deferred();
  let writes = 0;
  let balance = 5;
  const reads = [];
  const upstream = http.createServer((request, response) => {
    const send = (code, body) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.headers['x-api-key'] !== 'synthetic-shutdown-test-key') return send(401, { code: 401 });
    const match = request.url.match(/^\/api\/v1\/admin\/users\/(\d+)(\/balance)?$/);
    if (!match) return send(404, { code: 404 });
    const id = Number(match[1]);
    if (request.method === 'GET') {
      reads.push(id);
      return send(200, { code: 0, data: { id, email: 'test@example.invalid', balance: id === 1 ? balance : 5 } });
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      balance += JSON.parse(body).balance;
      writes += 1;
      writeStarted.resolve();
      await releaseResponse.promise;
      send(200, { code: 0, data: { id, balance } });
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const portReservation = http.createServer();
  await new Promise((resolve) => portReservation.listen(0, '127.0.0.1', resolve));
  const port = portReservation.address().port;
  await new Promise((resolve) => portReservation.close(resolve));
  fs.cpSync(path.join(ROOT, 'server/src'), path.join(directory, 'server/src'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  const file = path.join(directory, 'ledger.db');
  const seeded = openDb(file);
  const seededStore = createStore(seeded, { instance: { baseUrl: `http://127.0.0.1:${upstream.address().port}` } });
  for (const userId of [1, 2]) seededStore.upsertUser({ userId, threshold: 20, amount: 100 });
  seeded.close();
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), SENTINEL_DB_PATH: file,
    SUB2API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, SUB2API_ADMIN_API_KEY: 'synthetic-shutdown-test-key',
    SENTINEL_ADMIN_USERNAME: 'test-admin', SENTINEL_ADMIN_PASSWORD_HASH: hashPassword('synthetic-shutdown-password'),
    AUTH_REQUIRE_TOTP: 'false', AUTO_TOPUP_ENABLED: 'true',
  });
  const child = spawn(process.execPath, [path.join(directory, 'server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const shutdownStarted = deferred();
  let logs = '';
  let exitState;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    logs += chunk;
    if (logs.includes('SIGTERM received')) shutdownStarted.resolve();
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => { exitState = { code, signal }; resolve(exitState); }));
  t.after(async () => {
    releaseResponse.resolve();
    if (!exitState) child.kill('SIGKILL');
    await exited;
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await bounded(Promise.race([writeStarted.promise, exited.then(() => { throw new Error('fixture exited before credit started'); })]), 8000);
  child.kill('SIGTERM');
  await bounded(shutdownStarted.promise);
  assert.equal(child.exitCode, null);
  child.kill('SIGTERM');
  releaseResponse.resolve();
  assert.deepEqual(await bounded(exited), { code: 0, signal: null });
  assert.equal(writes, 1);
  assert.equal(reads.includes(2), false, 'no next-user polling after the stop signal');
  const reopened = openDb(file);
  try {
    const record = createStore(reopened).lastTopupForUser(1);
    assert.equal(record.status, 'success');
    assert.equal(record.balance_before, 5);
    assert.equal(record.balance_after, 105);
    assert.equal(record.amount, 100);
    assert.equal(record.error, null);
  } finally { reopened.close(); }
});
