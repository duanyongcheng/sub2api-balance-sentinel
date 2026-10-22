import React, { useEffect, useState } from 'react';
import { api } from './api.js';

export const ROLE_LABELS = { admin: '管理员', operator: '操作员', auditor: '只读审计员' };
const dateText = (value) => value ? new Date(value).toLocaleString() : '—';

export function AccountSettings({ session, busy, action }) {
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', repeat: '', otp: '' });
  const [error, setError] = useState('');

  async function changePassword(event) {
    event.preventDefault();
    if (passwords.newPassword !== passwords.repeat) { setError('两次输入的新密码不一致'); return; }
    setError('');
    const body = { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword,
      ...(session.totpRequired ? { otp: passwords.otp } : {}) };
    setPasswords({ currentPassword: '', newPassword: '', repeat: '', otp: '' });
    await action(() => api.changePassword(body), '密码已修改，所有旧会话已撤销，请重新登录');
  }

  return (
    <div className="account-sections">
      <section className="card">
        <h2>账户安全</h2>
        <p className="muted">{session.username} · {ROLE_LABELS[session.role] || '未知权限'}</p>
        {session.bootstrap ? (
          <p className="hint">这是配置式初始管理员。{session.totpRequired ? '密码和 MFA' : '密码'}通过服务器 Secret 管理；修改后重启会撤销旧会话。请保留该恢复入口。</p>
        ) : (
          <form className="account-form" onSubmit={changePassword}>
            <label>当前密码<input required type="password" autoComplete="current-password" maxLength={1024} value={passwords.currentPassword} onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} /></label>
            <label>新密码<input required type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={passwords.newPassword} onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} /></label>
            <label>重复新密码<input required type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={passwords.repeat} onChange={(e) => setPasswords({ ...passwords, repeat: e.target.value })} /></label>
            {session.totpRequired && <label>新的动态验证码<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={passwords.otp} onChange={(e) => setPasswords({ ...passwords, otp: e.target.value })} /></label>}
            <p className="hint">修改后所有设备上的旧会话都会失效。{session.totpRequired && '请使用未用于登录的新验证码；MFA 丢失时请联系另一位管理员重新邀请。'}</p>
            {error && <p role="alert" className="form-error">{error}</p>}
            <button className="btn" disabled={busy}>修改密码并退出所有会话</button>
          </form>
        )}
      </section>
      {session.role === 'admin' && <AccountsTab session={session} busy={busy} action={action} />}
    </div>
  );
}

