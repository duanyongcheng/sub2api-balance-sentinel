import crypto from 'node:crypto';
import { config } from '../config.js';
import { money } from './logic.js';
import { compatibleRecordedTarget } from './instance.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** Compare ledger attempts to upstream adjustments, never to balance deltas. */
export class Reconciler {
  constructor({ store, client }) {
    this.store = store;
    this.client = client;
    this.store.ensureInstanceBinding(client);
    this.running = new Set();
  }

  async verify(recordId, actor) {
    const record = this.store.getTopup(recordId);
    if (!record) return { ok: false, reason: 'record not found' };
    if (this.running.has(recordId)) return { ok: false, reason: 'verification is already running' };
    this.running.add(recordId);
    try {
      let finding;
      try {
        finding = await this.inspect(record);
      } catch (err) {
        finding = {
          outcome: 'error', summary: 'Could not verify the upstream history; no ledger status changed',
          evidence: { error: this.client.redact ? this.client.redact(err.message).slice(0, 1000) : 'upstream history query failed' },
        };
      }
      const check = this.store.recordVerification({ recordId, actor, ...finding });
      return { ok: true, check };
    } finally {
      this.running.delete(recordId);
    }
  }

  async inspect(record) {
    const binding = this.store.instanceBindingStatus(this.client);
    const providerOrigin = binding.configured?.baseUrl ?? null;
    if (!binding.ok || !compatibleRecordedTarget(record.provider_origin, binding.configured)) {
      return {
        outcome: 'mismatch', summary: binding.reason || 'Configured Sub2API target differs from the original attempt; no upstream query sent',
        evidence: { recordedOrigin: record.provider_origin, currentOrigin: providerOrigin, bindingStatus: binding.status },
      };
    }
    const entries = new Map();
    const candidates = [];
    let total = null;
    let pages = null;
    let scannedPages = 0;
    let stable = true;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.client.getBalanceHistory(record.user_id, PAGE_SIZE, page);
      this.store.assertInstanceBinding(this.client);
      // Defensive checks also apply to injected clients and future adapters.
      if (!Array.isArray(result?.items) || result.page !== page || result.page_size !== PAGE_SIZE ||
          !Number.isSafeInteger(result.pages) || result.pages < 1 || !Number.isSafeInteger(result.total) || result.total < 0 ||
          result.pages !== Math.max(1, Math.ceil(result.total / PAGE_SIZE)) || result.items.length > PAGE_SIZE) {
        throw new Error('Invalid upstream pagination');
      }
      if (page === 1) { total = result.total; pages = result.pages; }
      else if (total !== result.total || pages !== result.pages) stable = false;
      scannedPages += 1;
      for (const item of result.items) {
        if (!Number.isSafeInteger(item?.id) || item.id <= 0) throw new Error('Invalid upstream adjustment ID');
        if (entries.has(item.id)) { stable = false; continue; }
        entries.set(item.id, true);
        const markers = typeof item.notes === 'string'
          ? [...item.notes.matchAll(/(?:^|[;\s])sentinel_id=([^;\s]+)/g)].map((hit) => hit[1]) : [];
        if (markers.includes(record.id)) candidates.push({ item, markers });
      }
      if (page >= result.pages) break;
    }

    const complete = stable && scannedPages >= pages && entries.size === total;
    const valid = candidates.length === 1 && matches(candidates[0], record);
    let outcome;
    let summary;
    if (candidates.length > 1 || (candidates.length === 1 && !valid)) {
      outcome = 'mismatch';
      summary = 'Upstream adjustments have duplicate markers or disagree with the user, amount, type, status, or timestamp';
    } else if (!complete) {
      outcome = 'incomplete';
      summary = `History scan was truncated or changed during pagination (maximum ${MAX_PAGES * PAGE_SIZE} records); no conclusion`;
    } else if (valid) {
      outcome = 'matched';
      summary = 'Exactly one used admin balance adjustment matches the ledger ID, user, and amount';
    } else {
      outcome = 'not_found';
      summary = 'No matching adjustment was found; missing history is NOT proof that the credit was not applied';
    }
    return {
      outcome, summary,
      providerReference: outcome === 'matched' ? `balance-history:${candidates[0].item.id}` : null,
      evidence: {
        recordedOrigin: record.provider_origin ?? null, queriedOrigin: providerOrigin,
        requested: { topupId: record.id, userId: record.user_id, amount: record.amount },
        scannedPages, declaredTotal: total, scannedRecords: entries.size, complete,
        candidateCount: candidates.length,
        candidates: candidates.slice(0, 20).map(({ item }) => ({
          id: item.id, type: this.evidenceText(item.type, 64),
          value: typeof item.value === 'number' && Number.isFinite(item.value) ? item.value : null,
          status: this.evidenceText(item.status, 32),
          used_by: Number.isSafeInteger(item.used_by) ? item.used_by : null,
          used_at: this.evidenceText(item.used_at, 64),
          notes: this.evidenceText(item.notes, 2000),
        })),
      },
    };
  }

  evidenceText(value, limit) {
    if (typeof value !== 'string') return null;
    return (this.client.redact ? this.client.redact(value) : value).slice(0, limit);
  }

  async resolveApplied(recordId, actor, authorizeActor = null) {
    const binding = this.store.instanceBindingStatus(this.client);
    if (!binding.ok) return { ok: false, reason: binding.reason };
    if (authorizeActor && !authorizeActor()) return { ok: false, reason: 'operator authorization changed' };
    const record = this.store.getTopup(recordId);
    if (!record || !['pending', 'unknown', 'failed'].includes(record.status)) return { ok: false, reason: 'record is not unresolved' };
    const token = `reconcile-${crypto.randomUUID()}`;
    const staleBefore = new Date(Date.now() - Math.max(config.requestTimeoutMs * 4, 10 * 60_000)).toISOString();
    if (!this.store.acquireTopupLock(record.user_id, token, staleBefore)) {
      return { ok: false, reason: 'a money operation is still in progress; retry reconciliation later' };
    }
    try {
      // Always re-query under the shared credit lock. A stale browser check or
      // a user-supplied provider reference cannot authorize a status change.
      const verification = await this.verify(recordId, actor);
      if (!verification.ok) return verification;
      if (verification.check.outcome !== 'matched') {
        return { ok: false, reason: 'upstream evidence does not prove this credit was applied', check: verification.check };
      }
      return this.store.resolveApplied({ recordId, actor, lockToken: token, verificationId: verification.check.id, instance: this.client }, authorizeActor);
    } finally {
      this.store.releaseTopupLock(record.user_id, token);
    }
  }
}

function matches({ item, markers }, record) {
  return markers.length === 1 && item.type === 'admin_balance' && item.status === 'used' &&
    item.used_by === record.user_id && typeof item.value === 'number' && Number.isFinite(item.value) &&
    item.value > 0 && money(item.value) === money(record.amount) &&
    typeof item.used_at === 'string' && Number.isFinite(Date.parse(item.used_at));
}
