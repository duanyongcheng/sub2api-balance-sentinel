import crypto from 'node:crypto';
import { config, notifyOn } from '../config.js';
import { Sub2ApiClient, Sub2ApiError } from './sub2api.js';
import { decideTopUp, checkGuards, startOfTodayIso, money } from './logic.js';

const KILL_SWITCH_KEY = 'kill_switch';

export class Monitor {
  constructor({ store, client = new Sub2ApiClient(), logger = console, notifier = null }) {
    this.store = store;
    this.client = client;
    this.logger = logger;
    this.notifier = notifier;
    // Which notification categories are enabled (from NOTIFY_ON).
    this.notifierFor = notifyOn;
    this.timer = null;
    this.startupTimer = null;
    this.stopping = false;
    this.tickPromise = null;
    this.pendingNotifications = new Set();
    this.running = false;
    this.userLocks = new Map();
    this.observations = new Map();
    this.consecutiveFailures = this.store.getConsecutiveFailures?.() ?? 0;
    this.lastTick = null;
  }

  isKillSwitchOn() {
    return this.store.getSetting(KILL_SWITCH_KEY, '0') === '1';
  }

  getConsecutiveFailures() {
    this.consecutiveFailures = this.store.getConsecutiveFailures?.() ?? this.consecutiveFailures;
    return this.consecutiveFailures;
  }

  setKillSwitch(on, actor = 'operator') {
    this.store.setSetting(KILL_SWITCH_KEY, on ? '1' : '0');
    this.store.log(on ? 'warn' : 'info', 'kill_switch', `auto top-up ${on ? 'PAUSED' : 'RESUMED'} by operator`, null, actor);
  }

