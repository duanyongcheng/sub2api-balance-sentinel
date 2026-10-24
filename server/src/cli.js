#!/usr/bin/env node
/**
 * Non-interactive CLI, for cron / systemd timers / a one-off check.
 * Shares the exact same code path as the web server, so guard rails apply identically.
 *
 *   node server/src/cli.js tick                 # run one monitoring pass
 *   node server/src/cli.js tick --dry-run       # decide only, never write
 *   node server/src/cli.js users                # list monitored users
 *   node server/src/cli.js add <id> <threshold> <amount> [--mode approval]
 *   node server/src/cli.js records [--limit 20]
 *   node server/src/cli.js owed                 # what customers owe you
 *   node server/src/cli.js proposals            # pending approvals
 *   node server/src/cli.js approve <proposalId>
 *   node server/src/cli.js reject <proposalId> [note]
 *
 * Exit codes: 0 ok/skip, 2 something needs a human (unknown outcome, guard trip),
 *             3 top-up failed, 1 usage/config error.
 */
import { config, assertConfigured } from './config.js';
import { openDb, createStore } from './db/store.js';
import { Monitor } from './lib/monitor.js';
import { Sub2ApiClient } from './lib/sub2api.js';
import { Notifier } from './lib/notify.js';
import { Reconciler } from './lib/reconciliation.js';
import { decideTopUp, startOfTodayIso, money } from './lib/logic.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));

function flagValue(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function table(rows, columns) {
  if (!rows.length) return '(empty)';
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [line(columns.map((c) => c.label)), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map((c) => c.get(r) ?? '')))].join('\n');
}

function usage() {
  console.log(`sub2api-balance-sentinel CLI

  tick                         run one monitoring pass
  tick --dry-run               decide only, print what *would* happen
  users                        list monitored users
  add <id> <threshold> <amount> [--mode=approval]
  remove <id> --revision=<rule_revision>
  bind-instance --confirm=<full-canonical-base-url>
                               confirm a legacy unbound ledger in observe-only mode
  records [--limit=N]
  owed                         unreconciled totals per user
  proposals                    pending approval requests
  approve <proposalId>
  reject <proposalId> [note]
  verify <topupId>              compare one attempt with upstream history
  checks <topupId>              show saved reconciliation evidence
  resolve-applied <topupId> --confirm=<topupId>
                               confirm applied using fresh matching evidence
`);
}

