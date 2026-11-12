import React, { useEffect, useState } from 'react';

export const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 }));
export const money = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
export const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Board time: HH:MM today, otherwise the date. The full timestamp lives in the title. */
export function boardTime(iso) {
  if (!iso) return { main: '—', sub: null };
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay(date, new Date())) return { main: time, sub: null };
  return { main: time, sub: date.toLocaleDateString([], { month: '2-digit', day: '2-digit' }) };
}

/** Compact timestamp for table sub-lines: time today, otherwise month-day and time. */
export function shortWhen(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (sameDay(date, new Date())) return `今天 ${time}`;
  return `${date.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${time}`;
}

export function clockTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Badge({ tone, children, title }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function statusTone(status) {
  if (status === 'success') return 'ok';
  if (status === 'pending' || status === 'unknown') return 'danger';
  if (status === 'failed') return 'caution';
  return 'muted';
}

const VERIFICATION_LABELS = {
  matched: '已匹配',
  not_found: '未找到，需核实',
  mismatch: '存在差异',
  incomplete: '扫描不完整',
  error: '查询失败',
};

export function VerificationBadge({ outcome }) {
  const tone = outcome === 'matched' ? 'ok' : ['mismatch', 'error'].includes(outcome) ? 'danger' : outcome ? 'caution' : 'muted';
  return <Badge tone={tone}>{VERIFICATION_LABELS[outcome] || '未核对'}</Badge>;
}

export function verificationLabel(outcome) {
  return VERIFICATION_LABELS[outcome] || '未核对';
}

/**
 * Fixed ramp per rule: empty at 0, full at threshold + amount (the balance a
 * user lands on after one top-up from just under the line). The tick marks
 * the threshold, so the gap to the next top-up reads without arithmetic.
 */
export function BalanceGauge({ balance, threshold, amount, blocked = false }) {
  const max = Math.max(Number(threshold) + Number(amount), Number(threshold), 0.01);
  const pct = balance == null ? 0 : Math.min(Math.max(balance / max, 0), 1);
  const tick = Math.min(Math.max(threshold / max, 0), 1);
  const low = balance != null && balance < threshold;
  const tone = blocked ? 'is-blocked' : low ? 'is-low' : balance == null ? 'is-empty' : '';
  return (
    <span className={`gauge ${tone}`} aria-hidden="true">
      <span className="gauge-fill" style={{ width: `${pct * 100}%` }} />
      <span className="gauge-tick" style={{ left: `${tick * 100}%` }} />
    </span>
  );
}

export function Chevron({ open }) {
  return (
    <svg className={open ? 'chevron is-open' : 'chevron'} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function UserCell({ id, email, size }) {
  return (
    <span className={size === 'lg' ? 'user-cell user-cell-lg' : 'user-cell'}>
      <span className="num user-id">#{id}</span>
      <span className="user-email">{email || '—'}</span>
    </span>
  );
}
