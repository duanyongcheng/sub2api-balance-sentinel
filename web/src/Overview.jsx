import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { BalanceGauge, Badge, Chevron, UserCell, VerificationBadge, boardTime, clockTime, money, when } from './ui.jsx';

/** One state word for the whole patrol, in the order that decides what writes can happen. */
export function runState(cfg) {
  if (!cfg) return { tone: 'muted', label: '连接中' };
  if (cfg.killSwitch) return { tone: 'danger', label: '急停中' };
  if (!cfg.monitor.autoTopUpEnabled) return { tone: 'caution', label: '观察模式' };
  if (!cfg.monitor.enabled) return { tone: 'caution', label: '巡检已关闭' };
  return { tone: 'ok', label: '运行中' };
}

export function circuitTripped(cfg) {
  return Boolean(cfg && cfg.consecutiveFailures >= cfg.guard.circuitBreakerFailures);
}

const byTimeAsc = (a, b) => String(a.at).localeCompare(String(b.at));

function boardItems({ cfg, unresolved, proposals }) {
  const items = [];
  if (circuitTripped(cfg)) items.push({ kind: 'circuit', key: 'circuit', at: '' });
  items.push(
    ...unresolved.items.map((record) => ({ kind: 'record', key: `r:${record.id}`, at: record.created_at, record })).sort(byTimeAsc),
  );
  items.push(
    ...proposals.map((proposal) => ({ kind: 'proposal', key: `p:${proposal.id}`, at: proposal.created_at, proposal })).sort(byTimeAsc),
  );
  return items;
}

/** Rows that arrive after the first load light up once; resolved rows simply leave. */
function useFreshKeys(keys, ready) {
  const seen = useRef(null);
  const until = useRef(new Map());
  const now = Date.now();
  if (ready && seen.current) {
    for (const key of keys) {
      if (!seen.current.has(key) && !until.current.has(key)) until.current.set(key, now + 1600);
    }
  }
  useEffect(() => {
    if (ready) seen.current = new Set([...(seen.current || []), ...keys]);
  });
  return (key) => (until.current.get(key) || 0) > now;
}

const sourceLabel = (r) =>
  `${r.source === 'auto' ? '自动' : r.source === 'approval' ? '审批' : '手动'}${r.idempotent_replay ? '（重放）' : ''}`;

