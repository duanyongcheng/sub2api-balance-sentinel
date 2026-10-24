import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, publicConfig, ROOT } from './config.js';
import { Sub2ApiError } from './lib/sub2api.js';
import { startOfTodayIso } from './lib/logic.js';
import { AuthManager, cookieValue, parseCookies } from './lib/auth.js';
import { Reconciler } from './lib/reconciliation.js';
import { AccountManager } from './lib/accounts.js';
import { InstanceBindingError } from './lib/instance.js';

const SESSION_COOKIE = 'sentinel_session';

/**
 * The sentinel holds a full-admin sub2api credential, so its own HTTP surface
 * must be treated as privileged. Protections:
 *  1. Binds to 127.0.0.1 by default (see config); in Docker the compose file
 *     publishes the port on the host loopback only.
 *  2. Requires same-origin for every mutating request, so it cannot be driven
 *     by a random web page the operator happens to open (CSRF).
 *  3. Validates Host header to block DNS-rebinding.
 *
 * The allowed Host set is explicit. Wildcard `HOST=0.0.0.0` is deliberately NOT
 * trusted as a Host value, because that would accept any Host header and defeat
 * DNS-rebinding protection.
 */
function allowedHosts() {
  const ports = new Set([String(config.server.port)]);
  const port = process.env.PORT;
  if (port) ports.add(String(port));

  const hosts = new Set();
  for (const p of ports) {
    hosts.add(`localhost:${p}`);
    hosts.add(`127.0.0.1:${p}`);
    hosts.add(`[::1]:${p}`);
  }
  // The configured bind address, when it is a concrete address.
  if (config.server.host && !['0.0.0.0', '::', 'localhost'].includes(config.server.host)) {
    for (const p of ports) hosts.add(`${config.server.host}:${p}`);
  }
  // Host port(s) forwarded from the container's published port. Inside Docker
  // the browser sends the *published* port, not the container's PORT.
  for (const p of (config.server.publishedPorts || '').split(',')) {
    const value = p.trim();
    if (!value) continue;
    hosts.add(`localhost:${value}`);
    hosts.add(`127.0.0.1:${value}`);
    hosts.add(`[::1]:${value}`);
  }
  // Behind a reverse proxy: an explicit allow-list supplied by the operator.
  for (const extra of (config.server.allowedHosts || '').split(',')) {
    const value = extra.trim().toLowerCase();
    if (value) hosts.add(value);
  }
  return hosts;
}

