import test from 'node:test';
import assert from 'node:assert/strict';
import { decideTopUp, checkGuards, startOfTodayIso, money } from '../src/lib/logic.js';

test('tops up when balance is strictly below threshold', () => {
  const d = decideTopUp({ balance: 19.99, threshold: 20, amount: 100 });
  assert.equal(d.action, 'topup');
  assert.equal(d.amount, 100);
});

test('does not top up when balance equals threshold', () => {
  assert.equal(decideTopUp({ balance: 20, threshold: 20, amount: 100 }).action, 'skip');
});

test('does not top up when balance is above threshold', () => {
  assert.equal(decideTopUp({ balance: 20.01, threshold: 20, amount: 100 }).action, 'skip');
});

test('float noise near the threshold does not trigger a spurious top-up', () => {
  // 0.1 + 0.2 style drift leaves a balance of 19.999999999999996 when the user
  // is really at 20. Charging them a top-up for that would be wrong.
  assert.equal(decideTopUp({ balance: 0.1 + 0.2 - 20 + 20 + 19.999999999999996, threshold: 20, amount: 100 }).action, 'skip');
  assert.equal(decideTopUp({ balance: 19.9999999999, threshold: 20, amount: 100 }).action, 'skip');
  // But a genuinely low balance still triggers.
  assert.equal(decideTopUp({ balance: 19.99, threshold: 20, amount: 100 }).action, 'topup');
});

test('skips a disabled user', () => {
  assert.equal(decideTopUp({ balance: 0, threshold: 20, amount: 100, enabled: false }).action, 'skip');
});

test('skips when a top-up is still pending', () => {
  const lastTopUp = { status: 'pending', created_at: new Date().toISOString() };
  assert.equal(decideTopUp({ balance: 0, threshold: 20, amount: 100, lastTopUp }).action, 'skip');
});

test('an old pending top-up remains blocked until a human resolves it', () => {
  const lastTopUp = { status: 'pending', created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() };
  const decision = decideTopUp({ balance: 0, threshold: 20, amount: 100, lastTopUp });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /needs review/);
});

test('does not retry an unknown-outcome top-up', () => {
  const lastTopUp = { status: 'unknown', created_at: new Date().toISOString() };
  const d = decideTopUp({ balance: 0, threshold: 20, amount: 100, lastTopUp });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /unknown/);
});

test('an old unknown top-up remains blocked until a human resolves it', () => {
  const lastTopUp = { status: 'unknown', created_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() };
  const decision = decideTopUp({ balance: 0, threshold: 20, amount: 100, lastTopUp });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /needs review/);
});

test('a long-past failure does not block future top-ups', () => {
  const lastTopUp = { status: 'failed', created_at: new Date(Date.now() - 86400_000).toISOString() };
  assert.equal(decideTopUp({ balance: 0, threshold: 20, amount: 100, lastTopUp }).action, 'topup');
});

test('rejects non-positive threshold or amount', () => {
  assert.equal(decideTopUp({ balance: 0, threshold: 0, amount: 100 }).action, 'skip');
  assert.equal(decideTopUp({ balance: 0, threshold: 20, amount: 0 }).action, 'skip');
});

test('guards block amounts above the per-event cap', () => {
  const g = { maxTopUpAmountPerEvent: 100, maxTopUpsPerUserPerDay: 5, maxTopUpTotalPerDay: 1000 };
  assert.equal(checkGuards({ amount: 101, userTopUpCountToday: 0, userTotalToday: 0, globalTotalToday: 0, guard: g }).ok, false);
  assert.equal(checkGuards({ amount: 100, userTopUpCountToday: 0, userTotalToday: 0, globalTotalToday: 0, guard: g }).ok, true);
});

test('guards block beyond the per-user daily count', () => {
  const g = { maxTopUpAmountPerEvent: 100, maxTopUpsPerUserPerDay: 5, maxTopUpTotalPerDay: 1000 };
  const r = checkGuards({ amount: 100, userTopUpCountToday: 5, userTotalToday: 500, globalTotalToday: 500, guard: g });
  assert.equal(r.ok, false);
  assert.match(r.reason, /count cap/);
});

test('guards block beyond the global daily total', () => {
  const g = { maxTopUpAmountPerEvent: 100, maxTopUpsPerUserPerDay: 5, maxTopUpTotalPerDay: 1000 };
  const r = checkGuards({ amount: 100, userTopUpCountToday: 0, userTotalToday: 0, globalTotalToday: 950, guard: g });
  assert.equal(r.ok, false);
  assert.match(r.reason, /global daily/);
});

test('startOfTodayIso is midnight UTC', () => {
  const iso = startOfTodayIso(new Date('2026-10-21T13:45:00+08:00'));
  const d = new Date(iso);
  assert.equal(d.getUTCHours(), 0);
  assert.equal(d.getUTCMinutes(), 0);
});

test('money rounds to 8 decimals', () => {
  assert.equal(money(100.123456789), 100.12345679);
  assert.equal(money('5'), 5);
});
