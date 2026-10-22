/**
 * Pure decision functions for the sentinel.
 *
 * Everything money-related lives here and is unit-tested, because these are the
 * only rules that decide whether a balance gets mutated.
 */

export const EPS = 1e-6;

/**
 * Decide whether a top-up should happen for one user at one tick.
 *
 * @returns {{action:'topup', reason:string, amount:number} | {action:'skip', reason:string}}
 */
export function decideTopUp({ balance, threshold, amount, enabled = true, lastTopUp = null, now = Date.now() }) {
  if (!enabled) return { action: 'skip', reason: 'user disabled' };
  if (!Number.isFinite(balance)) return { action: 'skip', reason: 'balance unavailable' };
  if (!(amount > 0)) return { action: 'skip', reason: 'amount must be positive' };
  if (!(threshold > 0)) return { action: 'skip', reason: 'threshold must be positive' };

  // Already funded: nothing to do. Strict "<" means balance exactly at the
  // threshold does not trigger.
  if (balance >= threshold - EPS) {
    return { action: 'skip', reason: 'balance at or above threshold' };
  }

  // Guard rail against double-firing before we have observed the result of the
  // previous attempt (e.g. process restart mid-write, or a pending 'unknown').
  if (lastTopUp) {
    if (lastTopUp.status === 'pending') {
      return { action: 'skip', reason: 'previous top-up is unresolved; needs review' };
    }
    // Ambiguous attempts are never auto-retried, regardless of age: an old
    // timeout may still have credited the account and could otherwise double it.
    if (lastTopUp.status === 'unknown') {
      return { action: 'skip', reason: 'previous attempt has unknown outcome; needs review' };
    }
  }

  return { action: 'topup', reason: 'balance below threshold', amount };
}

/**
 * Validate a proposed credit against the global hard ceilings.
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function checkGuards({ amount, userTopUpCountToday, userTotalToday, globalTotalToday, guard }) {
  if (amount > guard.maxTopUpAmountPerEvent + EPS) {
    return { ok: false, reason: `amount ${amount} exceeds per-event cap ${guard.maxTopUpAmountPerEvent}` };
  }
  if (userTopUpCountToday + 1 > guard.maxTopUpsPerUserPerDay) {
    return { ok: false, reason: `daily top-up count cap reached (${guard.maxTopUpsPerUserPerDay})` };
  }
  if (userTotalToday + amount > guard.maxTopUpTotalPerDay + EPS) {
    return { ok: false, reason: `per-user daily amount cap reached (${guard.maxTopUpTotalPerDay})` };
  }
  if (globalTotalToday + amount > guard.maxTopUpTotalPerDay + EPS) {
    return { ok: false, reason: `global daily amount cap reached (${guard.maxTopUpTotalPerDay})` };
  }
  return { ok: true };
}

/** Start of the current UTC day, as an ISO string. */
export function startOfTodayIso(now = new Date()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** Renders amounts consistently in the ledger and the UI. */
export function money(n) {
  return Math.round(Number(n) * 1e8) / 1e8;
}