function AccountsTab({ session, busy, action }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('auditor');
  const [pending, setPending] = useState(null);
  const [credentials, setCredentials] = useState({ currentPassword: '', otp: '' });
  const [invitation, setInvitation] = useState(null);

  async function load() {
    try { setData(await api.accounts()); setError(''); }
    catch (err) { setError(err.message); }
  }

  useEffect(() => { load(); }, []);

  async function commit(event) {
    event.preventDefault();
    const proof = { currentPassword: credentials.currentPassword, ...(session.totpRequired ? { otp: credentials.otp } : {}) };
    setCredentials({ currentPassword: '', otp: '' });
    const success = await action(async () => {
      let result;
      if (pending.kind === 'create') result = await api.createAccount({ username, role, ...proof });
      else if (pending.kind === 'reinvite') result = await api.reinviteAccount(pending.account.id, { version: pending.account.version, ...proof });
      else result = await api.updateAccount(pending.account.id, { version: pending.account.version, ...pending.changes, ...proof });
      if (result.enrollmentToken) {
        setInvitation({ username: result.account.username, expiresAt: result.expiresAt, url: `${window.location.origin}/#enroll=${result.enrollmentToken}` });
      }
      if (pending.kind === 'create') setUsername('');
      await load();
    }, '账户操作已记录；变更会撤销相关旧会话');
    if (success) setPending(null);
  }

  return (
    <section className="card">
      <div className="row-actions"><h2>账户管理</h2><button className="btn btn-sm" disabled={busy} onClick={load}>刷新列表</button></div>
      <p className="hint account-hint">管理员可管理账户与业务；操作员可监控、加额和对账；审计员只能查看及导出。账户停用不删除历史审计记录。</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {data && !data.accountManagementEnabled && <p className="banner banner-warn">请先在服务器配置 SENTINEL_ACCOUNT_KEY 或对应 Secret 文件，才能创建或重置账户。</p>}
      <form className="form-row account-create" onSubmit={(e) => { e.preventDefault(); setPending({ kind: 'create' }); }}>
        <label>新账号用户名<input required pattern="[A-Za-z0-9._@-]{3,128}" maxLength={128} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>角色<select value={role} onChange={(e) => setRole(e.target.value)}>{Object.entries(ROLE_LABELS).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
        <button className="btn btn-primary" disabled={busy || !data?.accountManagementEnabled}>创建邀请</button>
      </form>
      {invitation && (
        <div className="invitation-box">
          <h3>{invitation.username} 的一次性开通链接</h3>
          <p>请通过可信渠道交给账号本人，由本人设置{session.totpRequired ? '密码及 MFA' : '密码'}。链接持有者可开通此账户；不要放入公开聊天、工单或截图。</p>
          <textarea readOnly aria-label="一次性开通链接" value={invitation.url} rows={3} />
          <p className="muted small">有效期至 {dateText(invitation.expiresAt)}。只在本次操作后显示，遗失后需重新邀请，旧链接随之失效。</p>
          <button className="btn btn-sm" onClick={() => setInvitation(null)}>隐藏链接</button>
        </div>
      )}
      <div className="table-scroll">
        <table className="table account-table">
          <thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>账户开通</th><th>创建者</th><th>操作</th></tr></thead>
          <tbody>{data?.items.map((account) => {
            const own = account.username === session.username;
            return <tr key={account.id}>
              <td className="mono">{account.username}{own ? '（当前账号）' : ''}</td>
              <td><select aria-label={`修改 ${account.username} 的角色`} value={account.role} disabled={busy || own} onChange={(e) => setPending({ kind: 'update', account, changes: { role: e.target.value } })}>{Object.entries(ROLE_LABELS).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></td>
              <td>{account.status === 'invited' ? '待开通' : account.enabled ? '已启用' : '已停用'}{account.invitationExpiresAt && <div className="muted small">邀请到期 {dateText(account.invitationExpiresAt)}</div>}</td>
              <td>{dateText(account.enrolledAt)}</td><td>{account.createdBy}</td>
              <td className="row-actions">
                <button className="btn btn-sm" disabled={busy || own || (!account.enabled && !account.enrolledAt)} onClick={() => setPending({ kind: 'update', account, changes: { enabled: !account.enabled } })}>{account.enabled ? '停用' : '启用'}</button>
                <button className="btn btn-sm btn-danger" disabled={busy || own || !data.accountManagementEnabled} onClick={() => setPending({ kind: 'reinvite', account })}>重新邀请 / 重置凭据</button>
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {pending && (
        <div className="credential-overlay">
          <form className="card credential-dialog account-form" role="dialog" aria-modal="true" aria-labelledby="credential-title" onSubmit={commit}>
            <h2 id="credential-title">重新验证身份</h2>
            <p>{pending.kind === 'create' ? `创建 ${username} · ${ROLE_LABELS[role]}` : pending.kind === 'reinvite' ? `重置 ${pending.account.username} 的凭据，并要求重新开通` : `修改 ${pending.account.username} 的权限或启停状态`}</p>
            <p className="hint">相关旧会话会被撤销。待开通账号的设置变更也会作废原邀请。{session.totpRequired && '请使用未用于登录或上次操作的新动态码。'}</p>
            <label>当前密码<input required autoFocus type="password" autoComplete="current-password" maxLength={1024} value={credentials.currentPassword} onChange={(e) => setCredentials({ ...credentials, currentPassword: e.target.value })} /></label>
            {session.totpRequired && <label>新的动态验证码<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={credentials.otp} onChange={(e) => setCredentials({ ...credentials, otp: e.target.value })} /></label>}
            <div className="row-actions"><button className="btn btn-primary" disabled={busy}>确认账户操作</button><button type="button" className="btn" disabled={busy} onClick={() => { setPending(null); setCredentials({ currentPassword: '', otp: '' }); }}>取消</button></div>
          </form>
        </div>
      )}
    </section>
  );
}

export function EnrollmentScreen({ token, onDone }) {
  const [info, setInfo] = useState(null);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [requireTotp, setRequireTotp] = useState(false);

  useEffect(() => {
    let active = true;
    api.enrollmentStart(token).then((result) => { if (active) { setInfo(result); setRequireTotp(result.totpRequired === true); } }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [token]);

  async function submit(event) {
    event.preventDefault();
    if (password !== repeat) { setError('两次输入的密码不一致'); return; }
    setBusy(true); setError('');
    try {
      await api.enrollmentFinish({ token, password, ...(requireTotp ? { otp } : {}) });
      setInfo(null); setDone(true);
    } catch (err) { setError(err.message); }
    finally { setPassword(''); setRepeat(''); setOtp(''); setBusy(false); }
  }

  return (
    <main className="login-shell">
      <section className="login-card enrollment-card">
        <div className="login-kicker">SUB2API · ACCOUNT ENROLLMENT</div>
        <h1>{done ? '账户已开通' : '安全开通账户'}</h1>
        {done ? <><p>{requireTotp ? '请等待认证器产生下一组新动态码，再使用新密码登录。' : '请使用用户名和刚设置的密码登录。'}</p><button className="btn btn-primary" onClick={onDone}>转到登录</button></> : <>
          {error && <p className="form-error" role="alert">{error}</p>}
          {!info && !error && <p>正在验证邀请…</p>}
          {info && <form className="account-form" onSubmit={submit}>
            <p>{info.username} · {ROLE_LABELS[info.role]}<br />邀请到期：{dateText(info.expiresAt)}</p>
            {requireTotp && <><p className="hint">在自己的认证器中手动添加下面的 Base32 密钥。密钥不发送到第三方二维码服务，请勿截图分享。</p>
            <code className="enrollment-secret">{info.secret}</code></>}
            <label>新密码<input required type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label>重复新密码<input required type="password" autoComplete="new-password" minLength={12} maxLength={1024} value={repeat} onChange={(e) => setRepeat(e.target.value)} /></label>
            {requireTotp && <label>认证器动态验证码<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} /></label>}
            <button className="btn btn-primary" disabled={busy}>{requireTotp ? '验证 MFA 并完成开通' : '设置密码并完成开通'}</button>
          </form>}
          <button className="btn btn-ghost" disabled={busy} onClick={onDone}>返回登录</button>
        </>}
      </section>
    </main>
  );
}