try {
  // CLI commands run from a trusted shell and do not expose the dashboard.
  // They still require the sub2api credential, but not the web login settings.
  assertConfigured({ requireAuth: false });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const db = openDb(config.dbPath);
const client = new Sub2ApiClient();
const store = createStore(db, { instance: client });
const notifier = new Notifier({ store });
const monitor = new Monitor({ store, client, notifier });
const reconciler = new Reconciler({ store, client });

main().catch((err) => {
  console.error('error:', err.message);
  process.exit(1);
});

async function main() {
  switch (cmd) {
    case 'bind-instance': {
      store.confirmInstanceBinding(client, { writesEnabled: config.monitor.autoTopUpEnabled, confirmation: flagValue('confirm') });
      console.log('ledger instance confirmed; no upstream request sent');
      break;
    }
    case 'tick': {
      store.assertInstanceBinding(client);
      const dryRun = flags.has('--dry-run');
      const users = store.enabledUsers();
      let exitCode = 0;
      let acted = 0;

      for (const user of users) {
        let fresh;
        try {
          store.assertInstanceBinding(client);
          fresh = await client.getUser(user.user_id);
          store.assertInstanceBinding(client);
        } catch (err) {
          console.log(`  ! user ${user.user_id}: cannot read balance (${err.message})`);
          exitCode = Math.max(exitCode, 2);
          continue;
        }
        const balance = Number(fresh.balance ?? 0);
        const decision = decideTopUp({
          balance,
          threshold: user.threshold,
          amount: user.amount,
          enabled: Boolean(user.enabled),
          lastTopUp: store.lastTopupForUser(user.user_id),
        });
        if (decision.action === 'skip') {
          console.log(`  - user ${user.user_id} (${fresh.email}): balance ${balance} — ${decision.reason}`);
          continue;
        }
        if (dryRun) {
          console.log(`  > user ${user.user_id} (${fresh.email}): balance ${balance} < ${user.threshold} — WOULD add ${user.amount}${user.mode === 'approval' ? ' (approval mode: would propose)' : ''}`);
          continue;
        }
        if (user.mode === 'approval') {
          const proposal = monitor.proposeTopUp({ userId: user.user_id, email: fresh.email, balance, threshold: user.threshold, amount: user.amount, ruleRevision: user.rule_revision });
          if (proposal) {
            console.log(`  > user ${user.user_id} (${fresh.email}): balance ${balance} — proposal pending approval`);
            acted += 1;
          } else {
            console.log(`  ! user ${user.user_id}: monitoring rule changed; run a fresh check`);
            exitCode = Math.max(exitCode, 2);
          }
          continue;
        }
        const outcome = await monitor.performTopUp({
          userId: user.user_id,
          email: fresh.email,
          balanceBefore: balance,
          threshold: user.threshold,
          amount: decision.amount,
          source: 'auto',
          ruleRevision: user.rule_revision,
        });
        if (outcome.ok) {
          console.log(`  + user ${user.user_id} (${fresh.email}): ${balance} -> ${outcome.record.balance_after} (+${money(user.amount)})`);
          acted += 1;
        } else {
          console.log(`  ! user ${user.user_id}: ${outcome.reason}${outcome.unknown ? ' [UNKNOWN outcome — check manually]' : ''}`);
          exitCode = Math.max(exitCode, outcome.unknown ? 2 : 3);
        }
      }
      if (!acted && exitCode === 0 && !dryRun) console.log(`checked ${users.length} user(s), nothing to do`);
      if (dryRun && !acted) console.log(`checked ${users.length} user(s), nothing would change`);
      db.close();
      process.exit(exitCode);
    }

    case 'users': {
      const rows = store.listUsers().map((u) => ({ ...u, today: store.countTopupsSince(startOfTodayIso(), u.user_id).n }));
      console.log(table(rows, [
        { label: 'ID', get: (r) => r.user_id },
        { label: 'EMAIL', get: (r) => r.email },
        { label: 'THRESHOLD', get: (r) => r.threshold },
        { label: 'AMOUNT', get: (r) => r.amount },
        { label: 'MODE', get: (r) => r.mode },
        { label: 'ON', get: (r) => (r.enabled ? 'yes' : 'no') },
        { label: 'REVISION', get: (r) => r.rule_revision },
        { label: 'TODAY', get: (r) => r.today },
      ]));
      break;
    }

    case 'add': {
      const [idRaw, thRaw, amtRaw] = positional;
      const id = Number(idRaw);
      const threshold = Number(thRaw);
      const amount = Number(amtRaw);
      const mode = flagValue('mode', 'auto');
      if (!Number.isInteger(id) || id <= 0) throw new Error('user id must be a positive integer');
      if (!Number.isFinite(threshold) || !(threshold > 0)) throw new Error('threshold must be finite and > 0');
      if (!Number.isFinite(amount) || !(amount > 0)) throw new Error('amount must be finite and > 0');
      if (amount > config.guard.maxTopUpAmountPerEvent) throw new Error(`amount exceeds guard cap ${config.guard.maxTopUpAmountPerEvent}`);
      if (!['auto', 'approval'].includes(mode)) throw new Error("--mode must be 'auto' or 'approval'");
      store.assertInstanceBinding(client);
      if (store.getUser(id)) throw new Error('user already monitored; edit its rule in the dashboard instead of adding it again');
      const fresh = await client.getUser(id);
      const result = store.createUser({ userId: id, email: fresh.email, threshold, amount, mode, enabled: true }, { instance: client });
      if (!result.ok) throw new Error(result.reason);
      const row = result.user;
      store.log('info', 'user_added', `CLI: monitoring user ${id} (${fresh.email}) threshold=${threshold} amount=${amount} mode=${mode}`, id, 'cli');
      console.log(`monitoring #${id} ${fresh.email}: below ${threshold} -> add ${amount} (mode: ${row.mode})`);
      break;
    }

    case 'remove': {
      const id = Number(positional[0]);
      if (!Number.isInteger(id) || id <= 0) throw new Error('user id must be a positive integer');
      if (!flagValue('revision')) throw new Error('--revision=<rule_revision> is required; use the dashboard to obtain it');
      const result = store.removeUser(id, flagValue('revision'), { instance: client });
      if (!result.ok) throw new Error(result.reason);
      store.log('info', 'user_removed', `CLI: stopped monitoring user ${id}`, id, 'cli');
      console.log(`stopped monitoring #${id}`);
      break;
    }

    case 'records': {
      const limit = Number(flagValue('limit', 20));
      const rows = store.recentTopups({ userId: null, limit });
      console.log(table(rows, [
        { label: 'TIME', get: (r) => r.created_at.slice(0, 19).replace('T', ' ') },
        { label: 'USER', get: (r) => r.user_id },
        { label: 'BEFORE', get: (r) => r.balance_before },
        { label: 'AMOUNT', get: (r) => r.amount },
        { label: 'AFTER', get: (r) => r.balance_after },
        { label: 'STATUS', get: (r) => r.status },
        { label: 'SRC', get: (r) => r.source },
        { label: 'PAID', get: (r) => (r.reconciled ? 'yes' : 'no') },
      ]));
      break;
    }

    case 'owed': {
      const rows = store.unreconciled();
      const byUser = new Map();
      for (const r of rows) {
        const cur = byUser.get(r.user_id) || { user_id: r.user_id, email: r.email, count: 0, total: 0 };
        cur.count += 1;
        cur.total += r.amount;
        byUser.set(r.user_id, cur);
      }
      const list = [...byUser.values()];
      console.log(table(list, [
        { label: 'USER', get: (r) => r.user_id },
        { label: 'EMAIL', get: (r) => r.email },
        { label: 'COUNT', get: (r) => r.count },
        { label: 'OWED', get: (r) => money(r.total) },
      ]));
      console.log(`\ntotal owed: ${money(list.reduce((a, b) => a + b.total, 0))}`);
      break;
    }

    case 'proposals': {
      const rows = store.listProposals({ status: 'pending' });
      console.log(table(rows, [
        { label: 'ID', get: (r) => r.id },
        { label: 'USER', get: (r) => r.user_id },
        { label: 'EMAIL', get: (r) => r.email },
        { label: 'BAL', get: (r) => r.balance_at_proposal },
        { label: 'AMOUNT', get: (r) => r.amount },
        { label: 'AT', get: (r) => r.created_at.slice(0, 19).replace('T', ' ') },
      ]));
      break;
    }

    case 'approve': {
      const out = await monitor.approveProposal(positional[0], 'cli');
      if (!out.ok) {
        console.error(`not approved: ${out.reason}`);
        db.close();
        process.exit(2);
      }
      console.log(`approved: ${out.record.balance_before} -> ${out.record.balance_after} (+${out.record.amount})`);
      break;
    }

    case 'reject': {
      const out = monitor.rejectProposal(positional[0], positional.slice(1).join(' '), 'cli');
      if (!out.ok) { console.error(out.reason); db.close(); process.exit(2); }
      console.log('rejected');
      break;
    }

    case 'verify': {
      const out = await reconciler.verify(positional[0], 'cli');
      if (!out.ok) throw new Error(out.reason);
      console.log(`${out.check.outcome}: ${out.check.summary}\nevidence: ${out.check.id}`);
      if (out.check.outcome !== 'matched') { db.close(); process.exit(2); }
      break;
    }

    case 'checks': {
      if (!store.getTopup(positional[0])) throw new Error('record not found');
      console.log(JSON.stringify(store.ledgerChecks(positional[0]), null, 2));
      break;
    }

    case 'resolve-applied': {
      if (!positional[0] || flagValue('confirm') !== positional[0]) throw new Error('Pass --confirm=<topupId> explicitly; this changes the ledger but never sends money');
      const out = await reconciler.resolveApplied(positional[0], 'cli');
      if (!out.ok) { console.error(out.reason); db.close(); process.exit(2); }
      console.log(`confirmed applied: ${out.record.id}; evidence: ${out.resolution.id}; no money request sent`);
      break;
    }

    default:
      usage();
      db.close();
      process.exit(cmd ? 1 : 0);
  }
  db.close();
}
