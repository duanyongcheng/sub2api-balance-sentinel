import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb, createStore } from '../src/db/store.js';
import { Reconciler } from '../src/lib/reconciliation.js';

const RECORD_ID = 'sentinel-test-1';
const adjustment = (fields = {}) => ({
  id: 42, type: 'admin_balance', value: 100, status: 'used', used_by: 1,
  used_at: '2026-10-22T00:00:00.000Z', created_at: '2026-10-22T00:00:00.000Z',
  notes: `sentinel_id=${RECORD_ID}; source=auto; before=5; threshold=20`, ...fields,
});

function setup(t, { status = 'unknown', rows = [adjustment()] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-reconcile-'));
  const file = path.join(dir, 'shared.db');
  const db = openDb(file);
  const dbB = openDb(file);
  const store = createStore(db);
  const other = createStore(dbB);
  const calls = { reads: 0, writes: 0 };
  const client = {
    baseUrl: 'https://sub2api.invalid',
    async getBalanceHistory(userId, pageSize, page) {
      assert.equal(userId, 1);
      calls.reads += 1;
      return {
        items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length,
        page, page_size: pageSize, pages: Math.max(1, Math.ceil(rows.length / pageSize)),
      };
    },
    async addBalance() { calls.writes += 1; throw new Error('reconciliation must not write upstream'); },
    redact: (value) => String(value).replaceAll('admin-secret-test', '[REDACTED]'),
  };
  store.beginTopup({ id: RECORD_ID, userId: 1, email: 'a@example.com', balanceBefore: 5, amount: 100, threshold: 20, source: 'auto', actor: 'system', providerOrigin: client.baseUrl });
  if (status !== 'pending') store.finishTopup({ id: RECORD_ID, status, httpStatus: 500, error: 'original timeout' });
  t.after(() => { dbB.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, file, store, other, client, rows, calls, reconciler: new Reconciler({ store, client }) };
}

test('upstream matching preserves the monetary outcome and records hashed evidence', async (t) => {
  const f = setup(t);
  const result = await f.reconciler.verify(RECORD_ID, 'auditor');
  assert.equal(result.check.outcome, 'matched');
  assert.equal(result.check.provider_reference, 'balance-history:42');
  assert.equal(result.check.actor, 'auditor');
  assert.equal(result.check.previous_status, 'unknown');
  assert.equal(result.check.evidence_sha256, crypto.createHash('sha256').update(JSON.stringify(result.check.evidence)).digest('hex'));
  assert.equal(f.store.getTopup(RECORD_ID).status, 'unknown');
  assert.equal(f.store.getTopup(RECORD_ID).verification_status, 'matched');
  assert.equal(f.store.unreconciled().length, 0);
  assert.equal(f.calls.writes, 0);
  const reopened = openDb(f.file);
  try {
    const check = createStore(reopened).ledgerChecks(RECORD_ID)[0];
    assert.deepEqual(check, result.check);
  } finally { reopened.close(); }
});

test('verification history is append-only and CSV export retains every check', async (t) => {
  const f = setup(t);
  await f.reconciler.verify(RECORD_ID, 'one');
  f.rows.length = 0;
  await f.reconciler.verify(RECORD_ID, 'two');
  const history = f.store.ledgerChecks(RECORD_ID);
  assert.deepEqual(history.map((check) => check.outcome), ['not_found', 'matched']);
  assert.equal([...f.store.exportLedgerChecks(RECORD_ID)].length, 2);
  assert.throws(() => f.db.prepare('UPDATE ledger_checks SET actor = ?').run('attacker'), /append-only/);
  assert.throws(() => f.db.exec('DELETE FROM ledger_checks'), /append-only/);
});

test('the marker must uniquely identify a used adjustment for the same user and amount', async (t) => {
  const cases = [
    ['wrong user', { used_by: 2 }], ['string user ID', { used_by: '1' }],
    ['wrong amount', { value: 99 }], ['numeric string amount', { value: '100' }],
    ['negative adjustment', { value: -100 }], ['wrong type', { type: 'balance' }],
    ['not used', { status: 'unused' }], ['no timestamp', { used_at: null }],
    ['bad timestamp', { used_at: 'yesterday' }],
    ['two markers in one adjustment', { notes: `sentinel_id=${RECORD_ID}; sentinel_id=another` }],
  ];
  for (const [name, fields] of cases) {
    await t.test(name, async (t) => {
      const f = setup(t, { rows: [adjustment(fields)] });
      const { check } = await f.reconciler.verify(RECORD_ID, 'auditor');
      assert.equal(check.outcome, 'mismatch');
      assert.equal(f.store.getTopup(RECORD_ID).status, 'unknown');
      assert.equal((await f.reconciler.resolveApplied(RECORD_ID, 'auditor')).ok, false);
      assert.equal(f.calls.writes, 0);
    });
  }
});

test('missing, partial, or duplicate correlation markers never prove a credit', async (t) => {
  for (const notes of ['manual payment', `sentinel_id=${RECORD_ID}-extra`, `prefixsentinel_id=${RECORD_ID}`]) {
    await t.test(notes, async (t) => {
      const f = setup(t, { rows: [adjustment({ notes })] });
      assert.equal((await f.reconciler.verify(RECORD_ID, 'auditor')).check.outcome, 'not_found');
    });
  }
  await t.test('two matching adjustments', async (t) => {
    const f = setup(t, { rows: [adjustment(), adjustment({ id: 43 })] });
    assert.equal((await f.reconciler.verify(RECORD_ID, 'auditor')).check.outcome, 'mismatch');
    assert.equal((await f.reconciler.resolveApplied(RECORD_ID, 'auditor')).ok, false);
  });
});

test('history scans follow pagination and do not silently accept truncated or unstable results', async (t) => {
  const rows = Array.from({ length: 100 }, (_, i) => adjustment({ id: 1000 + i, notes: 'unrelated' }));
  rows.push(adjustment());
  await t.test('matching second page', async (t) => {
    const f = setup(t, { rows });
    assert.equal((await f.reconciler.verify(RECORD_ID, 'auditor')).check.outcome, 'matched');
    assert.equal(f.calls.reads, 2);
  });
  await t.test('truncated scan, even with a candidate', async (t) => {
    const many = Array.from({ length: 1001 }, (_, i) => adjustment({ id: 1000 + i, notes: 'unrelated' }));
    many[0] = adjustment();
    const f = setup(t, { rows: many });
    const { check } = await f.reconciler.verify(RECORD_ID, 'auditor');
    assert.equal(check.outcome, 'incomplete');
    assert.equal(check.evidence.complete, false);
    assert.equal(f.calls.reads, 10);
  });
  await t.test('overlapping pages', async (t) => {
    const f = setup(t, { rows: [...rows, adjustment({ id: 1000, notes: 'unrelated' })] });
    assert.equal((await f.reconciler.verify(RECORD_ID, 'auditor')).check.outcome, 'incomplete');
  });
  await t.test('total changes while scanning', async (t) => {
    const f = setup(t, { rows });
    const original = f.client.getBalanceHistory;
    f.client.getBalanceHistory = async (...args) => {
      const result = await original(...args);
      if (args[2] === 2) result.total += 1;
      return result;
    };
    assert.equal((await f.reconciler.verify(RECORD_ID, 'auditor')).check.outcome, 'incomplete');
  });
});

test('upstream failures are recorded without exposing credentials or changing ledger status', async (t) => {
  const f = setup(t);
  f.client.getBalanceHistory = async () => { throw new Error('bad admin-secret-test'); };
  const { check } = await f.reconciler.verify(RECORD_ID, 'auditor');
  assert.equal(check.outcome, 'error');
  assert.equal(JSON.stringify(check).includes('admin-secret-test'), false);
  assert.equal(f.store.getTopup(RECORD_ID).status, 'unknown');
});

test('changing the configured deployment cannot verify a previous deployment ledger', async (t) => {
  const f = setup(t);
  f.client.baseUrl = 'https://another-sub2api.invalid';
  assert.equal((await f.reconciler.verify(RECORD_ID, 'auditor')).check.outcome, 'mismatch');
  assert.equal((await f.reconciler.resolveApplied(RECORD_ID, 'auditor')).ok, false);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.store.getTopup(RECORD_ID).status, 'unknown');
});

test('concurrent duplicate scans are refused instead of multiplying upstream requests', async (t) => {
  const f = setup(t);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const original = f.client.getBalanceHistory;
  f.client.getBalanceHistory = async (...args) => { await gate; return original(...args); };
  const first = f.reconciler.verify(RECORD_ID, 'one');
  const second = await f.reconciler.verify(RECORD_ID, 'two');
  assert.equal(second.ok, false);
  resume();
  assert.equal((await first).check.outcome, 'matched');
  assert.equal(f.calls.reads, 1);
});

test('confirming applied uses fresh evidence, preserves the original error, and never sends money', async (t) => {
  for (const status of ['pending', 'unknown', 'failed']) {
    await t.test(status, async (t) => {
      const f = setup(t, { status });
      const outcome = await f.reconciler.resolveApplied(RECORD_ID, 'auditor');
      assert.equal(outcome.ok, true);
      assert.equal(outcome.record.status, 'success');
      assert.equal(outcome.record.provider_reference, 'balance-history:42');
      assert.equal(outcome.record.balance_after, null, 'never invent a historic post-balance');
      assert.equal(outcome.record.error, status === 'pending' ? null : 'original timeout');
      assert.equal(outcome.resolution.previous_status, status);
      assert.equal(outcome.resolution.actor, 'auditor');
      assert.equal(f.store.unreconciled().length, 1);
      assert.equal(f.calls.writes, 0);
      assert.equal(f.store.unresolvedTopupForUser(1), undefined);
      assert.equal((await f.reconciler.resolveApplied(RECORD_ID, 'another')).ok, false);
      f.store.finishTopup({ id: RECORD_ID, status: 'unknown', error: 'late worker' });
      assert.equal(f.store.getTopup(RECORD_ID).status, 'success');
      assert.equal(f.store.getTopup(RECORD_ID).error, status === 'pending' ? null : 'original timeout');
    });
  }
});

test('a prior browser match cannot authorize resolution after the upstream evidence disappears', async (t) => {
  const f = setup(t);
  assert.equal((await f.reconciler.verify(RECORD_ID, 'auditor')).check.outcome, 'matched');
  f.rows.length = 0;
  const outcome = await f.reconciler.resolveApplied(RECORD_ID, 'auditor');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.check.outcome, 'not_found');
  assert.equal(f.store.getTopup(RECORD_ID).status, 'unknown');
  assert.ok(f.store.unresolvedTopupForUser(1));
});

