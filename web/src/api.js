import { withCredentialTransport } from '../../shared/credential-transport.js';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Sentinel': '1' };

function csrfToken() {
  const hit = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('sentinel_csrf='));
  return hit ? decodeURIComponent(hit.slice('sentinel_csrf='.length)) : '';
}

function jsonHeaders() {
  const headers = { ...JSON_HEADERS };
  const token = csrfToken();
  if (token) headers['X-CSRF-Token'] = token;
  return headers;
}

async function handle(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || data?.reason || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function credentialRequest(path, body, authenticated = false, method = 'POST') {
  return withCredentialTransport(window.location, () => fetch(path, {
    method, headers: authenticated ? jsonHeaders() : JSON_HEADERS,
    credentials: 'same-origin', body: JSON.stringify(body),
  }).then(handle));
}

export const api = {
  session: () => fetch('/api/auth/session', { credentials: 'same-origin' }).then(handle),
  login: (username, password, otp) => credentialRequest('/api/auth/login', { username, password, otp }),
  logout: () => fetch('/api/auth/logout', { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin' }).then(handle),
  accounts: () => fetch('/api/accounts', { credentials: 'same-origin' }).then(handle),
  createAccount: (body) => credentialRequest('/api/accounts', body, true),
  updateAccount: (id, body) => credentialRequest(`/api/accounts/${encodeURIComponent(id)}`, body, true, 'PATCH'),
  reinviteAccount: (id, body) => credentialRequest(`/api/accounts/${encodeURIComponent(id)}/reinvite`, body, true),
  enrollmentStart: (token) => credentialRequest('/api/auth/enroll/start', { token }),
  enrollmentFinish: (body) => credentialRequest('/api/auth/enroll/finish', body),
  changePassword: (body) => credentialRequest('/api/auth/password', body, true),
  config: () => fetch('/api/config').then(handle),
  users: () => fetch('/api/users').then(handle),
  addUser: (body) => fetch('/api/users', { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin', body: JSON.stringify(body) }).then(handle),
  updateUser: (id, body) => fetch(`/api/users/${id}`, { method: 'PATCH', headers: jsonHeaders(), credentials: 'same-origin', body: JSON.stringify(body) }).then(handle),
  removeUser: (id) => fetch(`/api/users/${id}`, { method: 'DELETE', headers: jsonHeaders(), credentials: 'same-origin' }).then(handle),
  topUp: (id, amount) => fetch(`/api/users/${id}/topup`, { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin', body: JSON.stringify({ amount }) }).then(handle),
  records: (userId) => fetch(`/api/records${userId ? `?userId=${userId}` : ''}`).then(handle),
  reconcile: (id, note) => fetch(`/api/records/${id}/reconcile`, { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin', body: JSON.stringify({ note }) }).then(handle),
  verifyRecord: (id) => fetch(`/api/records/${encodeURIComponent(id)}/verify`, { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin', body: '{}' }).then(handle),
  recordChecks: (id) => fetch(`/api/records/${encodeURIComponent(id)}/checks`).then(handle),
  resolveApplied: (id) => fetch(`/api/records/${encodeURIComponent(id)}/resolve`, { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin', body: JSON.stringify({ decision: 'applied', confirmation: id }) }).then(handle),
  reconciliation: () => fetch('/api/reconciliation').then(handle),
  events: () => fetch('/api/events').then(handle),
  proposals: () => fetch('/api/proposals?status=pending').then(handle),
  approveProposal: (id) => fetch(`/api/proposals/${id}/approve`, { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin' }).then(handle),
  rejectProposal: (id, note) => fetch(`/api/proposals/${id}/reject`, { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin', body: JSON.stringify({ note }) }).then(handle),
  testNotify: () => fetch('/api/notify/test', { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin' }).then(handle),
  setKillSwitch: (on) => fetch('/api/kill-switch', { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin', body: JSON.stringify({ on }) }).then(handle),
  resetCircuit: () => fetch('/api/circuit-breaker/reset', { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin' }).then(handle),
  tickNow: () => fetch('/api/tick', { method: 'POST', headers: jsonHeaders(), credentials: 'same-origin' }).then(handle),
  testConnection: () => fetch('/api/test-connection').then(handle),
};
