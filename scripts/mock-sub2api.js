/**
 * Standalone mock of the parts of sub2api this project uses.
 * Lets you exercise the UI and the full pipeline without touching a real instance.
 *
 *   node scripts/mock-sub2api.js            # listens on :8080
 *   PORT=9099 node scripts/mock-sub2api.js
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const ADMIN_KEY = process.env.MOCK_ADMIN_KEY || 'admin-mock-key-for-local-testing';

const users = new Map([
  [1, { id: 1, email: 'alice@example.com', username: 'alice', balance: 5, status: 'active' }],
  [2, { id: 2, email: 'bob@example.com', username: 'bob', balance: 88, status: 'active' }],
  [3, { id: 3, email: 'carol@example.com', username: 'carol', balance: 0, status: 'active' }],
]);
const idem = new Map();
const history = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, obj) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
  };

  if (url.pathname.startsWith('/api/v1/admin/') && req.headers['x-api-key'] !== ADMIN_KEY) {
    return send(401, { code: 401, reason: 'INVALID_ADMIN_KEY', message: 'Invalid admin API key' });
  }

  let m = url.pathname.match(/^\/api\/v1\/admin\/users\/(\d+)$/);
  if (m && req.method === 'GET') {
    const u = users.get(Number(m[1]));
    return u ? send(200, { code: 0, message: 'success', data: u }) : send(404, { code: 404, message: 'user not found' });
  }

  m = url.pathname.match(/^\/api\/v1\/admin\/users\/(\d+)\/balance$/);
  if (m && req.method === 'POST') {
    const key = req.headers['idempotency-key'];
    if (!key) return send(400, { code: 400, reason: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key required' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = JSON.parse(body || '{}');
      if (idem.has(key)) {
        res.setHeader('x-idempotency-replayed', 'true');
        return send(200, { code: 0, data: idem.get(key) });
      }
      const u = users.get(Number(m[1]));
      if (!u) return send(404, { code: 404, message: 'user not found' });
      if (!(p.balance > 0)) return send(400, { code: 400, message: 'balance must be > 0' });
      if (!['add', 'set', 'subtract'].includes(p.operation)) return send(400, { code: 400, message: 'bad operation' });
      if (p.operation === 'add') u.balance = Number((u.balance + p.balance).toFixed(8));
      if (p.operation === 'set') u.balance = Number(p.balance.toFixed(8));
      if (p.operation === 'subtract') u.balance = Number((u.balance - p.balance).toFixed(8));
      history.unshift({
        id: history.length + 1, type: 'admin_balance', value: p.operation === 'subtract' ? -p.balance : p.balance,
        status: 'used', used_by: u.id, used_at: new Date().toISOString(),
        created_at: new Date().toISOString(), notes: p.notes || '',
      });
      console.log(`[mock] user ${u.id} ${p.operation} ${p.balance} -> balance ${u.balance}`);
      idem.set(key, u);
      send(200, { code: 0, message: 'success', data: u });
    });
    return;
  }

  m = url.pathname.match(/^\/api\/v1\/admin\/users\/(\d+)\/balance-history$/);
  if (m && req.method === 'GET') {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('page_size')) || 100));
    const rows = history.filter((row) => row.used_by === Number(m[1]));
    return send(200, { code: 0, data: {
      items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length,
      page, page_size: pageSize, pages: Math.max(1, Math.ceil(rows.length / pageSize)),
    } });
  }

  if (url.pathname === '/api/v1/admin/users' && req.method === 'GET') {
    const q = (url.searchParams.get('search') || '').toLowerCase();
    const items = [...users.values()].filter((u) => !q || u.email.includes(q) || (u.username || '').includes(q));
    return send(200, { code: 0, data: { items, total: items.length, page: 1, page_size: 20, pages: 1 } });
  }

  send(404, { code: 404, message: `no route ${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] sub2api listening on http://127.0.0.1:${PORT}`);
  console.log('[mock] admin key is configured from MOCK_ADMIN_KEY (value is never printed)');
  console.log('[mock] users:');
  for (const u of users.values()) console.log(`  #${u.id} ${u.email} balance=${u.balance}`);
});