test('cross-process money locks and concurrent resolutions cannot be bypassed', async (t) => {
  const f = setup(t);
  assert.equal(f.other.acquireTopupLock(1, 'active-write', '1970-01-01T00:00:00.000Z'), true);
  assert.equal((await f.reconciler.resolveApplied(RECORD_ID, 'auditor')).ok, false);
  assert.equal(f.calls.reads, 0);
  f.other.releaseTopupLock(1, 'active-write');
  const second = new Reconciler({ store: f.other, client: f.client });
  const results = await Promise.all([f.reconciler.resolveApplied(RECORD_ID, 'one'), second.resolveApplied(RECORD_ID, 'two')]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(f.store.ledgerChecks(RECORD_ID).filter((check) => check.kind === 'resolution_applied').length, 1);
  assert.equal(f.calls.writes, 0);
});

test('an upstream adjustment cannot be assigned to two separate ledger attempts', async (t) => {
  const f = setup(t);
  f.store.beginTopup({ id: 'another', userId: 1, email: 'a@example.com', balanceBefore: 5, amount: 100, threshold: 20, source: 'manual' });
  f.store.finishTopup({ id: 'another', status: 'success', providerReference: 'balance-history:42' });
  const outcome = await f.reconciler.resolveApplied(RECORD_ID, 'auditor');
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /already assigned/);
  assert.equal(f.store.getTopup(RECORD_ID).status, 'unknown');
});