  start() {
    if (this.timer || this.stopping) return;
    if (!config.monitor.enabled) {
      this.logger.log('[monitor] disabled via MONITOR_ENABLED=false');
      return;
    }
    this.logger.log(`[monitor] starting, interval=${config.monitor.intervalMs}ms`);
    const run = () => this.tick().catch((err) => {
      this.logger.error('[monitor] scheduled tick failed:', this.client.redact ? this.client.redact(err.message) : err.message);
    });
    this.timer = setInterval(run, config.monitor.intervalMs);
    // Run once shortly after boot so the dashboard has data immediately.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      run();
    }, 1500);
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
    return this.waitForIdle();
  }

  async waitForIdle() {
    // A finishing credit may start a notification, so drain again after each batch.
    while (this.tickPromise || this.userLocks.size || this.pendingNotifications.size) {
      await Promise.allSettled([
        this.tickPromise, ...this.userLocks.values(), ...this.pendingNotifications,
      ].filter(Boolean));
    }
  }

  tick() {
    if (this.running || this.stopping) return Promise.resolve();
    this.running = true;
    this.tickPromise = this.runTick().finally(() => {
      this.running = false;
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  async runTick() {
    const users = this.store.enabledUsers();
    for (const user of users) {
      if (this.stopping) break;
      try {
        await this.checkUser(user);
      } catch (err) {
        this.store.log('error', 'check_failed', `user ${user.user_id}: ${err.message}`, user.user_id);
      }
    }
    this.lastTick = new Date().toISOString();
  }

  /** Refresh cached email/username for a monitored user. */
  async syncIdentity(user) {
    try {
      const u = await this.readUser(user.user_id);
      // Identity refresh must never restore deleted users or overwrite rules
      // changed by an operator while the upstream read was in flight.
      this.store.updateUserIdentity(user.user_id, u.email, u.username);
      return u;
    } catch (err) {
      if (err instanceof Sub2ApiError && err.httpStatus === 404) {
        this.store.log('warn', 'user_missing', `monitored user ${user.user_id} not found in sub2api`, user.user_id);
      }
      throw err;
    }
  }

  async readUser(userId) {
    try {
      const user = await this.client.getUser(userId);
      this.observations.set(userId, { balance: user.balance, observedAt: new Date().toISOString(), failed: false });
      return user;
    } catch (err) {
      const previous = this.observations.get(userId);
      this.observations.set(userId, { ...previous, failed: true });
      throw err;
    }
  }

  getUserObservation(userId) {
    const observation = this.observations.get(userId);
    if (!observation?.observedAt) return null;
    return {
      ...observation,
      stale: observation.failed || Date.now() - Date.parse(observation.observedAt) > config.monitor.intervalMs * 2,
    };
  }

  forgetUserObservation(userId) {
    this.observations.delete(userId);
  }

  async checkUser(user) {
    if (this.stopping) return;
    const u = await this.syncIdentity(user);
    if (this.stopping) return;
    const currentRule = this.store.getUser(user.user_id);
    if (!currentRule?.enabled || currentRule.rule_revision !== user.rule_revision) return;
    const balance = Number(u.balance);

    const lastTopUp = this.store.lastTopupForUser(user.user_id);
    const decision = decideTopUp({
      balance,
      threshold: user.threshold,
      amount: user.amount,
      enabled: Boolean(user.enabled),
      lastTopUp,
      now: Date.now(),
    });

    if (decision.action === 'skip') {
      if (decision.reason === 'balance at or above threshold') {
        // Self-healing: if the user recovered (e.g. paid manually), stale pending
        // proposals are noise. Close them so the queue reflects reality.
        const pending = this.store.pendingProposalForUser(user.user_id);
        if (pending) {
          this.store.expireProposalsForUser(user.user_id, 'balance recovered above threshold');
          this.store.log('info', 'proposal_expired',
            `user ${user.user_id} back above threshold; pending proposal closed`, user.user_id);
        }
        return;
      }
      // Only narrate interesting skips.
      if (['previous attempt has unknown outcome; needs review', 'previous top-up still in flight'].includes(decision.reason)) {
        this.store.log('warn', 'topup_skipped', `user ${user.user_id}: ${decision.reason}`, user.user_id);
      }
      return;
    }

    // Approval mode: propose instead of spending. Nothing is written to sub2api.
    if (user.mode === 'approval') {
      this.proposeTopUp({ userId: user.user_id, email: u.email, balance, threshold: user.threshold, amount: decision.amount, ruleRevision: user.rule_revision });
      return;
    }

    await this.performTopUp({
      userId: user.user_id,
      email: u.email,
      balanceBefore: balance,
      threshold: user.threshold,
      amount: decision.amount,
      source: 'auto',
      ruleRevision: user.rule_revision,
    });
  }

  /**
   * Record a pending proposal and tell the operator. Idempotent at the user
   * level: repeated ticks refresh the existing pending proposal instead of
   * creating a queue of duplicates.
   */
  proposeTopUp({ userId, email, balance, threshold, amount, ruleRevision }) {
    const id = `proposal-${userId}-${crypto.randomUUID()}`;
    const proposal = this.store.createProposal({ id, userId, email, balance, threshold, amount, ruleRevision });
    if (!proposal || proposal.id !== id) return proposal;
    this.store.log('warn', 'proposal_created',
      `user ${userId}: balance ${balance} < threshold ${threshold}; waiting for approval to add ${amount}`, userId);
    this.notify((n) => n.proposalCreated({ userId, email, balance, threshold, amount }), 'proposal', { userId });
    return proposal;
  }

  /** Fire-and-forget notification; failures never affect the caller. */
  notify(buildText, category, meta = {}) {
    if (!this.notifier) return;
    if (this.notifierFor && !this.notifierFor(category)) return;
    try {
      const text = buildText(this.notifier);
      const pending = Promise.resolve(this.notifier.send(text, meta)).catch(() => {});
      this.pendingNotifications.add(pending);
      pending.finally(() => this.pendingNotifications.delete(pending));
    } catch {
      // A broken message builder must not break a top-up.
    }
  }

  /**
   * Execute one top-up, recording both the pre- and post-balance.
   * Shared by the automatic monitor and the manual "top up now" action.
   */
  async performTopUp({ userId, email, balanceBefore, threshold, amount, source, ruleRevision, proposalId, authorizeActor, actor = (source === 'auto' ? 'system' : 'operator') }) {
    if (this.stopping) return { ok: false, attempted: false, reason: 'service is shutting down' };
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, attempted: false, reason: 'invalid user, balance, threshold, or amount' };
    }
    const previous = this.userLocks.get(id) || Promise.resolve();
    let releaseMemory;
    const current = new Promise((resolve) => { releaseMemory = resolve; });
    const queued = previous.then(() => current);
    this.userLocks.set(id, queued);
    await previous;
    const lockToken = `lock-${id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const staleBefore = new Date(Date.now() - Math.max(config.requestTimeoutMs * 4, 10 * 60_000)).toISOString();
    let acquired = false;
    try {
      acquired = this.store.acquireTopupLock(id, lockToken, staleBefore);
      if (!acquired) return { ok: false, attempted: false, reason: 'another top-up for this user is already in progress' };
      return await this.#performTopUp({ userId: id, email, balanceBefore, threshold, amount, source, actor, ruleRevision, proposalId, lockToken, authorizeActor });
    } finally {
      if (acquired) this.store.releaseTopupLock(id, lockToken);
      releaseMemory();
      if (this.userLocks.get(id) === queued) this.userLocks.delete(id);
    }
  }

  authorizeTopUp({ userId, threshold, amount, source, ruleRevision, proposalId, lockToken, authorizeActor }, checkLimits = false) {
    if (this.stopping) return { ok: false, reason: 'service is shutting down' };
    if (authorizeActor && !authorizeActor()) return { ok: false, invalidated: true, reason: 'operator authorization changed' };
    if (!config.monitor.autoTopUpEnabled) return { ok: false, reason: 'auto top-up disabled by configuration' };
    if (this.isKillSwitchOn()) return { ok: false, reason: 'kill switch engaged' };
    if (this.getConsecutiveFailures() >= config.guard.circuitBreakerFailures) {
      return { ok: false, reason: 'circuit breaker open' };
    }
    const user = this.store.getUser(userId);
    const invalidated = (reason) => ({ ok: false, invalidated: true, reason });
    if (!user?.enabled) return invalidated('user is not monitored or is disabled');
    if (ruleRevision && user.rule_revision !== ruleRevision) return invalidated('monitoring rule changed; run a fresh check');
    if (!['auto', 'approval', 'manual'].includes(source)) return invalidated('invalid top-up source');
    if (threshold !== user.threshold || (source !== 'manual' && amount !== user.amount)) {
      return invalidated('top-up no longer matches the authorized rule');
    }
    if (source === 'auto' && user.mode !== 'auto') return invalidated('user requires approval');
    if (source === 'approval') {
      const proposal = proposalId && this.store.getProposal(proposalId);
      if (user.mode !== 'approval' || !proposal || proposal.status !== 'processing' ||
          proposal.user_id !== userId || proposal.rule_revision !== user.rule_revision ||
          proposal.threshold_at_time !== threshold || proposal.amount !== amount) {
        return invalidated('approval no longer matches the authorized rule');
      }
    }
    if (this.store.unresolvedTopupForUser(userId)) {
      return { ok: false, reason: 'previous top-up outcome is unresolved; needs review' };
    }
    if (!this.store.ownsTopupLock(userId, lockToken)) return { ok: false, reason: 'top-up lock was lost' };
    if (checkLimits) {
      const today = startOfTodayIso();
      const userToday = this.store.countTopupsSince(today, userId);
      const globalToday = this.store.countTopupsSince(today, null);
      const guard = checkGuards({
        amount, userTopUpCountToday: userToday.n, userTotalToday: userToday.total,
        globalTotalToday: globalToday.total, guard: config.guard,
      });
      if (!guard.ok) return guard;
    }
    return { ok: true, user };
  }

  async #performTopUp({ userId, email, balanceBefore, threshold, amount, source, actor = 'system', ruleRevision, proposalId, lockToken, authorizeActor }) {
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(threshold) ||
        !(threshold > 0) || !Number.isFinite(amount) || !(money(amount) > 0)) {
      this.store.log('error', 'topup_invalid', `refusing top-up with invalid financial inputs for user ${userId}`, userId, actor);
      return { ok: false, attempted: false, reason: 'invalid user, balance, threshold, or amount' };
    }
    const intent = { userId, threshold, amount, source, ruleRevision, proposalId, lockToken, authorizeActor };
    const authorization = this.authorizeTopUp(intent);
    if (!authorization.ok) return this.blockTopUp(userId, authorization, actor);
    intent.ruleRevision = authorization.user.rule_revision;

    let currentUser;
    try {
      currentUser = await this.readUser(userId);
    } catch (err) {
      this.store.log('error', 'topup_balance_unavailable', `user ${userId}: refusing write because the current balance could not be verified: ${err.message}`, userId, actor);
      return { ok: false, attempted: false, reason: 'current balance could not be verified' };
    }
    balanceBefore = Number(currentUser.balance);
    if (!Number.isFinite(balanceBefore)) {
      this.store.log('error', 'topup_balance_invalid', `user ${userId}: refusing write because the current balance is invalid`, userId, actor);
      return { ok: false, attempted: false, reason: 'current balance is invalid' };
    }
    email = currentUser.email ?? email;
    if (source !== 'manual' && balanceBefore >= threshold - 1e-6) {
      return { ok: false, attempted: false, stale: true, reason: 'balance recovered before the top-up was sent' };
    }

    // Unique per top-up event; persisted before the write leaves this process.
    const id = `sentinel-${userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const amountRounded = money(amount);

    const reservation = this.store.reserveTopup({
      id,
      userId,
      email,
      balanceBefore,
      amount: amountRounded,
      threshold,
      source,
      actor,
      proposalId,
      providerOrigin: this.client.baseUrl ? new URL(this.client.baseUrl).origin : null,
    }, () => this.authorizeTopUp(intent, true));
    if (!reservation.ok) return this.blockTopUp(userId, reservation, actor);
    this.store.log('info', 'topup_started',
      `user ${userId}: balance ${balanceBefore} < threshold ${threshold}, adding ${amountRounded}`, userId, actor);

    let result;
    try {
      result = await this.client.addBalance(userId, amountRounded, {
        idempotencyKey: id,
        notes: `sentinel_id=${id}; source=${source}; before=${balanceBefore}; threshold=${threshold}`,
      });
    } catch (err) {
      const unknown = err instanceof Sub2ApiError ? err.kind === 'unknown' : true;
      this.consecutiveFailures = this.store.incrementConsecutiveFailures?.() ?? this.consecutiveFailures + 1;
      this.store.finishTopup({
        id,
        status: unknown ? 'unknown' : 'failed',
        httpStatus: err.httpStatus ?? null,
        error: err.message,
      });
      this.store.log('error', 'topup_failed',
        `user ${userId}: ${unknown ? 'UNKNOWN outcome' : 'failed'} — ${err.message}`, userId, actor);
      if (unknown) {
        this.notify((n) => n.topUpUnknown({ userId, email, amount: amountRounded, error: err.message }), 'unknown', { userId });
      } else {
        this.notify((n) => n.topUpFailed({ userId, email, amount: amountRounded, error: err.message }), 'failure', { userId });
      }
      return { ok: false, attempted: true, reason: err.message, unknown };
    }

    // Read back the authoritative balance rather than trusting arithmetic,
    // so the ledger reflects what the user can actually spend.
    let balanceAfter = null;
    let readbackError = null;
    try {
      const fresh = await this.readUser(userId);
      balanceAfter = Number(fresh.balance);
      if (!Number.isFinite(balanceAfter)) throw new Error('Sub2Api returned a non-finite balance on read-back');
    } catch (err) {
      readbackError = err;
      this.store.log('warn', 'readback_failed', `user ${userId}: top-up applied but balance read-back failed: ${err.message}`, userId, actor);
    }

    if (readbackError) {
      this.consecutiveFailures = this.store.incrementConsecutiveFailures?.() ?? this.consecutiveFailures + 1;
      const record = this.store.finishTopup({
        id,
        status: 'unknown',
        balanceAfter: null,
        replay: result.replay,
        httpStatus: result.status,
        providerReference: providerReference(result.data),
        error: `top-up response received but balance read-back failed: ${readbackError.message}`,
      });
      this.notify((n) => n.topUpUnknown({ userId, email, amount: amountRounded, error: readbackError.message }), 'unknown', { userId });
      return { ok: false, attempted: true, unknown: true, reason: readbackError.message, record };
    }

    this.store.resetConsecutiveFailures?.();
    this.consecutiveFailures = 0;
    const record = this.store.finishTopup({
      id,
      status: 'success',
      balanceAfter,
      replay: result.replay,
      httpStatus: result.status,
      providerReference: providerReference(result.data),
    });
    this.store.log('info', 'topup_success',
      `user ${userId}: added ${amountRounded}; ${balanceBefore} -> ${balanceAfter}${result.replay ? ' (idempotent replay)' : ''}`,
      userId, actor);
    this.notify((n) => n.topUpSuccess({
      userId, email, before: balanceBefore, after: balanceAfter, amount: amountRounded, source, replay: result.replay,
    }), 'topup', { userId });
    return { ok: true, record };
  }

  blockTopUp(userId, decision, actor) {
    this.store.log('warn', 'topup_blocked', `user ${userId}: ${decision.reason}`, userId, actor);
    if (decision.reason === 'circuit breaker open') {
      this.notify((n) => n.circuitOpen({ failures: this.consecutiveFailures }), 'circuit', { userId });
    } else {
      this.notify((n) => n.guardBlocked({ userId, reason: decision.reason }), 'failure', { userId });
    }
    return { ...decision, attempted: false };
  }

  /**
   * Operator approved a pending proposal: execute it now.
   * Re-checks the live balance first, because time has passed since the proposal
   * was raised — the user may have been topped up manually in the meantime.
   */
  async approveProposal(proposalId, actor = 'operator', authorizeActor = null) {
    if (this.stopping) return { ok: false, attempted: false, reason: 'service is shutting down' };
    if (authorizeActor && !authorizeActor()) return { ok: false, attempted: false, reason: 'operator authorization changed' };
    const proposal = this.store.getProposal(proposalId);
    if (!proposal) return { ok: false, reason: 'proposal not found' };
    if (proposal.status !== 'pending') return { ok: false, reason: `proposal already ${proposal.status}` };
    const user = this.store.getUser(proposal.user_id);
    if (!user?.enabled || user.mode !== 'approval' || user.rule_revision !== proposal.rule_revision) {
      this.store.decideProposal(proposal.id, 'expired', 'monitoring rule changed');
      return { ok: false, attempted: false, reason: 'monitoring rule changed; proposal expired' };
    }

    let fresh;
    try {
      fresh = await this.readUser(proposal.user_id);
    } catch (err) {
      return { ok: false, reason: `cannot read current balance: ${err.message}` };
    }
    const liveBalance = Number(fresh.balance);
    if (!Number.isFinite(liveBalance)) {
      this.store.log('error', 'proposal_approval_blocked', `user ${proposal.user_id}: sub2api returned an invalid balance`, proposal.user_id, actor);
      return { ok: false, reason: 'sub2api returned an invalid balance' };
    }
    if (liveBalance >= proposal.threshold_at_time) {
      // Never execute a stale intent: the reason for the top-up no longer holds.
      this.store.decideProposal(proposal.id, 'expired', `balance already ${liveBalance}, no longer below threshold`);
      this.store.log('info', 'proposal_expired',
        `user ${proposal.user_id} balance is now ${liveBalance}; proposal not executed`, proposal.user_id, actor);
      return { ok: false, reason: 'balance already recovered; proposal expired' };
    }

    // Mark decided BEFORE writing, so a crash cannot leave it re-approvable.
    const claimed = this.store.claimProposal(proposal.id);
    if (!claimed) return { ok: false, reason: 'proposal was decided concurrently' };

    const outcome = await this.performTopUp({
      userId: proposal.user_id,
      email: fresh.email,
      balanceBefore: liveBalance,
      threshold: proposal.threshold_at_time,
      amount: proposal.amount,
      source: 'approval',
      ruleRevision: proposal.rule_revision,
      proposalId: proposal.id,
      actor,
      authorizeActor,
    });
    if (outcome.ok) {
      this.store.completeProposal(proposal.id, 'approved', 'approved by operator');
    } else if (outcome.attempted) {
      // A failed/unknown write is permanently consumed by this proposal; the
      // ledger record is the source of truth and must be reviewed separately.
      this.store.completeProposal(proposal.id, 'approved', `write attempted: ${outcome.reason}`);
    } else if (outcome.invalidated || outcome.stale) {
      this.store.completeProposal(proposal.id, 'expired', outcome.reason);
    } else {
      // No money request was made (kill switch, guard, observe-only mode), so
      // keep the operator's proposal available after the blocking condition is fixed.
      this.store.reopenProposal(proposal.id, outcome.reason);
    }
    return outcome;
  }

  rejectProposal(proposalId, note, actor = 'operator') {
    const decided = this.store.decideProposal(proposalId, 'rejected', note || 'rejected by operator');
    if (!decided) return { ok: false, reason: 'proposal not found or already decided' };
    this.store.log('info', 'proposal_rejected', `proposal ${proposalId} rejected: ${note || ''}`, decided.user_id, actor);
    return { ok: true, proposal: decided };
  }

  /** Reset the breaker after a human has looked at the failures. */
  resetCircuitBreaker(actor = 'operator') {
    this.store.resetConsecutiveFailures?.();
    this.consecutiveFailures = 0;
    this.store.log('info', 'circuit_reset', 'circuit breaker reset by operator', null, actor);
  }
}

function providerReference(data) {
  if (!data || typeof data !== 'object') return null;
  const value = data.transaction_id ?? data.transactionId ?? data.adjustment_id ?? data.adjustmentId ?? data.operation_id ?? data.operationId;
  return value == null ? null : String(value).slice(0, 256);
}
