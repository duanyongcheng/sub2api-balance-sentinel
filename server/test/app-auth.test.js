import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStore } from '../src/db/store.js';
import { AuthManager, hashPassword, totpCode } from '../src/lib/auth.js';
import { createApp } from '../src/app.js';

test('dashboard APIs require login and write operations require CSRF', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-auth-app-'));
  const db = openDb(path.join(dir, 'test.db'));
  const store = createStore(db, { instance: { baseUrl: 'https://fixture.invalid' } });
  store.upsertUser({ userId: 8, email: 'cached@example.com', threshold: 5, amount: 10 });
  store.beginTopup({ id: 'sentinel-csv-1', userId: 8, email: '=HYPERLINK("https://attacker.invalid")', balanceBefore: 0, amount: 10, threshold: 5, source: 'auto', actor: 'admin' });
  store.finishTopup({ id: 'sentinel-csv-1', status: 'success', balanceAfter: 10, httpStatus: 200, providerReference: '=SUM(1,1)' });
  store.beginTopup({ id: 'sentinel-unresolved', userId: 8, email: 'cached@example.com', balanceBefore: 0, amount: 10, threshold: 5, source: 'auto', actor: 'system' });
  store.finishTopup({ id: 'sentinel-unresolved', status: 'unknown', error: 'timed out' });
  const monitor = {
    lastTick: null,
    isKillSwitchOn: () => false,
    setKillSwitch(on) { this.killSwitch = on; },
    resetCircuitBreaker() {},
    tick: async () => {},
    getUserObservation: () => ({ balance: 7, observedAt: '2026-10-22T00:00:00.000Z', stale: true }),
  };
  const auth = new AuthManager({
    store,
    username: 'admin',
    requireTotp: true,
    passwordHash: hashPassword('a-password-that-is-long-enough'),
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    sessionTtlMs: 60 * 60_000,
    idleTimeoutMs: 60 * 60_000,
    maxLoginAttempts: 5,
    loginWindowMs: 15 * 60_000,
  });
  let historyReads = 0;
  const client = {
    baseUrl: 'https://fixture.invalid',
    async getBalanceHistory(userId, pageSize, page) {
      historyReads += 1;
      return { items: [{
        id: 99, type: 'admin_balance', value: 10, status: 'used', used_by: userId,
        used_at: '2026-10-22T00:00:00.000Z', notes: 'sentinel_id=sentinel-unresolved; source=auto',
      }], total: 1, page, page_size: pageSize, pages: 1 };
    },
  };
  const server = http.createServer(createApp({ store, monitor, client, auth }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const previousPort = process.env.PORT;
  process.env.PORT = String(port);
  const base = `http://127.0.0.1:${port}`;
  const origin = base;

  t.after(async () => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);

  const privateBeforeLogin = await fetch(`${base}/api/config`);
  assert.equal(privateBeforeLogin.status, 401);
  assert.equal((await fetch(`${base}/api/records/sentinel-unresolved/checks`)).status, 401);
  assert.equal((await fetch(`${base}/api/records/sentinel-unresolved/verify`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Sentinel': '1' }, body: '{}',
  })).status, 401);

  const failedLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Sentinel': '1' },
    body: JSON.stringify({ username: 'admin', password: 'wrong', otp: '000000' }),
  });
  assert.equal(failedLogin.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Sentinel': '1' },
    body: JSON.stringify({ username: 'admin', password: 'a-password-that-is-long-enough', otp: totpCode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', Math.floor(Date.now() / 30_000)) }),
  });
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie();
  const sessionCookie = cookies.find((value) => value.startsWith('sentinel_session=')).split(';')[0];
  const csrfCookie = cookies.find((value) => value.startsWith('sentinel_csrf=')).split(';')[0];
  const cookieHeader = `${sessionCookie}; ${csrfCookie}`;
  const csrfToken = decodeURIComponent(csrfCookie.slice('sentinel_csrf='.length));

  const privateAfterLogin = await fetch(`${base}/api/config`, { headers: { Cookie: cookieHeader } });
  assert.equal(privateAfterLogin.status, 200);
  const configPayload = await privateAfterLogin.json();
  assert.equal('adminKeyHint' in configPayload, false);

  // client has no getUser implementation: dashboard refreshes must use the
  // monitor's observation rather than introducing a separate polling frequency.
  const users = await fetch(`${base}/api/users`, { headers: { Cookie: cookieHeader } });
  const userPayload = await users.json();
  assert.equal(users.status, 200);
  assert.equal(userPayload.items[0].liveBalance, 7);
  assert.equal(userPayload.items[0].balanceStale, true);
  assert.equal(userPayload.items[0].balanceObservedAt, '2026-10-22T00:00:00.000Z');

  const invalidThreshold = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookieHeader, 'Content-Type': 'application/json', 'X-Sentinel': '1', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ userId: 1, threshold: 'Infinity', amount: 10 }),
  });
  assert.equal(invalidThreshold.status, 400);

  const stringBoolean = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookieHeader, 'Content-Type': 'application/json', 'X-Sentinel': '1', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ userId: 1, threshold: 10, amount: 10, enabled: 'false' }),
  });
  assert.equal(stringBoolean.status, 400);

  const unmonitoredTopUp = await fetch(`${base}/api/users/99/topup`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookieHeader, 'Content-Type': 'application/json', 'X-Sentinel': '1', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ amount: 10 }),
  });
  assert.equal(unmonitoredTopUp.status, 404);

  const csvResponse = await fetch(`${base}/api/reconciliation.csv`, { headers: { Cookie: cookieHeader } });
  const csv = await csvResponse.text();
  assert.equal(csvResponse.status, 200);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'=SUM\(1,1\)/);

  const ledgerResponse = await fetch(`${base}/api/records.csv`, { headers: { Cookie: cookieHeader } });
  const ledgerCsv = await ledgerResponse.text();
  assert.equal(ledgerResponse.status, 200);
  assert.match(ledgerCsv, /provider_reference/);
  assert.match(ledgerCsv, /reconciled_by/);
  assert.match(ledgerCsv, /,admin,/);

  const writeHeaders = { Origin: origin, Cookie: cookieHeader, 'Content-Type': 'application/json', 'X-Sentinel': '1', 'X-CSRF-Token': csrfToken };
  const noCsrfHeaders = { ...writeHeaders };
  delete noCsrfHeaders['X-CSRF-Token'];
  assert.equal((await fetch(`${base}/api/records/sentinel-unresolved/verify`, {
    method: 'POST', headers: noCsrfHeaders, body: '{}',
  })).status, 403);
  assert.equal(historyReads, 0);
  const verified = await fetch(`${base}/api/records/sentinel-unresolved/verify`, {
    method: 'POST', headers: writeHeaders, body: JSON.stringify({ actor: 'forged-user' }),
  });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).check.actor, 'admin', 'actor comes from the authenticated session');
  assert.equal(store.getTopup('sentinel-unresolved').status, 'unknown');
  assert.equal((await fetch(`${base}/api/records/sentinel-unresolved/resolve`, {
    method: 'POST', headers: writeHeaders, body: JSON.stringify({ decision: 'not_applied', confirmation: 'sentinel-unresolved' }),
  })).status, 400);
  assert.equal((await fetch(`${base}/api/records/sentinel-unresolved/resolve`, {
    method: 'POST', headers: noCsrfHeaders, body: JSON.stringify({ decision: 'applied', confirmation: 'sentinel-unresolved' }),
  })).status, 403);
  const resolved = await fetch(`${base}/api/records/sentinel-unresolved/resolve`, {
    method: 'POST', headers: writeHeaders, body: JSON.stringify({ decision: 'applied', confirmation: 'sentinel-unresolved' }),
  });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).record.status, 'success');
  assert.equal(historyReads, 2, 'resolution must perform its own fresh history query');
  const checksResponse = await fetch(`${base}/api/records/sentinel-unresolved/checks`, { headers: { Cookie: cookieHeader } });
  const checks = (await checksResponse.json()).items;
  assert.equal(checks[0].kind, 'resolution_applied');
  assert.equal(checks[0].actor, 'admin');
  const evidenceCsv = await fetch(`${base}/api/records/sentinel-unresolved/checks.csv`, { headers: { Cookie: cookieHeader } });
  assert.equal(evidenceCsv.status, 200);
  assert.match(await evidenceCsv.text(), /evidence_sha256/);
  assert.equal((await fetch(`${base}/api/records/missing/verify`, { method: 'POST', headers: writeHeaders, body: '{}' })).status, 404);

  const missingCsrf = await fetch(`${base}/api/kill-switch`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookieHeader, 'Content-Type': 'application/json', 'X-Sentinel': '1' },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(missingCsrf.status, 403);

  const toggle = await fetch(`${base}/api/kill-switch`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookieHeader, 'Content-Type': 'application/json', 'X-Sentinel': '1', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(toggle.status, 200);
  assert.equal(monitor.killSwitch, true);

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookieHeader, 'Content-Type': 'application/json', 'X-Sentinel': '1', 'X-CSRF-Token': csrfToken },
    body: '{}',
  });
  assert.equal(logout.status, 200);

  const privateAfterLogout = await fetch(`${base}/api/config`, { headers: { Cookie: cookieHeader } });
  assert.equal(privateAfterLogout.status, 401);
});