test('resolution also consumes the linked processing proposal without permitting approval again', async (t) => {
  const f = setup(t);
  const rule = f.store.upsertUser({ userId: 1, email: 'a@example.com', threshold: 20, amount: 100, mode: 'approval' });
  f.store.createProposal({ id: 'p1', userId: 1, email: rule.email, balance: 5, threshold: 20, amount: 100, ruleRevision: rule.rule_revision });
  f.store.claimProposal('p1');
  f.db.prepare('UPDATE topup_records SET proposal_id = ? WHERE id = ?').run('p1', RECORD_ID);
  assert.equal((await f.reconciler.resolveApplied(RECORD_ID, 'auditor')).ok, true);
  assert.equal(f.store.getProposal('p1').status, 'approved');
  assert.equal(f.store.claimProposal('p1'), null);
});

test('CLI verification and confirmation use the same evidence path and require an explicit ID confirmation', async (t) => {
  const f = setup(t);
  let writes = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET') { writes += 1; res.statusCode = 400; res.end('{"code":400}'); return; }
    assert.equal(req.headers['x-api-key'], 'admin-cli-test');
    assert.equal(req.url, '/api/v1/admin/users/1/balance-history?page=1&page_size=100');
    res.end(JSON.stringify({ code: 0, data: { items: [adjustment()], total: 1, page: 1, page_size: 100, pages: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  // This fixture represents a pre-origin-migration record.
  f.db.prepare('UPDATE topup_records SET provider_origin = NULL WHERE id = ?').run(RECORD_ID);
  const env = {
    ...process.env, SUB2API_BASE_URL: base, SUB2API_ADMIN_API_KEY: 'admin-cli-test', SUB2API_ADMIN_API_KEY_FILE: '',
    SENTINEL_DB_PATH: f.file, NOTIFY_WEBHOOK_URL: '', NOTIFY_WEBHOOK_URL_FILE: '',
    SENTINEL_ADMIN_PASSWORD_HASH: '', SENTINEL_ADMIN_PASSWORD_HASH_FILE: '',
    SENTINEL_ADMIN_TOTP_SECRET: '', SENTINEL_ADMIN_TOTP_SECRET_FILE: '',
  };
  const invoke = (...args) => promisify(execFile)(process.execPath, ['server/src/cli.js', ...args], { env, cwd: path.resolve(import.meta.dirname, '../..') });
  const checked = await invoke('verify', RECORD_ID);
  assert.match(checked.stdout, /^matched:/);
  const history = JSON.parse((await invoke('checks', RECORD_ID)).stdout);
  assert.equal(history[0].actor, 'cli');
  await assert.rejects(() => invoke('resolve-applied', RECORD_ID), (error) => error.code === 1 && error.stderr.includes('--confirm'));
  assert.equal(f.store.getTopup(RECORD_ID).status, 'unknown');
  assert.match((await invoke('resolve-applied', RECORD_ID, `--confirm=${RECORD_ID}`)).stdout, /no money request sent/);
  assert.equal(f.store.getTopup(RECORD_ID).status, 'success');
  assert.equal(f.store.ledgerChecks(RECORD_ID)[0].actor, 'cli');
  assert.equal(writes, 0);
});
