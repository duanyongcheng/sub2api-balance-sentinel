import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { api } from '../../web/src/api.js';
import { createRequestGate, DEFAULT_LEDGER_QUERY, ledgerPage, ledgerQueryReducer } from '../../web/src/ledger-query.js';

test('ledger pagination uses the full backend total, not the current page length', () => {
  const first = { ...DEFAULT_LEDGER_QUERY };
  const page = ledgerPage(first, 251);
  assert.deepEqual(page, { pages: 6, page: 1, lastOffset: 250, hasPrevious: false, hasNext: true });
  const last = ledgerQueryReducer(first, { type: 'page', offset: page.lastOffset });
  assert.deepEqual(ledgerPage(last, 251), { pages: 6, page: 6, lastOffset: 250, hasPrevious: true, hasNext: false });
  assert.deepEqual(ledgerPage(first, 0), { pages: 1, page: 1, lastOffset: 0, hasPrevious: false, hasNext: false });
  assert.equal(ledgerPage(last, 0).lastOffset, 0, 'empty final pages can return to the first page');
});

test('changing user, status or page size always returns to page one', () => {
  const query = { ...DEFAULT_LEDGER_QUERY, offset: 200, userId: '42' };
  const filtered = ledgerQueryReducer(query, { type: 'filter', values: { status: 'unresolved' } });
  assert.equal(filtered.offset, 0);
  assert.equal(filtered.userId, '42');
  assert.equal(filtered.status, 'unresolved');
  const resized = ledgerQueryReducer(query, { type: 'filter', values: { limit: 25 } });
  assert.equal(resized.offset, 0);
  assert.equal(resized.limit, 25);
  assert.equal(ledgerQueryReducer(query, { type: 'page', offset: -50 }).offset, 0);
  assert.equal(query.offset, 200, 'reducers must not mutate the existing query');
});

test('superseded requests and unmounted queries cannot publish data or errors', async () => {
  const gate = createRequestGate();
  const published = [];
  let finishOld;
  const old = gate.begin();
  const pending = new Promise((resolve) => { finishOld = resolve; }).then(() => {
    if (gate.isCurrent(old)) published.push('old');
  });
  const current = gate.begin();
  if (gate.isCurrent(current)) published.push('new');
  finishOld();
  await pending;
  assert.deepEqual(published, ['new']);
  gate.invalidate();
  assert.equal(gate.isCurrent(current), false);
});

test('records API sends full filtering and pagination and supports aborting an old query', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ items: [], total: 251, limit: 50, offset: 200 }), { status: 200 });
  });
  const controller = new AbortController();
  const result = await api.records({ userId: 42, status: 'unresolved', limit: 50, offset: 200 }, { signal: controller.signal });
  const params = new URL(calls[0].url, 'http://localhost').searchParams;
  assert.deepEqual(Object.fromEntries(params), { limit: '50', offset: '200', userId: '42', status: 'unresolved' });
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(result.total, 251);
  await api.records();
  assert.equal(calls[1].url, '/api/records?limit=50&offset=0');
});

test('rule update and removal transport preserve the supplied optimistic revision', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: 'sentinel_csrf=csrf-token' } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response('{}', { status: 200 });
  });
  await api.updateUser(42, { amount: 50, ruleRevision: 'opened-edit-revision' });
  await api.removeUser(42, 'displayed-revision');
  assert.equal(JSON.parse(calls[0].options.body).ruleRevision, 'opened-edit-revision');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].options.body), { ruleRevision: 'displayed-revision' });
  assert.equal(calls[1].options.method, 'DELETE');
  for (const { options } of calls) assert.equal(options.headers['X-CSRF-Token'], 'csrf-token');
});

test('empty ledger renders filters, pagination, and the separate unresolved warning', async () => {
  const vite = await createServer({
    configFile: 'web/vite.config.js', server: { middlewareMode: true }, appType: 'custom',
    // SSR needs module transforms only; browser scanning can outlive this test.
    optimizeDeps: { noDiscovery: true, entries: [], include: [] },
  });
  try {
    const { RecordsTab, UsersTab } = await vite.ssrLoadModule('/src/App.jsx');
    const empty = renderToStaticMarkup(React.createElement(RecordsTab, { users: [], busy: false, action: async () => true }));
    for (const label of ['流水用户 ID', '流水状态', '筛选流水', '清除筛选', '每页条数', '流水分页', '上一页', '下一页']) assert.ok(empty.includes(label), label);
    const unresolved = renderToStaticMarkup(React.createElement(RecordsTab, { unresolved: true, busy: false, action: async () => true }));
    assert.ok(unresolved.includes('所有 pending / unknown 流水'));
    assert.ok(unresolved.includes('未核实前继续拦截'));
    assert.equal(unresolved.includes('流水状态'), false, 'the dedicated unresolved view cannot accidentally select successful records');
    const users = renderToStaticMarkup(React.createElement(UsersTab, { users: [], busy: false, action: async () => true }));
    assert.match(users, /<option value="approval" selected="">需人工审批<\/option>/);
  } finally {
    await vite.close();
  }
});
