import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { AccountSettings, EnrollmentScreen, ROLE_LABELS } from './Accounts.jsx';

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 }));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function Badge({ tone, children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function statusTone(status) {
  if (status === 'success') return 'ok';
  if (status === 'pending') return 'warn';
  if (status === 'unknown') return 'danger';
  return 'muted';
}

export default function App() {
  const [tab, setTab] = useState('users');
  const [session, setSession] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [users, setUsers] = useState([]);
  const [records, setRecords] = useState([]);
  const [recon, setRecon] = useState(null);
  const [events, setEvents] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [enrollmentToken, setEnrollmentToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('enroll'));

  useEffect(() => {
    const changed = () => setEnrollmentToken(new URLSearchParams(window.location.hash.slice(1)).get('enroll'));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);

  useEffect(() => {
    // Keep bearer invitations out of the address bar, history, and referrers.
    // The token stays only in this page's memory until enrollment is finished.
    if (enrollmentToken) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [enrollmentToken]);

  const refresh = useCallback(async () => {
    try {
      const [c, u, r, rc, e, p] = await Promise.all([
        api.config(), api.users(), api.records(), api.reconciliation(), api.events(), api.proposals(),
      ]);
      setCfg(c); setUsers(u.items); setRecords(r.items); setRecon(rc); setEvents(e.items); setProposals(p.items);
      setError(null);
    } catch (err) {
      if (err.status === 401) {
        setSession((current) => ({ authenticated: false, authRequired: true, totpRequired: current?.totpRequired === true }));
        setError(null);
      } else {
        setError(err.message);
      }
    }
  }, []);

  useEffect(() => {
    if (enrollmentToken) return;
    api.session().then(setSession).catch((err) => {
      setError(err.message);
      setSession({ authenticated: false, authRequired: true });
    });
  }, [enrollmentToken]);

  useEffect(() => {
    if (!session?.authenticated || enrollmentToken) return undefined;
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh, session?.authenticated, enrollmentToken]);

  function notify(msg, tone = 'ok') {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 4000);
  }

  async function action(fn, msg) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (msg) notify(msg);
      return true;
    } catch (err) {
      notify(err.message, 'danger');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const killSwitch = cfg?.killSwitch;
  const owed = recon?.grandTotal ?? 0;
  const readOnly = !['admin', 'operator'].includes(session?.role);

  if (enrollmentToken) return <EnrollmentScreen token={enrollmentToken} onDone={async () => {
    try { await api.logout(); } catch { /* A new recipient may have no session. */ }
    setEnrollmentToken(null); setSession(null);
  }} />;

  if (!session) return <div className="auth-loading">正在检查登录状态…</div>;
  if (!session.authenticated) {
    return <LoginScreen onLogin={(nextSession) => { setSession(nextSession); setError(null); }} initialError={error} requireTotp={session.totpRequired === true} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◈</span>
          <div>
            <h1>sub2api 余额哨兵</h1>
            <p className="sub">
              {cfg ? `${cfg.baseUrl} · ${cfg.monitor.enabled ? '每' : '巡检已关闭，间隔'} ${Math.round(cfg.monitor.intervalMs / 1000)}s${cfg.monitor.enabled ? ' 轮询' : ''}` : '连接中…'}
            </p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="identity-label">{session.username} · {ROLE_LABELS[session.role]}</span>
          {!readOnly && killSwitch != null && (
            <button
              className={killSwitch ? 'btn btn-danger' : 'btn btn-ghost'}
              disabled={busy}
              onClick={() => action(() => api.setKillSwitch(!killSwitch), killSwitch ? '急停已解除；写入仍受配置和护栏限制' : '急停已启用')}
            >
              {killSwitch ? '⏸ 急停中 · 点击解除' : !cfg.monitor.autoTopUpEnabled ? '观察模式 · 点击急停' : !cfg.monitor.enabled ? '巡检已关闭 · 点击急停' : '⏵ 自动加额度运行中'}
            </button>
          )}
          {!readOnly && <button className="btn" disabled={busy} onClick={() => action(() => api.tickNow(), '已立即巡检一次')}>
            立即巡检
          </button>}
          {!readOnly && cfg?.notify?.enabled && (
            <button className="btn btn-ghost" disabled={busy} title={`发送到 ${cfg.notify.host}`}
              onClick={() => action(() => api.testNotify(), '测试通知已发送')}>
              测试通知
            </button>
          )}
          <button className="btn btn-ghost" disabled={busy} onClick={() => action(async () => {
            await api.logout();
            setSession((current) => ({ authenticated: false, authRequired: true, totpRequired: current?.totpRequired === true }));
          }, null)}>退出</button>
        </div>
      </header>

      {error && <div className="banner banner-danger">无法连接后端：{error}</div>}
      {cfg && !cfg.adminKeyConfigured && (
        <div className="banner banner-danger">未配置 SUB2API_ADMIN_API_KEY，请在 .env 中填写后重启。</div>
      )}
      {cfg && !cfg.monitor.autoTopUpEnabled && (
        <div className="banner banner-warn">AUTO_TOPUP_ENABLED=false：当前只观察不写入。</div>
      )}
      {cfg && cfg.consecutiveFailures >= cfg.guard.circuitBreakerFailures && (
        <div className="banner banner-danger">
          熔断已触发（连续失败 {cfg.consecutiveFailures} 次），写入已停止。
          {!readOnly && <button className="link" onClick={() => action(() => api.resetCircuit(), '熔断已重置')}>确认后重置</button>}
        </div>
      )}

      <section className="stats">
        <Stat label="待收款金额" value={fmt(owed)} accent />
        <Stat label="监控用户" value={users.length} />
        <Stat label="加额度记录" value={records.length} />
        <Stat label="最近巡检" value={cfg?.lastTick ? when(cfg.lastTick) : '—'} small />
      </section>

      <nav className="tabs">
        {[['users', '监控用户'], ['approvals', `待审批${proposals.length ? ` (${proposals.length})` : ''}`], ['records', '加额流水'], ['recon', '对账收款'], ['events', '运行日志'], ['account', session.role === 'admin' ? '账户管理' : '账户安全']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>

      <main>
        {tab === 'users' && <UsersTab users={users} cfg={cfg} busy={busy || readOnly} readOnly={readOnly} action={action} />}
        {tab === 'approvals' && <ApprovalsTab proposals={proposals} busy={busy || readOnly} action={action} />}
        {tab === 'records' && <RecordsTab records={records} busy={busy} readOnly={readOnly} action={action} />}
        {tab === 'recon' && <ReconTab recon={recon} busy={busy || readOnly} action={action} />}
        {tab === 'events' && <EventsTab events={events} />}
        {tab === 'account' && <AccountSettings session={session} busy={busy} action={action} />}
      </main>

      {toast && <div className={`toast toast-${toast.tone}`}>{toast.msg}</div>}
    </div>
  );
}

function LoginScreen({ onLogin, initialError, requireTotp }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || '');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await api.login(username, password, requireTotp ? otp : undefined);
      setPassword('');
      setOtp('');
      onLogin(session);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-kicker">SUB2API · BALANCE SENTINEL</div>
        <h1>安全登录</h1>
        <p>输入哨兵账户凭据以查看获授权的余额与对账记录。</p>
        {error && <div className="banner banner-danger">{error}</div>}
        <label>用户名
          <input autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>密码
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {requireTotp && <label>动态验证码
          <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength="6" required value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>}
        <button className="btn btn-primary" disabled={busy}>{busy ? '正在验证…' : '登录'}</button>
      </form>
    </main>
  );
}

function Stat({ label, value, accent, small }) {
  return (
    <div className={accent ? 'stat accent' : 'stat'}>
      <div className="stat-label">{label}</div>
      <div className={small ? 'stat-value small' : 'stat-value'}>{value}</div>
    </div>
  );
}

function UsersTab({ users, cfg, busy, action, readOnly = false }) {
  const [form, setForm] = useState({ userId: '', threshold: 20, amount: 100 });
  const [editing, setEditing] = useState(null);
  const cap = cfg?.guard?.maxTopUpAmountPerEvent ?? 100;

  function submit(e) {
    e.preventDefault();
    action(
      () => api.addUser({ userId: Number(form.userId), threshold: Number(form.threshold), amount: Number(form.amount) }),
      '已加入监控',
    ).then(() => setForm({ userId: '', threshold: 20, amount: 100 }));
  }

  return (
    <>
      {!readOnly && <form className="card form-row" onSubmit={submit}>
        <label>
          用户 ID
          <input required inputMode="numeric" value={form.userId} placeholder="例如 42"
            onChange={(e) => setForm({ ...form, userId: e.target.value })} />
        </label>
        <label>
          阈值（低于即补）
          <input required type="number" step="0.01" min="0.01" value={form.threshold}
            onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
        </label>
        <label>
          每次加
          <input required type="number" step="0.01" min="0.01" max={cap} value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </label>
        <button className="btn btn-primary" disabled={busy}>添加监控</button>
        <p className="hint">单次上限 {cap}（由 GUARD_MAX_TOPUP_PER_EVENT 控制）。只有这里的用户会被加额度。</p>
      </form>}

      {users.length === 0 ? (
        <div className="empty">还没有监控任何用户。先添加一个用户 ID。</div>
      ) : (
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>用户</th><th>最近查询余额</th><th>阈值</th><th>每次加</th>
              <th>今日</th><th>最近一次</th><th>状态</th><th>模式</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const low = u.liveBalance != null && u.liveBalance < u.threshold;
              return (
                <React.Fragment key={u.user_id}>
                  <tr>
                    <td>
                      <div className="mono">#{u.user_id}</div>
                      <div className="muted small">{u.email || '—'}</div>
                    </td>
                    <td className={low ? 'balance low' : 'balance'}>
                      {fmt(u.liveBalance)}
                      <div className="muted small">{u.balanceObservedAt ? when(u.balanceObservedAt) : '等待首次巡检'}</div>
                      {u.balanceObservedAt && u.balanceStale && <Badge tone="warn">数据已过期</Badge>}
                    </td>
                    <td>{fmt(u.threshold)}</td>
                    <td>{fmt(u.amount)}</td>
                    <td>{u.todayCount} 次 / {fmt(u.todayTotal)}</td>
                    <td>
                      {u.lastTopUp ? (
                        <>
                          <Badge tone={statusTone(u.lastTopUp.status)}>{u.lastTopUp.status}</Badge>
                          <div className="muted small">{when(u.lastTopUp.created_at)}</div>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td>{u.enabled ? <Badge tone="ok">监控中</Badge> : <Badge tone="muted">已停用</Badge>}</td>
                    <td>
                      <button className="btn btn-sm" disabled={busy} title="切换自动执行 / 需人工审批"
                        onClick={() => action(
                          () => api.updateUser(u.user_id, { mode: u.mode === 'approval' ? 'auto' : 'approval' }),
                          u.mode === 'approval' ? '已切换为自动加额' : '已切换为需审批',
                        )}>
                        {u.mode === 'approval' ? '需审批' : '自动'}
                      </button>
                    </td>
                    <td className="row-actions">
                      <button className="btn btn-sm" disabled={busy}
                        onClick={() => setEditing(editing?.userId === u.user_id ? null : { userId: u.user_id, threshold: u.threshold, amount: u.amount })}>
                        调参数
                      </button>
                      <button className="btn btn-sm" disabled={busy}
                        onClick={() => action(() => api.updateUser(u.user_id, { enabled: !u.enabled }), u.enabled ? '已停用' : '已启用')}>
                        {u.enabled ? '停用' : '启用'}
                      </button>
                      <button className="btn btn-sm" disabled={busy}
                        onClick={() => {
                          if (confirm(`确认立即给 #${u.user_id} 加 ${u.amount}？这会真实写入 sub2api。`)) {
                            action(() => api.topUp(u.user_id, u.amount), '已加额度');
                          }
                        }}>立即加额</button>
                      <button className="btn btn-sm btn-danger" disabled={busy}
                        onClick={() => confirm(`停止监控 #${u.user_id}？（不会删除历史流水）`) && action(() => api.removeUser(u.user_id), '已移除')}>
                        移除
                      </button>
                    </td>
                  </tr>
                  {editing?.userId === u.user_id && (
                    <tr>
                      <td colSpan="9">
                        <form className="inline-edit" onSubmit={(e) => {
                          e.preventDefault();
                          action(() => api.updateUser(u.user_id, { threshold: Number(editing.threshold), amount: Number(editing.amount) }), '参数已更新')
                            .then((ok) => { if (ok) setEditing(null); });
                        }}>
                          <label>低于余额阈值
                            <input type="number" min="0.01" step="0.01" required value={editing.threshold}
                              onChange={(e) => setEditing({ ...editing, threshold: e.target.value })} />
                          </label>
                          <label>固定加额
                            <input type="number" min="0.01" step="0.01" max={cap} required value={editing.amount}
                              onChange={(e) => setEditing({ ...editing, amount: e.target.value })} />
                          </label>
                          <button className="btn btn-primary btn-sm" disabled={busy}>保存</button>
                          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditing(null)}>取消</button>
                          <span className="hint">单次上限 {cap}</span>
                        </form>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </>
  );
}

function ApprovalsTab({ proposals, busy, action }) {
  if (!proposals.length) {
    return (
      <div className="empty">
        没有待审批的加额请求。<br />
        <span className="muted small">把用户的模式切到「需审批」后，余额低于阈值时会先在这里等你确认，不会直接扣钱。</span>
      </div>
    );
  }
  return (
    <div className="table-scroll">
    <table className="table">
      <thead>
        <tr><th>时间</th><th>用户</th><th>提议时余额</th><th>拟加额</th><th>加后预计</th><th>操作</th></tr>
      </thead>
      <tbody>
        {proposals.map((p) => (
          <tr key={p.id}>
            <td className="nowrap">{when(p.created_at)}</td>
            <td>
              <div className="mono">#{p.user_id}</div>
              <div className="muted small">{p.email || '—'}</div>
            </td>
            <td className="balance low">{fmt(p.balance_at_proposal)}</td>
            <td className="amount">+{fmt(p.amount)}</td>
            <td>{fmt((p.balance_at_proposal ?? 0) + p.amount)}</td>
            <td className="row-actions">
              <button className="btn btn-sm btn-primary" disabled={busy}
                onClick={() => {
                  if (confirm(`确认给 #${p.user_id} 加 ${p.amount}？这会真实写入 sub2api。`)) {
                    action(() => api.approveProposal(p.id), '已加额度');
                  }
                }}>批准并加额</button>
              <button className="btn btn-sm btn-danger" disabled={busy}
                onClick={() => {
                  const note = prompt('拒绝原因（可留空）', '');
                  if (note !== null) action(() => api.rejectProposal(p.id, note), '已拒绝');
                }}>拒绝</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function RecordsTab({ records, busy, action, readOnly = false }) {
  const [inspection, setInspection] = useState(null);

  function inspect(id, verify = false) {
    return action(async () => {
      if (verify) await api.verifyRecord(id);
      const { items } = await api.recordChecks(id);
      setInspection({ id, items });
    }, verify ? '核验结果已留存，请查看证据' : null);
  }

  if (!records.length) return <div className="empty">还没有加额度记录。</div>;
  return (
    <>
    <p className="hint reconciliation-hint">上游核对按流水 ID、用户、金额逐笔匹配，不使用余额差推算。未找到记录不代表未到账，不会触发补发。</p>
    <div className="table-scroll">
    <table className="table">
      <thead>
        <tr>
          <th>时间</th><th>用户</th><th>加额前</th><th>加额</th><th>加额后</th>
          <th>来源</th><th>操作者</th><th>状态</th><th>上游核对</th><th>收款</th>
        </tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <tr key={r.id}>
            <td className="nowrap">{when(r.created_at)}<div className="muted small mono" title={r.id}>{r.id.slice(-12)}</div></td>
            <td>
              <div className="mono">#{r.user_id}</div>
              <div className="muted small">{r.email || '—'}</div>
            </td>
            <td>{fmt(r.balance_before)}</td>
            <td className="amount">+{fmt(r.amount)}</td>
            <td>{fmt(r.balance_after)}</td>
            <td>{r.source === 'auto' ? '自动' : r.source === 'approval' ? '审批' : '手动'}{r.idempotent_replay ? ' (重放)' : ''}</td>
            <td className="mono">{r.actor || '—'}{r.provider_reference ? <div className="muted small">ref: {r.provider_reference}</div> : null}</td>
            <td>
              <Badge tone={statusTone(r.status)}>{r.status}</Badge>
              {r.error && <div className="muted small" title={r.error}>{r.error.slice(0, 60)}</div>}
            </td>
            <td>
              <VerificationBadge outcome={r.verification_status} />
              <div className="muted small">{when(r.verified_at)}</div>
              <div className="row-actions">
                <button className="btn btn-sm" disabled={busy || readOnly} onClick={() => inspect(r.id, true)}>核对上游</button>
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => inspect(r.id)}>证据</button>
                {['pending', 'unknown', 'failed'].includes(r.status) && (
                  <button className="btn btn-sm" disabled={busy || readOnly || r.verification_status !== 'matched'}
                    title="必须重新查询并找到唯一匹配的调账凭据，才允许确认到账"
                    onClick={() => {
                      if (confirm(`确认按上游凭据将 ${r.id} 记为已到账？不会再次加额。未决拦截解除后，该用户可能恢复自动加额。`)) {
                        action(async () => {
                          await api.resolveApplied(r.id);
                          setInspection({ id: r.id, items: (await api.recordChecks(r.id)).items });
                        }, '已根据上游凭据确认到账，未发送加额请求');
                      }
                    }}>确认已到账</button>
                )}
              </div>
            </td>
            <td>
              {r.reconciled
                ? <Badge tone="ok">已收</Badge>
                : r.status === 'success'
                  ? <button className="btn btn-sm" disabled={busy || readOnly} onClick={() => action(() => api.reconcile(r.id, ''), '已确认收款；上游核对状态不变')}>标记已收</button>
                  : <span className="muted">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
    {inspection && (
      <section className="card evidence-panel" aria-label="对账核验凭据">
        <div className="row-actions">
          <h2>核验凭据</h2>
          <a className="btn btn-sm" href={`/api/records/${encodeURIComponent(inspection.id)}/checks.csv`} download>导出完整核验凭据</a>
          <button className="btn btn-sm btn-ghost" onClick={() => setInspection(null)}>关闭</button>
        </div>
        <p className="mono">{inspection.id}</p>
        {!inspection.items.length && <p className="muted">尚无核验记录，请先点击“核对上游”。</p>}
        {inspection.items.map((check) => (
          <details key={check.id} className="evidence-entry">
            <summary><VerificationBadge outcome={check.outcome} /> {when(check.created_at)} · {check.actor} · {check.kind === 'resolution_applied' ? '确认到账' : '核验'}</summary>
            <p>{check.summary}</p>
            <p className="muted small">原流水状态：{check.previous_status} · 上游引用：{check.provider_reference || '无'}</p>
            <p className="mono small">SHA-256: {check.evidence_sha256}</p>
            <pre>{JSON.stringify(check.evidence, null, 2)}</pre>
          </details>
        ))}
      </section>
    )}
    </>
  );
}

function VerificationBadge({ outcome }) {
  const labels = { matched: '已匹配', not_found: '未找到，需核实', mismatch: '存在差异', incomplete: '扫描不完整', error: '查询失败' };
  const tone = outcome === 'matched' ? 'ok' : ['mismatch', 'error'].includes(outcome) ? 'danger' : outcome ? 'warn' : 'muted';
  return <Badge tone={tone}>{labels[outcome] || '未核对'}</Badge>;
}

function ReconTab({ recon, busy, action }) {
  if (!recon) return <div className="empty">加载中…</div>;
  if (!recon.items.length) return <div className="empty">暂无已确认的待收款记录。未决流水请到“加额流水”核实。</div>;
  return (
    <>
      <p className="hint reconciliation-hint">本页只确认实际收款，不会改变上游核对结果；逐笔核验和差异处理在“加额流水”中进行。</p>
      <div className="card recon-head">
        <div>
          <div className="stat-label">待向用户收取合计</div>
          <div className="stat-value accent-text">{fmt(recon.grandTotal)}</div>
        </div>
        <div className="row-actions">
          <a className="btn" href="/api/reconciliation.csv" download>导出待收 CSV</a>
          <a className="btn btn-ghost" href="/api/records.csv" download>导出完整流水</a>
        </div>
      </div>
      <div className="table-scroll">
      <table className="table">
        <thead>
          <tr><th>用户</th><th>笔数</th><th>应收取</th><th>首次</th><th>最近</th><th>操作</th></tr>
        </thead>
        <tbody>
          {recon.items.map((it) => (
            <tr key={it.userId}>
              <td>
                <div className="mono">#{it.userId}</div>
                <div className="muted small">{it.email || '—'}</div>
              </td>
              <td>{it.count}</td>
              <td className="amount">{fmt(it.total)}</td>
              <td className="nowrap">{when(it.firstAt)}</td>
              <td className="nowrap">{when(it.lastAt)}</td>
              <td>
                <button className="btn btn-sm btn-primary" disabled={busy}
                  onClick={() => {
                    if (confirm(`确认已向 #${it.userId} 收取 ${it.total}？将标记其 ${it.count} 笔为已对账。`)) {
                      action(
                        () => Promise.all(it.recordIds.map((id) => api.reconcile(id, 'bulk'))),
                        `已结清 #${it.userId}`,
                      );
                    }
                  }}>确认已收款</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}

function EventsTab({ events }) {
  if (!events.length) return <div className="empty">暂无日志。</div>;
  return (
    <div className="table-scroll">
    <table className="table">
      <thead><tr><th>时间</th><th>级别</th><th>用户</th><th>操作者</th><th>事件</th><th>说明</th></tr></thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td className="nowrap">{when(e.at)}</td>
            <td><Badge tone={e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warn' : 'muted'}>{e.level}</Badge></td>
            <td className="mono">{e.user_id ? `#${e.user_id}` : '—'}</td>
            <td className="mono">{e.actor || 'system'}</td>
            <td className="mono">{e.kind}</td>
            <td>{e.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