function guardOrigin(req, res, next) {
  const host = (req.headers.host || '').toLowerCase();
  const allowed = allowedHosts();
  if (!allowed.has(host)) {
    return res.status(403).json({
      error:
        `Unexpected Host header "${host}". If you front this with a reverse proxy, ` +
        'set ALLOWED_HOSTS=sentinel.example.com (comma separated, include the port if non-standard).',
    });
  }

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      if (config.auth.secureCookies && origin.toLowerCase() !== `https://${host}`) {
        return res.status(403).json({ error: 'HTTPS origin required for credential and write requests' });
      }
      const ok = [`http://${host}`, `https://${host}`].includes(origin.toLowerCase());
      if (!ok) return res.status(403).json({ error: 'Cross-origin request rejected' });
    } else if (req.headers['content-type']?.includes('application/json')) {
      // A JSON POST without Origin is non-browser (curl); allow it but require
      // an explicit header so simple form posts can never reach us.
      if (req.headers['x-sentinel'] !== '1') {
        return res.status(403).json({ error: 'Missing X-Sentinel header' });
      }
    }
  }
  next();
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function createApp({ store, monitor, client, notifier = null, auth = null, reconciler = null }) {
  store.ensureInstanceBinding(client);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(guardOrigin);

  // Root-level liveness endpoint (in addition to /api/healthz). Kept outside
  // the API router so it can never be shadowed by the SPA history fallback.
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), lastTick: monitor.lastTick });
  });

  const api = express.Router();
  const ledgerReconciler = reconciler || new Reconciler({ store, client });

  // Authentication is intentionally handled before any privileged API route.
  // The session cookie is HttpOnly; mutating requests additionally need a
  // session-bound CSRF token kept in a separate SameSite cookie.
  const authManager = auth || new AuthManager({
    store,
    username: config.auth.username,
    passwordHash: config.auth.passwordHash,
    requireTotp: config.auth.requireTotp,
    totpSecret: config.auth.totpSecret,
    accountKey: config.auth.accountKey,
    sessionTtlMs: config.auth.sessionTtlMs,
    idleTimeoutMs: config.auth.idleTimeoutMs,
    maxLoginAttempts: config.auth.maxLoginAttempts,
    loginWindowMs: config.auth.loginWindowMs,
  });
  const accounts = new AccountManager({ store, auth: authManager, accountKey: authManager.accountKey });

  function currentSession(req) {
    return authManager.authenticate(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  }

  function requireAuth(req, res, next) {
    const session = currentSession(req);
    if (!session) return res.status(401).json({ error: 'Authentication required' });
    req.authSession = session;
    next();
  }

  function requireCsrf(req, res, next) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.headers['x-sentinel'] !== '1') return res.status(403).json({ error: 'Missing X-Sentinel header' });
      if (!authManager.verifyCsrf(req.authSession, req.headers['x-csrf-token'])) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
      }
    }
    next();
  }

  api.use((req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method) && ['/healthz', '/auth/session'].includes(req.path)) return next();
    if (req.method === 'POST' && ['/auth/login', '/auth/enroll/start', '/auth/enroll/finish'].includes(req.path)) {
      if (req.headers['x-sentinel'] !== '1') return res.status(403).json({ error: 'Missing X-Sentinel header' });
      return next();
    }
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      requireCsrf(req, res, () => {
        const role = req.authSession.role;
        if (!['admin', 'operator', 'auditor'].includes(role)) return res.status(403).json({ error: 'Unknown account role' });
        if ((req.path === '/accounts' || req.path.startsWith('/accounts/')) && role !== 'admin') {
          return res.status(403).json({ error: 'Administrator access required' });
        }
        if (!['GET', 'HEAD'].includes(req.method) && role === 'auditor' && !['/auth/logout', '/auth/password'].includes(req.path)) {
          return res.status(403).json({ error: 'Read-only auditor accounts cannot perform this operation' });
        }
        next();
      });
    });
  });

  api.get('/auth/session', (req, res) => {
    const session = currentSession(req);
    if (!session) return res.json({ authenticated: false, authRequired: true, totpRequired: authManager.requireTotp });
    const csrf = parseCookies(req.headers.cookie).sentinel_csrf;
    if (!authManager.verifyCsrf(session, csrf)) setCsrfCookie(res, authManager.rotateCsrf(session));
    res.json({ authenticated: true, authRequired: true, totpRequired: authManager.requireTotp, username: session.username, role: session.role, bootstrap: session.bootstrap, expiresAt: session.expires_at });
  });

  api.post('/auth/login', asyncRoute(async (req, res) => {
    const { username, password, otp } = req.body || {};
    const result = await authManager.login(username, password, otp, {
      ip: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    });
    if (!result.ok) {
      if (result.rateLimited) res.setHeader('Retry-After', String(Math.ceil(config.auth.loginWindowMs / 1000)));
      return res.status(result.rateLimited ? 429 : 401).json({ error: result.rateLimited ? 'Too many login attempts' : 'Invalid credentials' });
    }
    setSessionCookie(res, result.token);
    setCsrfCookie(res, result.csrfToken);
    res.json({ authenticated: true, authRequired: true, totpRequired: authManager.requireTotp, username: result.username, role: result.role, bootstrap: result.bootstrap, expiresAt: result.expiresAt });
  }));

  api.post('/auth/logout', (req, res) => {
    const session = currentSession(req);
    if (session) authManager.logout(session);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  api.post('/auth/enroll/start', (req, res) => {
    const result = accounts.startEnrollment(req.body?.token, { ip: req.socket.remoteAddress });
    res.status(result.ok ? 200 : result.status).json(result);
  });

  api.post('/auth/enroll/finish', asyncRoute(async (req, res) => {
    const result = await accounts.finishEnrollment(req.body || {}, { ip: req.socket.remoteAddress });
    res.status(result.ok ? 200 : result.status).json(result);
  }));

  const stepUp = asyncRoute(async (req, res, next) => {
    const result = await authManager.verifyStepUp(req.authSession, req.body?.currentPassword, req.body?.otp, { ip: req.socket.remoteAddress });
    if (!result.ok) return res.status(result.rateLimited ? 429 : 401).json({ error: authManager.requireTotp ? 'Fresh password and an unused dynamic code are required' : 'Current password is required' });
    next();
  });

  api.get('/accounts', (req, res) => {
    const result = accounts.list(req.authSession);
    res.status(result.ok ? 200 : result.status).json(result);
  });

  api.post('/accounts', stepUp, (req, res) => {
    const result = accounts.create(req.body || {}, req.authSession);
    res.status(result.ok ? 201 : result.status).json(result);
  });

  api.patch('/accounts/:id', stepUp, (req, res) => {
    const result = accounts.update(req.params.id, req.body || {}, req.authSession);
    res.status(result.ok ? 200 : result.status).json(result);
  });

  api.post('/accounts/:id/reinvite', stepUp, (req, res) => {
    const result = accounts.reinvite(req.params.id, req.body?.version, req.authSession);
    res.status(result.ok ? 200 : result.status).json(result);
  });

  api.post('/auth/password', stepUp, asyncRoute(async (req, res) => {
    const result = await accounts.changePassword(req.authSession, req.body?.newPassword);
    if (result.ok) clearSessionCookie(res);
    res.status(result.ok ? 200 : result.status).json(result);
  }));

  /**
   * Liveness only: it deliberately does NOT call sub2api, so a health check can
   * never spend quota or move money, and a sub2api outage does not mark the
   * container unhealthy (that would cause pointless restarts).
   */
  api.get('/healthz', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), lastTick: monitor.lastTick });
  });

  api.get('/config', (req, res) => {
    res.json({
      ...publicConfig(),
      instanceBinding: store.instanceBindingStatus(client),
      killSwitch: monitor.isKillSwitchOn(),
      lastTick: monitor.lastTick,
      consecutiveFailures: monitor.consecutiveFailures,
    });
  });

  // ---- monitored users ----
  api.get('/users', (req, res) => {
    const users = store.listUsers();
    const enriched = [];
    for (const u of users) {
      const today = store.countTopupsSince(startOfTodayIso(), u.user_id);
      const observation = monitor.getUserObservation?.(u.user_id);
      enriched.push({
        ...u,
        enabled: Boolean(u.enabled),
        lastTopUp: store.lastTopupForUser(u.user_id) || null,
        todayCount: today.n,
        todayTotal: today.total,
        liveBalance: observation?.balance ?? null,
        balanceObservedAt: observation?.observedAt ?? null,
        balanceStale: observation?.stale ?? true,
      });
    }
    // Dashboard refreshes read cached observations, never trigger extra upstream
    // polls. The configured monitor interval controls background balance reads.
    res.json({ items: enriched });
  });

  api.post('/users', asyncRoute(async (req, res) => {
    const { userId, threshold, amount, enabled = true, mode = 'auto', note = null } = req.body || {};
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'userId must be a positive integer' });
    if (!['auto', 'approval'].includes(mode)) return res.status(400).json({ error: "mode must be 'auto' or 'approval'" });
    const th = Number(threshold);
    const amt = Number(amount);
    if (!isPositiveFinite(th)) return res.status(400).json({ error: 'threshold must be a finite number > 0' });
    if (!isPositiveFinite(amt)) return res.status(400).json({ error: 'amount must be a finite number > 0' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (!validNote(note)) return res.status(400).json({ error: 'note must be a string of at most 1000 characters or null' });
    if (amt > config.guard.maxTopUpAmountPerEvent) {
      return res.status(400).json({ error: `amount exceeds global per-event cap ${config.guard.maxTopUpAmountPerEvent}` });
    }

    store.assertInstanceBinding(client);
    if (store.getUser(id)) return res.status(409).json({ error: 'User already monitored; edit the existing rule with its current revision' });

    // Verify the user actually exists in sub2api before supervising them.
    let resolvedEmail = null;
    try {
      const u = await client.getUser(id);
      resolvedEmail = u.email ?? resolvedEmail;
    } catch (err) {
      const status = err instanceof Sub2ApiError && err.httpStatus === 404 ? 404 : 502;
      return res.status(status).json({ error: `Cannot verify user ${id} in sub2api: ${err.message}` });
    }

    const result = store.createUser({ userId: id, email: resolvedEmail, threshold: th, amount: amt, enabled, mode, note }, {
      instance: client, authorizeActor: () => authManager.isCurrentPrincipal(req.authSession, ['admin', 'operator']),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.reason });
    const row = result.user;
    store.log('info', 'user_added',
      `monitoring user ${id} (${resolvedEmail}): threshold=${th} amount=${amt} mode=${normalizeMode(mode)}`, id, req.authSession.username);
    res.json(row);
  }));

  api.patch('/users/:userId', asyncRoute(async (req, res) => {
    const id = Number(req.params.userId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'userId must be a positive integer' });
    const existing = store.getUser(id);
    if (!existing) return res.status(404).json({ error: 'User not monitored' });
    const { threshold, amount, enabled, note, mode, ruleRevision } = req.body || {};
    if (typeof ruleRevision !== 'string' || !ruleRevision) return res.status(400).json({ error: 'ruleRevision is required' });
    const th = threshold === undefined ? existing.threshold : Number(threshold);
    const amt = amount === undefined ? existing.amount : Number(amount);
    if (!isPositiveFinite(th)) return res.status(400).json({ error: 'threshold must be a finite number > 0' });
    if (!isPositiveFinite(amt)) return res.status(400).json({ error: 'amount must be a finite number > 0' });
    if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
    if (note !== undefined && !validNote(note)) return res.status(400).json({ error: 'note must be a string of at most 1000 characters or null' });
    if (amt > config.guard.maxTopUpAmountPerEvent) {
      return res.status(400).json({ error: `amount exceeds global per-event cap ${config.guard.maxTopUpAmountPerEvent}` });
    }
    if (mode !== undefined && !['auto', 'approval'].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'auto' or 'approval'" });
    }
    const result = store.updateUser({
      userId: id,
      threshold: th,
      amount: amt,
      enabled: enabled === undefined ? Boolean(existing.enabled) : enabled,
      mode: mode === undefined ? existing.mode : mode,
      note: note === undefined ? existing.note : note,
    }, ruleRevision, { instance: client, authorizeActor: () => authManager.isCurrentPrincipal(req.authSession, ['admin', 'operator']) });
    if (!result.ok) return res.status(result.status).json({ error: result.reason });
    const row = result.user;
    if (mode !== undefined && mode !== existing.mode) {
      store.log('info', 'user_mode_changed', `user ${id} mode: ${existing.mode} -> ${mode}`, id, req.authSession.username);
    }
    store.log('info', 'user_rule_changed', `user ${id}: threshold ${existing.threshold} -> ${row.threshold}; amount ${existing.amount} -> ${row.amount}; enabled ${existing.enabled} -> ${row.enabled}; mode ${existing.mode} -> ${row.mode}`, id, req.authSession.username);
    res.json(row);
  }));

  api.delete('/users/:userId', (req, res) => {
    const id = Number(req.params.userId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'userId must be a positive integer' });
    const { ruleRevision } = req.body || {};
    if (typeof ruleRevision !== 'string' || !ruleRevision) return res.status(400).json({ error: 'ruleRevision is required' });
    const result = store.removeUser(id, ruleRevision, { instance: client,
      authorizeActor: () => authManager.isCurrentPrincipal(req.authSession, ['admin', 'operator']) });
    if (!result.ok) return res.status(result.status).json({ error: result.reason });
    monitor.forgetUserObservation?.(id);
    store.log('info', 'user_removed', `stopped monitoring user ${id}`, id, req.authSession.username);
    res.json({ ok: true });
  });

  // Manual top-up: same safety rails as the automatic path.
  api.post('/users/:userId/topup', asyncRoute(async (req, res) => {
    const id = Number(req.params.userId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'userId must be a positive integer' });
    const user = store.getUser(id);
    if (!user) return res.status(404).json({ error: 'User is not monitored' });
    const amount = Number(req.body?.amount ?? user.amount);
    if (!isPositiveFinite(amount)) return res.status(400).json({ error: 'amount must be a finite number > 0' });

    store.assertInstanceBinding(client);
    const fresh = await client.getUser(id);
    const liveBalance = Number(fresh.balance);
    if (!Number.isFinite(liveBalance)) return res.status(502).json({ error: 'Sub2Api returned a non-finite user balance' });
    const outcome = await monitor.performTopUp({
      userId: id,
      email: fresh.email,
      balanceBefore: liveBalance,
      threshold: user?.threshold ?? 0,
      amount,
      source: 'manual',
      ruleRevision: user.rule_revision,
      actor: req.authSession?.username || 'operator',
      authorizeActor: () => authManager.isCurrentPrincipal(req.authSession, ['admin', 'operator']),
    });
    if (!outcome.ok) return res.status(409).json(outcome);
    res.json(outcome);
  }));

  // ---- proposals (approval mode) ----
  api.get('/proposals', (req, res) => {
    const status = req.query.status || 'pending';
    if (!['pending', 'approved', 'rejected', 'expired', 'all'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, approved, rejected, expired, or all' });
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 100;
    res.json({ items: store.listProposals({ status: status === 'all' ? null : status, limit }) });
  });

  api.post('/proposals/:id/approve', asyncRoute(async (req, res) => {
    const outcome = await monitor.approveProposal(req.params.id, req.authSession?.username || 'operator', () => authManager.isCurrentPrincipal(req.authSession, ['admin', 'operator']));
    if (!outcome.ok) return res.status(409).json(outcome);
    res.json(outcome);
  }));

  api.post('/proposals/:id/reject', (req, res) => {
    const note = req.body?.note ?? null;
    if (!validNote(note)) return res.status(400).json({ error: 'note must be a string of at most 1000 characters or null' });
    const outcome = monitor.rejectProposal(req.params.id, note, req.authSession.username);
    if (!outcome.ok) return res.status(409).json(outcome);
    res.json(outcome);
  });

  // ---- notifications ----
  api.post('/notify/test', asyncRoute(async (req, res) => {
    if (!notifier?.enabled) return res.status(400).json({ ok: false, error: 'NOTIFY_WEBHOOK_URL is not configured' });
    const ok = await notifier.send('【余额哨兵】这是一条测试消息，收到即表示通知配置正确。');
    res.status(ok ? 200 : 502).json({ ok });
  }));

  // ---- ledger ----
  api.get('/records', (req, res) => {
    const userId = req.query.userId ? Number(req.query.userId) : null;
    if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) {
      return res.status(400).json({ error: 'userId must be a positive integer' });
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(1000, Math.max(1, Math.floor(limitRaw))) : 200;
    const offsetRaw = Number(req.query.offset);
    const offset = Number.isFinite(offsetRaw) ? Math.min(10_000_000, Math.max(0, Math.floor(offsetRaw))) : 0;
    const status = req.query.status ? String(req.query.status) : null;
    if (status !== null && !['pending', 'success', 'failed', 'unknown', 'unresolved'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, success, failed, unknown, or unresolved' });
    }
    res.json({
      items: store.recentTopups({ userId, status, limit, offset }),
      total: store.countTopupRecords({ userId, status }),
      limit,
      offset,
    });
  });

  api.get('/records.csv', (req, res) => {
    const userId = req.query.userId ? Number(req.query.userId) : null;
    if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) {
      return res.status(400).json({ error: 'userId must be a positive integer' });
    }
    const status = req.query.status ? String(req.query.status) : null;
    if (status !== null && !['pending', 'success', 'failed', 'unknown', 'unresolved'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, success, failed, unknown, or unresolved' });
    }
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sub2api-ledger.csv"');
    res.write('\ufeff');
    res.write('topup_id,user_id,email,balance_before,balance_after,amount,threshold,status,source,actor,http_status,provider_reference,idempotent_replay,error,reconciled,reconciled_at,reconciled_by,reconcile_note,created_at,updated_at,proposal_id,provider_origin,verification_status,verified_at\n');
    for (const row of store.exportTopups({ userId, status })) {
      res.write([
        csvCell(row.id), row.user_id, csvCell(row.email), row.balance_before, row.balance_after,
        row.amount, row.threshold_at_time, csvCell(row.status), csvCell(row.source), csvCell(row.actor),
        row.sub2api_status ?? '', csvCell(row.provider_reference), row.idempotent_replay,
        csvCell(row.error), row.reconciled, csvCell(row.reconciled_at), csvCell(row.reconciled_by),
        csvCell(row.reconcile_note), csvCell(row.created_at), csvCell(row.updated_at),
        csvCell(row.proposal_id), csvCell(row.provider_origin), csvCell(row.verification_status), csvCell(row.verified_at),
      ].join(',') + '\n');
    }
    res.end();
  });

  api.get('/records/:id/checks', (req, res) => {
    if (!store.getTopup(req.params.id)) return res.status(404).json({ error: 'Record not found' });
    res.json({ items: store.ledgerChecks(req.params.id) });
  });

  api.get('/records/:id/checks.csv', (req, res) => {
    if (!store.getTopup(req.params.id)) return res.status(404).json({ error: 'Record not found' });
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="reconciliation-evidence.csv"');
    res.write('\ufeffid,topup_id,kind,outcome,previous_status,actor,summary,provider_reference,evidence_sha256,created_at,evidence_json\n');
    for (const row of store.exportLedgerChecks(req.params.id)) {
      res.write([
        row.id, row.topup_id, row.kind, row.outcome, row.previous_status, row.actor,
        row.summary, row.provider_reference, row.evidence_sha256, row.created_at, row.evidence_json,
      ].map(csvCell).join(',') + '\n');
    }
    res.end();
  });

  api.post('/records/:id/verify', asyncRoute(async (req, res) => {
    if (!store.getTopup(req.params.id)) return res.status(404).json({ error: 'Record not found' });
    const result = await ledgerReconciler.verify(req.params.id, req.authSession.username);
    res.status(result.ok ? 200 : 409).json(result);
  }));

  api.post('/records/:id/resolve', asyncRoute(async (req, res) => {
    if (req.body?.decision !== 'applied' || req.body?.confirmation !== req.params.id) {
      return res.status(400).json({ error: 'Only an explicit confirmation of an applied credit is supported; missing history cannot authorize a retry' });
    }
    if (!store.getTopup(req.params.id)) return res.status(404).json({ error: 'Record not found' });
    const result = await ledgerReconciler.resolveApplied(req.params.id, req.authSession.username, () => authManager.isCurrentPrincipal(req.authSession, ['admin', 'operator']));
    res.status(result.ok ? 200 : 409).json(result);
  }));

  api.post('/records/:id/reconcile', (req, res) => {
    const note = req.body?.note ?? null;
    if (!validNote(note)) return res.status(400).json({ error: 'note must be a string of at most 1000 characters or null' });
    const changes = store.markReconciled(req.params.id, note, req.authSession?.username || 'operator');
    if (!changes) return res.status(404).json({ error: 'Record not found' });
    res.json({ ok: true });
  });

  // Reconciliation summary: what to bill the customer for.
  api.get('/reconciliation', (req, res) => {
    const rows = store.unreconciled();
    const byUser = new Map();
    for (const r of rows) {
      const key = r.user_id;
      if (!byUser.has(key)) {
        byUser.set(key, { userId: r.user_id, email: r.email, total: 0, count: 0, firstAt: r.created_at, lastAt: r.created_at, recordIds: [] });
      }
      const entry = byUser.get(key);
      entry.total = Math.round((entry.total + r.amount) * 1e8) / 1e8;
      entry.count += 1;
      entry.lastAt = r.created_at;
      entry.recordIds.push(r.id);
    }
    res.json({
      items: [...byUser.values()],
      grandTotal: Math.round([...byUser.values()].reduce((a, b) => a + b.total, 0) * 1e8) / 1e8,
      records: rows,
    });
  });

  // CSV export for billing / bookkeeping.
  api.get('/reconciliation.csv', (req, res) => {
    const userId = req.query.userId ? Number(req.query.userId) : null;
    if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) {
      return res.status(400).json({ error: 'userId must be a positive integer' });
    }
    const rows = [...store.exportTopups({ userId, status: 'success' })].filter((row) => !row.reconciled);
    const header = 'topup_id,user_id,email,balance_before,balance_after,amount,status,source,actor,provider_reference,created_at\n';
    const body = rows
      .map((r) => [r.id, r.user_id, csvCell(r.email), r.balance_before, r.balance_after, r.amount, r.status, r.source, csvCell(r.actor), csvCell(r.provider_reference), r.created_at].join(','))
      .join('\n');
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="reconciliation.csv"');
    res.send('\ufeff' + header + body);
  });

  api.get('/events', (req, res) => {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) ? Math.min(500, Math.max(1, Math.floor(requested))) : 100;
    res.json({ items: store.recentEvents(limit) });
  });

  // ---- controls ----
  api.post('/kill-switch', (req, res) => {
    if (typeof req.body?.on !== 'boolean') return res.status(400).json({ error: 'on must be a boolean' });
    const on = req.body.on;
    monitor.setKillSwitch(on, req.authSession.username);
    res.json({ killSwitch: monitor.isKillSwitchOn() });
  });

  api.post('/circuit-breaker/reset', (req, res) => {
    monitor.resetCircuitBreaker(req.authSession.username);
    res.json({ consecutiveFailures: monitor.consecutiveFailures });
  });

  api.post('/tick', asyncRoute(async (req, res) => {
    store.assertInstanceBinding(client);
    await monitor.tick();
    res.json({ lastTick: monitor.lastTick });
  }));

  // Connection test that never mutates anything.
  api.get('/test-connection', asyncRoute(async (req, res) => {
    store.assertInstanceBinding(client);
    try {
      const users = store.listUsers();
      const probe = users[0]?.user_id;
      if (!probe) return res.json({ ok: true, note: 'No monitored users to probe' });
      const u = await client.getUser(probe);
      store.assertInstanceBinding(client);
      res.json({ ok: true, userId: probe, balance: u.balance });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  }));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Serve the built SPA if present.
  const dist = path.join(ROOT, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    // SPA fallback. /api/* is excluded on purpose: an unknown API path must
    // return a JSON 404, never an HTML page (that breaks clients and hides typos).
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  // Central error handler: never leak the admin key in responses.
  app.use((err, req, res, next) => {
    const status = err instanceof InstanceBindingError ? 409 : err instanceof Sub2ApiError ? 502 : 500;
    console.error('[api]', redact(err.message));
    res.status(status).json({ error: redact(err.message) });
  });

  return app;
}

function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${cookieValue(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(config.auth.sessionTtlMs / 1000)}`,
  ];
  if (config.auth.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const sessionParts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  const csrfParts = ['sentinel_csrf=', 'Path=/', 'SameSite=Strict', 'Max-Age=0'];
  if (config.auth.secureCookies) {
    sessionParts.push('Secure');
    csrfParts.push('Secure');
  }
  res.setHeader('Set-Cookie', [sessionParts.join('; '), csrfParts.join('; ')]);
}

function setCsrfCookie(res, token) {
  const parts = [`sentinel_csrf=${cookieValue(token)}`, 'Path=/', 'SameSite=Strict', `Max-Age=${Math.floor(config.auth.sessionTtlMs / 1000)}`];
  if (config.auth.secureCookies) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  // Spreadsheet apps may evaluate imported strings as formulas.
  if (/^[\t\r\n ]*[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function normalizeMode(mode) {
  return mode === 'approval' ? 'approval' : 'auto';
}

function redact(text) {
  if (!text) return text;
  return config.adminKey ? String(text).split(config.adminKey).join('admin-***REDACTED***') : String(text);
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function validNote(note) {
  return note === null || (typeof note === 'string' && note.length <= 1000);
}
