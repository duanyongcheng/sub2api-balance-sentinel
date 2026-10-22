import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This probe accepts only the runner's disposable loopback instance. It never
// takes a server address or administrator credential from a real .env file.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let stage = 'validate isolated input';
let db;
let proxy;
let directory;
try {
  assert.equal(fs.existsSync(path.join(root, '.env')), false);
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { baseUrl, adminKey } = JSON.parse(input);
  const target = new URL(baseUrl);
  assert.equal(target.protocol, 'http:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.ok(target.port);
  assert.ok(typeof adminKey === 'string' && adminKey.length >= 16);
  process.env.AUTO_TOPUP_ENABLED = 'true';
  process.env.MONITOR_ENABLED = 'false';
  const { config } = await import('../../server/src/config.js');
  const { Sub2ApiClient } = await import('../../server/src/lib/sub2api.js');
  const { Monitor } = await import('../../server/src/lib/monitor.js');
  const { Reconciler } = await import('../../server/src/lib/reconciliation.js');
  const { openDb, createStore } = await import('../../server/src/db/store.js');
  assert.equal(config.monitor.autoTopUpEnabled, true);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-real-probe-'));
  db = openDb(path.join(directory, 'ledger.db'));
  const store = createStore(db);
  const client = new Sub2ApiClient({ baseUrl, adminKey });
  const monitor = new Monitor({ store, client, logger: { log() {}, warn() {}, error() {} } });
  const reconciler = new Reconciler({ store, client });
  const checks = [];
  const passed = (name, evidence = {}) => checks.push({ name, passed: true, ...evidence });

  stage = 'create synthetic users';
  const users = {};
  for (const name of ['automatic', 'approval', 'unmonitored', 'lost-response']) {
    const response = await fetch(`${baseUrl}/api/v1/admin/users`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'x-api-key': adminKey, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ email: `${name}@example.invalid`, username: name,
        password: crypto.randomBytes(24).toString('base64url'), role: 'user', balance: 5, concurrency: 1 }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.code, 0);
    assert.ok(Number.isSafeInteger(result.data?.id));
    users[name] = result.data;
    assert.equal((await client.getUser(result.data.id)).balance, 5);
  }
  passed('create and read synthetic users through administrator API');
  const automatic = users.automatic;
  const approval = users.approval;
  store.upsertUser({ userId: automatic.id, email: automatic.email, threshold: 20, amount: 100 });
  store.upsertUser({ userId: approval.id, email: approval.email, threshold: 20, amount: 100, mode: 'approval' });

  stage = 'automatic topup and whitelist';
  await monitor.tick();
  assert.equal((await client.getUser(automatic.id)).balance, 105);
  assert.equal((await client.getUser(users.unmonitored.id)).balance, 5);
  assert.equal((await client.getUser(approval.id)).balance, 5);
  const automaticRecord = store.lastTopupForUser(automatic.id);
  assert.equal(automaticRecord.status, 'success');
  assert.equal(automaticRecord.balance_before, 5);
  assert.equal(automaticRecord.balance_after, 105);
  assert.equal(automaticRecord.amount, 100);
  await monitor.tick();
  assert.equal(store.countTopupRecords({ userId: automatic.id }), 1);
  assert.equal((await client.getUser(automatic.id)).balance, 105);
  passed('fixed automatic credit, whitelist and repeated polling', { before: 5, amount: 100, after: 105 });

  stage = 'idempotency replay';
  const replay = await client.addBalance(automatic.id, 100, {
    idempotencyKey: automaticRecord.id,
    notes: `sentinel_id=${automaticRecord.id}; source=auto; before=5; threshold=20`,
  });
  assert.equal(replay.replay, true);
  assert.equal((await client.getUser(automatic.id)).balance, 105);
  const history = await client.getBalanceHistory(automatic.id);
  assert.equal(history.items.filter((item) => item.notes?.includes(`sentinel_id=${automaticRecord.id}`)).length, 1);
  passed('same-key same-payload replay is deduplicated', { replayHeader: true, afterReplay: 105 });

  stage = 'history verification and receipt accounting';
  const verification = await reconciler.verify(automaticRecord.id, 'integration-auditor');
  assert.equal(verification.check.outcome, 'matched');
  assert.match(verification.check.provider_reference, /^balance-history:\d+$/);
  assert.equal(store.markReconciled(automaticRecord.id, 'Synthetic test receipt only', 'integration-operator'), 1);
  assert.equal(store.markReconciled(automaticRecord.id, 'Duplicate receipt', 'integration-operator'), 0);
  assert.equal(store.getTopup(automaticRecord.id).reconciled, 1);
  passed('real balance-history exact match and one-time local receipt accounting');

  stage = 'approval before spend';
  const proposal = store.pendingProposalForUser(approval.id);
  assert.equal(proposal.amount, 100);
  const approved = await monitor.approveProposal(proposal.id, 'integration-operator');
  assert.equal(approved.ok, true);
  assert.equal((await client.getUser(approval.id)).balance, 105);
  assert.equal((await monitor.approveProposal(proposal.id, 'integration-operator')).ok, false);
  assert.equal((await client.getUser(approval.id)).balance, 105);
  assert.equal((await reconciler.verify(store.lastTopupForUser(approval.id).id, 'integration-auditor')).check.outcome, 'matched');
  passed('approval is required and cannot be spent twice');

  stage = 'upstream credit with lost response';
  let writeCount = 0;
  let responsesDropped = 0;
  proxy = http.createServer(async (request, response) => {
    try {
      assert.match(request.url, /^\/api\/v1\/admin\/users\/\d+(?:\/(?:balance|balance-history))?(?:\?[^#]*)?$/);
      assert.ok(['GET', 'POST'].includes(request.method));
      let body = '';
      for await (const chunk of request) body += chunk;
      if (request.method === 'POST') writeCount += 1;
      const upstream = await fetch(baseUrl + request.url, {
        method: request.method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'x-api-key': adminKey, Accept: 'application/json', 'Content-Type': 'application/json',
          ...(request.headers['idempotency-key'] ? { 'Idempotency-Key': request.headers['idempotency-key'] } : {}) },
        body: request.method === 'POST' ? body : undefined,
      });
      const text = await upstream.text();
      if (request.method === 'POST' && responsesDropped === 0) {
        assert.equal(upstream.status, 200, 'fault injection must follow a successful real mutation');
        responsesDropped += 1;
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      response.end(text);
    } catch {
      response.destroy();
    }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyClient = new Sub2ApiClient({ baseUrl: `http://127.0.0.1:${proxy.address().port}`, adminKey });
  const lost = users['lost-response'];
  store.upsertUser({ userId: lost.id, email: lost.email, threshold: 200, amount: 10 });
  const faultMonitor = new Monitor({ store, client: proxyClient, logger: { log() {}, warn() {}, error() {} } });
  await faultMonitor.checkUser(store.getUser(lost.id));
  const unknown = store.lastTopupForUser(lost.id);
  assert.equal(responsesDropped, 1);
  assert.equal(unknown.status, 'unknown');
  assert.equal((await client.getUser(lost.id)).balance, 15);
  await faultMonitor.checkUser(store.getUser(lost.id));
  assert.equal(writeCount, 1, 'unknown must block another credit even while below threshold');
  assert.equal(store.countTopupRecords({ userId: lost.id }), 1);
  const faultReconciler = new Reconciler({ store, client: proxyClient });
  const resolved = await faultReconciler.resolveApplied(unknown.id, 'integration-operator');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.record.status, 'success');
  assert.equal(resolved.record.balance_after, null);
  assert.equal(resolved.record.error, unknown.error);
  assert.equal(writeCount, 1, 'resolution must not resubmit a credit');
  assert.equal((await client.getUser(lost.id)).balance, 15);
  passed('real credit followed by response loss stays unknown, blocks retry, and resolves without resending',
    { before: 5, amount: 10, after: 15, upstreamWriteRequests: writeCount, responsesDropped });

  stage = 'persisted evidence';
  const reopened = openDb(path.join(directory, 'ledger.db'));
  try {
    const persisted = createStore(reopened);
    assert.equal(persisted.getTopup(unknown.id).status, 'success');
    assert.equal(persisted.getTopup(unknown.id).error, unknown.error);
    assert.ok(persisted.ledgerChecks(unknown.id).some((check) => check.kind === 'resolution_applied'));
    assert.equal(persisted.getTopup(automaticRecord.id).reconciled, 1);
    assert.equal(persisted.countTopupRecords(), 3);
  } finally { reopened.close(); }
  passed('ledger and reconciliation evidence survive reopening SQLite', { ledgerRecords: 3 });
  process.stdout.write(JSON.stringify(checks));
} catch (error) {
  // Never print upstream bodies, keys, passwords, or unsanitized error objects.
  process.stderr.write(`${stage} (${error.name})\n`);
  process.exitCode = 1;
} finally {
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  db?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
}