export function Overview({ cfg, users, unresolved, proposals, recon, recordTotal, busy, readOnly, action, goTo }) {
  const ready = cfg != null;
  const items = boardItems({ cfg, unresolved, proposals });
  const isFresh = useFreshKeys(
    items.map((item) => item.key),
    ready,
  );
  const [open, setOpen] = useState(null);
  const blocked = new Set(unresolved.items.map((record) => record.user_id));
  const count = (circuitTripped(cfg) ? 1 : 0) + unresolved.total + proposals.length;
  const hiddenUnresolved = Math.max(unresolved.total - unresolved.items.length, 0);
  const today = users.reduce((sum, user) => ({ n: sum.n + (user.todayCount || 0), total: sum.total + (user.todayTotal || 0) }), {
    n: 0,
    total: 0,
  });

  return (
    <div className="overview">
      <section className={count ? 'board' : 'board is-clear'} aria-label="待处理事项">
        <div className="board-tally">
          {!ready ? (
            <p className="tally-phrase">正在读取…</p>
          ) : count ? (
            <p className="tally-phrase">
              <span className="num tally-count">{count}</span>
              {readOnly ? '件事等待操作员处理' : '件事等你处理'}
            </p>
          ) : (
            <p className="tally-phrase tally-clear">
              无需处理<span>没有待审批、未决流水或熔断</span>
            </p>
          )}
          <RunStatus cfg={cfg} />
        </div>

        {count > 0 && (
          <div className="board-rows">
            <div className="board-head" aria-hidden="true">
              <span>时间</span>
              <span>用户</span>
              <span>事项</span>
              <span className="right">金额</span>
              <span>状态</span>
              <span />
            </div>
            <ul className="board-list">
              {items.map((item) => (
                <BoardRow
                  key={item.key}
                  item={item}
                  cfg={cfg}
                  fresh={isFresh(item.key)}
                  open={open === item.key}
                  onToggle={() => setOpen(open === item.key ? null : item.key)}
                  busy={busy}
                  readOnly={readOnly}
                  action={action}
                  goTo={goTo}
                />
              ))}
            </ul>
            <div className="board-foot">
              <span>
                监控用户今日加额 <b className="num">{today.n}</b> 笔 · <b className="num">{money(today.total)}</b>
              </span>
              {recordTotal != null && (
                <span>
                  账本共 <b className="num">{recordTotal}</b> 笔流水
                </span>
              )}
              {hiddenUnresolved > 0 && (
                <button type="button" className="link-on-dark" onClick={() => goTo('unresolved')}>
                  另有 {hiddenUnresolved} 笔未决，查看全部
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="overview-lower">
        <BalancePanel users={users} blocked={blocked} goTo={goTo} />
        <OwedPanel recon={recon} goTo={goTo} />
      </div>
    </div>
  );
}

function RunStatus({ cfg }) {
  if (!cfg) return null;
  const state = runState(cfg);
  const failures = cfg.consecutiveFailures;
  const limit = cfg.guard.circuitBreakerFailures;
  const failureTone = failures >= limit ? 'danger' : failures > 0 ? 'caution' : 'ok';
  return (
    <dl className="run-status">
      <div>
        <dt>自动加额</dt>
        <dd className={`tone-${state.tone}`}>{state.label}</dd>
      </div>
      <div>
        <dt>连续失败</dt>
        <dd className={`tone-${failureTone}`}>
          <span className="num">
            {failures} / {limit}
          </span>
          {failures >= limit ? ' 已熔断' : ''}
        </dd>
      </div>
      <div>
        <dt>最近巡检</dt>
        <dd>
          <span className="num">{clockTime(cfg.lastTick)}</span>
        </dd>
      </div>
    </dl>
  );
}

function DetailToggle({ open, onToggle }) {
  return (
    <button type="button" className="btn btn-ghost btn-icon" aria-expanded={open} aria-label="详情" title="详情" onClick={onToggle}>
      <Chevron open={open} />
    </button>
  );
}

function BoardTime({ iso }) {
  const t = boardTime(iso);
  return (
    <span className="board-time num" title={when(iso)}>
      {t.main}
      {t.sub && <small>{t.sub}</small>}
    </span>
  );
}

function BoardRow({ item, cfg, fresh, open, onToggle, busy, readOnly, action, goTo }) {
  const className = ['board-row', fresh && 'is-fresh', open && 'is-open'].filter(Boolean).join(' ');

  if (item.kind === 'circuit') {
    return (
      <li className={className}>
        <div className="board-line">
          <span className="board-time num">—</span>
          <span className="board-user">
            <span className="user-id">全局</span>
          </span>
          <span className="board-what">
            熔断已触发：连续失败 <span className="num">{cfg.consecutiveFailures}</span> 次，写入已停止
            <small>重置前请先在运行日志中查看失败原因</small>
          </span>
          <span className="board-amount" />
          <span className="board-state state-danger">熔断</span>
          <span className="board-actions">
            {!readOnly && (
              <button className="btn btn-danger" disabled={busy} onClick={() => action(() => api.resetCircuit(), '熔断已重置')}>
                确认后重置
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => goTo('events')}>
              运行日志
            </button>
          </span>
        </div>
      </li>
    );
  }

  if (item.kind === 'record') {
    const r = item.record;
    return (
      <li className={className}>
        <div className="board-line">
          <BoardTime iso={r.created_at} />
          <span className="board-user">
            <UserCell id={r.user_id} email={r.email} size="lg" />
          </span>
          <span className="board-what">
            {r.status === 'unknown' ? '加额结果未知' : '加额请求未完成'}
            <small>
              未核实前拦截该用户加额 · {r.status} · 上游核对 <VerificationBadge outcome={r.verification_status} />
            </small>
          </span>
          <span className="board-amount num">+{money(r.amount)}</span>
          <span className="board-state state-danger">待核实</span>
          <span className="board-actions">
            {!readOnly && (
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => action(() => api.verifyRecord(r.id), '核验结果已留存，请查看证据')}
              >
                核对上游
              </button>
            )}
            {!readOnly && r.verification_status === 'matched' && (
              <button
                className="btn"
                disabled={busy}
                title="必须重新查询并找到唯一匹配的调账凭据，才允许确认到账"
                onClick={() => {
                  if (confirm(`确认按上游凭据将 ${r.id} 记为已到账？不会再次加额。未决拦截解除后，该用户可能恢复自动加额。`)) {
                    action(() => api.resolveApplied(r.id), '已根据上游凭据确认到账，未发送加额请求');
                  }
                }}
              >
                确认已到账
              </button>
            )}
            <DetailToggle open={open} onToggle={onToggle} />
          </span>
        </div>
        {open && (
          <div className="board-detail">
            <dl>
              <div className="wide">
                <dt>流水 ID</dt>
                <dd className="mono">{r.id}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{when(r.created_at)}</dd>
              </div>
              <div>
                <dt>加额前</dt>
                <dd className="num">{money(r.balance_before)}</dd>
              </div>
              <div>
                <dt>来源</dt>
                <dd>{sourceLabel(r)}</dd>
              </div>
              <div>
                <dt>操作者</dt>
                <dd className="mono">{r.actor || '—'}</dd>
              </div>
              <div>
                <dt>最近核对</dt>
                <dd>{when(r.verified_at)}</dd>
              </div>
              {r.error && (
                <div className="wide">
                  <dt>错误</dt>
                  <dd>{r.error}</dd>
                </div>
              )}
            </dl>
            <p>
              上游核对按流水 ID、用户、金额逐笔匹配。未找到记录不代表未到账，不会触发补发。
              <button type="button" className="link-on-dark" onClick={() => goTo('unresolved')}>
                到「未决处理」查看核验证据
              </button>
            </p>
          </div>
        )}
      </li>
    );
  }

  const p = item.proposal;
  return (
    <li className={className}>
      <div className="board-line">
        <BoardTime iso={p.created_at} />
        <span className="board-user">
          <UserCell id={p.user_id} email={p.email} size="lg" />
        </span>
        <span className="board-what">
          余额 <span className="num">{money(p.balance_at_proposal)}</span>，低于阈值{' '}
          <span className="num">{money(p.threshold_at_time)}</span>
          <small>
            加后预计 <span className="num">{money((p.balance_at_proposal ?? 0) + p.amount)}</span>
          </small>
        </span>
        <span className="board-amount num">+{money(p.amount)}</span>
        <span className="board-state state-signal">待审批</span>
        <span className="board-actions">
          {!readOnly && (
            <button
              className="btn btn-signal"
              disabled={busy}
              onClick={() => {
                if (confirm(`确认给 #${p.user_id} 加 ${p.amount}？这会真实写入 sub2api。`))
                  action(() => api.approveProposal(p.id), '已加额度');
              }}
            >
              批准并加额
            </button>
          )}
          {!readOnly && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                const note = prompt('拒绝原因（可留空）', '');
                if (note !== null) action(() => api.rejectProposal(p.id, note), '已拒绝');
              }}
            >
              拒绝
            </button>
          )}
          <DetailToggle open={open} onToggle={onToggle} />
        </span>
      </div>
      {open && (
        <div className="board-detail">
          <dl>
            <div>
              <dt>提议时间</dt>
              <dd>{when(p.created_at)}</dd>
            </div>
            <div>
              <dt>提议时余额</dt>
              <dd className="num">{money(p.balance_at_proposal)}</dd>
            </div>
            <div>
              <dt>当时阈值</dt>
              <dd className="num">{money(p.threshold_at_time)}</dd>
            </div>
            <div>
              <dt>拟加额</dt>
              <dd className="num">+{money(p.amount)}</dd>
            </div>
          </dl>
          <p>批准前会重新读取实时余额；若余额已回到阈值以上，这条提议会自动失效，不会重复加额。</p>
        </div>
      )}
    </li>
  );
}

function urgency(user, blocked) {
  if (blocked.has(user.user_id)) return 0;
  if (!user.enabled) return 5;
  if (user.liveBalance == null) return 3;
  if (user.liveBalance < user.threshold) return 1;
  if (user.balanceStale) return 2;
  return 4;
}

function headroom(user) {
  if (user.liveBalance == null) return Infinity;
  return user.liveBalance / Math.max(user.threshold + user.amount, 0.01);
}

export function UserStateBadge({ user, blocked }) {
  const low = user.liveBalance != null && user.liveBalance < user.threshold;
  if (blocked) return <Badge tone="danger">待核实 · 已拦截</Badge>;
  if (!user.enabled) return <Badge tone="muted">已停用</Badge>;
  if (!user.balanceObservedAt) return <Badge tone="muted">等待首次巡检</Badge>;
  if (user.balanceStale) return <Badge tone="caution">数据已过期</Badge>;
  if (low) return <Badge tone="caution">低于阈值</Badge>;
  return <Badge tone="ok">正常</Badge>;
}

function BalancePanel({ users, blocked, goTo }) {
  const sorted = [...users].sort((a, b) => urgency(a, blocked) - urgency(b, blocked) || headroom(a) - headroom(b));
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>余额</h2>
        <span className="panel-meta">{users.length} 位监控用户 · 按紧急程度排序，刻度线为阈值</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => goTo('users')}>
          管理监控
        </button>
      </header>
      {!users.length ? (
        <div className="empty">
          <p>还没有监控任何用户。添加用户 ID、阈值和每次加额后，巡检会读取余额并在这里排序显示。</p>
          <button type="button" className="btn btn-primary" onClick={() => goTo('users')}>
            添加监控用户
          </button>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="table balance-table stack-table">
            <thead>
              <tr>
                <th>用户</th>
                <th className="right">最近余额</th>
                <th className="gauge-col">余量</th>
                <th className="right">阈值</th>
                <th className="right">每次加</th>
                <th>状态</th>
                <th>模式</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((u) => {
                const isBlocked = blocked.has(u.user_id);
                const low = u.liveBalance != null && u.liveBalance < u.threshold;
                return (
                  <tr key={u.user_id} className={u.enabled ? undefined : 'is-disabled'}>
                    <td>
                      <UserCell id={u.user_id} email={u.email} />
                    </td>
                    <td
                      className={low ? 'right num balance is-low' : 'right num balance'}
                      title={u.balanceObservedAt ? `查询于 ${when(u.balanceObservedAt)}` : '等待首次巡检'}
                    >
                      {money(u.liveBalance)}
                    </td>
                    <td className="gauge-col stack-full">
                      <BalanceGauge balance={u.liveBalance} threshold={u.threshold} amount={u.amount} blocked={isBlocked} />
                    </td>
                    <td className="right num" data-label="阈值">
                      {money(u.threshold)}
                    </td>
                    <td className="right num" data-label="每次加">
                      {money(u.amount)}
                    </td>
                    <td data-label="状态">
                      <UserStateBadge user={u} blocked={isBlocked} />
                    </td>
                    <td className="muted" data-label="模式">
                      {u.mode === 'approval' ? '需审批' : '自动'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OwedPanel({ recon, goTo }) {
  const items = recon?.items || [];
  const records = items.reduce((sum, item) => sum + item.count, 0);
  const top = [...items].sort((a, b) => b.total - a.total).slice(0, 5);
  return (
    <section className="panel owed">
      <header className="panel-head">
        <h2>待收款</h2>
        <span className="panel-meta">已确认到账、尚未收回</span>
      </header>
      <div className="owed-body">
        <p className="owed-total num">{recon ? money(recon.grandTotal) : '—'}</p>
        <p className="owed-meta">
          {items.length} 位用户 · {records} 笔
        </p>
        {top.length > 0 && (
          <ol className="owed-list">
            {top.map((item) => (
              <li key={item.userId}>
                <UserCell id={item.userId} email={item.email} />
                <span className="num">{money(item.total)}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="owed-actions">
          <button type="button" className="btn btn-primary" onClick={() => goTo('recon')}>
            去对账收款
          </button>
          <a className="btn" href="/api/reconciliation.csv" download>
            导出待收 CSV
          </a>
        </div>
      </div>
    </section>
  );
}
