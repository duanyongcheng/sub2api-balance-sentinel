import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Notifier } from '../src/lib/notify.js';
import { Monitor } from '../src/lib/monitor.js';
import { Sub2ApiError } from '../src/lib/sub2api.js';
import { openDb, createStore } from '../src/db/store.js';
import { config } from '../src/config.js';

function eventStore() {
  const settings = new Map();
  const events = [];
  return {
    settings, events,
    getSetting: (key, fallback) => settings.get(key) ?? fallback,
    setSetting: (key, value) => settings.set(key, String(value)),
    log: (level, kind, message, userId) => events.push({ level, kind, message, userId }),
  };
}

async function webhook(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}/hook?key=secret-webhook-key`;
}

test('provider acknowledgements require explicit, unambiguous success codes', async (t) => {
  let body;
  const url = await webhook(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  const cases = [];
  for (const format of ['wecom', 'dingtalk']) {
    cases.push(
      [format, { errcode: 0, errmsg: 'ok' }, true],
      [format, { errcode: 40013, errmsg: 'invalid webhook secret' }, false],
      [format, { code: 0 }, false],
      [format, { errcode: '0' }, false],
      [format, { errcode: null }, false],
      [format, { errcode: false }, false],
      [format, { errcode: 0, code: 1 }, false],
      [format, { errcode: 0, StatusCode: 1 }, false],
    );
  }
  cases.push(
    ['feishu', { code: 0, msg: 'success', data: {} }, true],
    ['feishu', { StatusCode: 0, StatusMessage: 'success' }, true],
    ['feishu', { code: 0, StatusCode: 0 }, true],
    ['feishu', { code: 19021, msg: 'invalid sign' }, false],
    ['feishu', { StatusCode: 1, StatusMessage: 'failure' }, false],
    ['feishu', { code: 0, StatusCode: 1 }, false],
    ['feishu', { code: 1, StatusCode: 0 }, false],
    ['feishu', { code: 0, errcode: 1 }, false],
    ['feishu', { errcode: 0 }, false],
    ['feishu', { code: '0' }, false],
    ['feishu', { StatusCode: '0' }, false],
    ['feishu', { code: false }, false],
    ['feishu', { StatusCode: null }, false],
    ['feishu', { code: 0, StatusCode: null }, false],
  );
  for (const [format, payload, expected] of cases) {
    await t.test(`${format}: ${JSON.stringify(payload)}`, async () => {
      body = JSON.stringify(payload);
      const store = eventStore();
      const notifier = new Notifier({ store, url, format });
      assert.equal(await notifier.send('test message', { userId: 42 }), expected);
      assert.equal(store.events.length, expected ? 0 : 1);
      if (!expected) {
        assert.equal(store.events[0].kind, 'notify_failed');
        assert.equal(store.events[0].userId, 42);
        assert.doesNotMatch(store.events[0].message, /secret|invalid sign|invalid webhook/);
      }
    });
  }
});

test('missing, malformed and HTML provider replies fail closed', async (t) => {
  let body;
  const url = await webhook(t, (_req, res) => res.end(body));
  for (const format of ['wecom', 'dingtalk', 'feishu']) {
    for (const reply of ['', ' ', '{}', 'null', '[]', '0', 'true', '"ok"', '{', '<html>ok</html>']) {
      await t.test(`${format}: ${JSON.stringify(reply)}`, async () => {
        body = reply;
        assert.equal(await new Notifier({ url, format }).send('test message'), false);
      });
    }
  }
});

test('Slack requires a plain ok acknowledgement, not JSON or HTTP status alone', async (t) => {
  let body;
  const url = await webhook(t, (_req, res) => res.end(body));
  for (const [reply, expected] of [
    ['ok', true], ['ok\n', true],
    ['', false], ['invalid_payload', false], ['OK', false],
    ['"ok"', false], ['{"ok":true}', false], ['<html>ok</html>', false],
  ]) {
    await t.test(JSON.stringify(reply), async () => {
      body = reply;
      assert.equal(await new Notifier({ url, format: 'slack' }).send('test message'), expected);
    });
  }
});

test('generic endpoints retain HTTP-only success for arbitrary or empty bodies', async (t) => {
  let body;
  let status = 200;
  const url = await webhook(t, (_req, res) => {
    res.statusCode = status;
    res.end(body);
  });
  for (const reply of ['', 'ok', '<html>received</html>', '{"code":123}', 'x'.repeat(70_000)]) {
    body = reply;
    assert.equal(await new Notifier({ url, format: 'generic' }).send('test message'), true);
  }
  status = 204;
  assert.equal(await new Notifier({ url, format: 'generic' }).send('test message'), true);
});

test('HTTP failures reject even valid provider success bodies and never expose response secrets', async (t) => {
  let status;
  let body;
  const url = await webhook(t, (_req, res) => {
    res.statusCode = status;
    res.end(body);
  });
  for (const format of ['wecom', 'dingtalk', 'feishu', 'slack', 'generic']) {
    for (const httpStatus of [400, 429, 500]) {
      status = httpStatus;
      body = format === 'slack' ? 'ok' : '{"errcode":0,"code":0,"secret":"response-secret"}';
      const store = eventStore();
      assert.equal(await new Notifier({ store, url, format }).send('test message'), false);
      assert.match(store.events[0].message, new RegExp(`HTTP ${httpStatus}`));
      assert.doesNotMatch(JSON.stringify(store.events), /response-secret|secret-webhook-key|\/hook/);
    }
  }
});

test('provider response size is bounded for fixed-length and streaming responses', async (t) => {
  let fixedLength;
  const body = `${' '.repeat(65_536)}{"errcode":0}`;
  const url = await webhook(t, (_req, res) => {
    if (fixedLength) res.setHeader('content-length', Buffer.byteLength(body));
    res.write(body.slice(0, 20_000));
    res.end(body.slice(20_000));
  });
  for (const fixed of [true, false]) {
    fixedLength = fixed;
    assert.equal(await new Notifier({ url, format: 'wecom' }).send('test message'), false);
  }
});

test('delivery times out both before headers and during a stalled response body', async (t) => {
  let sendHeaders;
  const url = await webhook(t, (_req, res) => {
    if (sendHeaders) {
      res.setHeader('content-type', 'application/json');
      res.write('{"errcode":');
    }
  });
  for (const headers of [false, true]) {
    sendHeaders = headers;
    const store = eventStore();
    assert.equal(await new Notifier({ store, url, format: 'wecom', timeoutMs: 50 }).send('test message'), false);
    assert.equal(store.events[0].message, 'notification delivery timed out');
  }
});

test('transport failures are sanitized and no delivery path throws when logging fails', async (t) => {
  const error = new Error('response-secret at https://example.com/hook?key=secret-webhook-key');
  error.name = 'Error secret-webhook-key';
  t.mock.method(globalThis, 'fetch', async () => { throw error; });
  const store = eventStore();
  const options = { url: 'https://example.com/hook?key=secret-webhook-key', format: 'wecom' };
  assert.equal(await new Notifier({ ...options, store }).send('test message'), false);
  assert.equal(store.events[0].message, 'notification delivery failed');
  assert.doesNotMatch(JSON.stringify(store.events), /response-secret|secret-webhook-key|https:/);

  for (const method of ['getSetting', 'setSetting', 'log']) {
    const brokenStore = eventStore();
    brokenStore[method] = () => { throw new Error('store-secret'); };
    assert.equal(await new Notifier({ ...options, store: brokenStore }).send('test message'), false);
  }
  assert.equal(await new Notifier({ ...options, store }).send('test message', null), false);
});

test('HTTP and acknowledgement failures remain nonthrowing when the event store fails', async (t) => {
  let status = 400;
  const url = await webhook(t, (_req, res) => {
    res.statusCode = status;
    res.end('{"errcode":1}');
  });
  const store = {
    getSetting() { throw new Error('broken store'); },
    setSetting() { throw new Error('broken store'); },
    log() { throw new Error('broken store'); },
  };
  const notifier = new Notifier({ url, format: 'wecom', store });
  assert.equal(await notifier.send('test message'), false);
  status = 200;
  assert.equal(await notifier.send('test message'), false);
});

test('logging recovery and delivery recovery do not permanently suppress identical failures', async (t) => {
  let accepted = false;
  const url = await webhook(t, (_req, res) => res.end(JSON.stringify({ errcode: accepted ? 0 : 1 })));
  const store = eventStore();
  const notifier = new Notifier({ url, format: 'wecom', store });
  const originalLog = store.log;
  store.log = () => { throw new Error('temporarily unavailable'); };
  assert.equal(await notifier.send('test message'), false);
  assert.equal(store.settings.size, 0, 'do not remember an error that could not be logged');

  store.log = originalLog;
  assert.equal(await notifier.send('test message'), false);
  assert.equal(store.events.length, 1);
  assert.equal(await notifier.send('test message'), false);
  assert.equal(store.events.length, 1, 'consecutive identical failures stay throttled');
  accepted = true;
  assert.equal(await notifier.send('test message'), true);
  assert.equal(store.settings.get('notify_error_last'), '');
  accepted = false;
  assert.equal(await notifier.send('test message'), false);
  assert.equal(store.events.length, 2, 'the same error is logged again after successful delivery');
});

test('success still returns true when clearing the previous error setting fails', async (t) => {
  const url = await webhook(t, (_req, res) => res.end('{"code":0}'));
  const store = { setSetting() { throw new Error('broken store'); } };
  assert.equal(await new Notifier({ url, format: 'feishu', store }).send('test message'), true);
});

test('disabled notifications do not attempt any HTTP request or event logging', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
  const store = eventStore();
  assert.equal(await new Notifier({ url: '', store }).send('test message'), false);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.equal(store.events.length, 0);
});

test('provider-level rejection cannot change a financial outcome or retry an ambiguous credit', async (t) => {
  const oldEnabled = config.monitor.autoTopUpEnabled;
  config.monitor.autoTopUpEnabled = true;
  t.after(() => { config.monitor.autoTopUpEnabled = oldEnabled; });
  for (const outcome of ['success', 'unknown']) {
    await t.test(outcome, async (t) => {
      let deliveries = 0;
      const url = await webhook(t, (_req, res) => {
        deliveries += 1;
        res.setHeader('content-type', 'application/json');
        res.end('{"code":19021,"msg":"synthetic rejection"}');
      });
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-notify-money-'));
      const db = openDb(path.join(directory, 'ledger.db'));
      const instance = { baseUrl: 'https://notify-money.fixture.invalid' };
      const store = createStore(db, { instance });
      let writes = 0;
      let balance = 5;
      const client = { ...instance,
        async getUser(id) { return { id, balance }; },
        async addBalance(id, amount) {
          writes += 1;
          balance += amount;
          if (outcome === 'unknown') throw new Sub2ApiError('synthetic response lost', { kind: 'unknown' });
          return { status: 200, replay: false, data: { id, balance } };
        },
      };
      const monitor = new Monitor({ store, client, notifier: new Notifier({ store, url, format: 'feishu' }) });
      monitor.notifierFor = () => true;
      t.after(async () => {
        await monitor.stop();
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
      });
      store.upsertUser({ userId: 1, threshold: 20, amount: 10 });
      const result = await monitor.performTopUp({ userId: 1, threshold: 20, amount: 10, source: 'manual' });
      await monitor.waitForIdle();
      assert.equal(result.ok, outcome === 'success');
      assert.equal(store.lastTopupForUser(1).status, outcome);
      assert.equal(store.countTopupRecords(), 1);
      assert.equal(deliveries, 1, 'the provider rejection was actually received');
      assert.equal(store.recentEvents().filter((event) => event.kind === 'notify_failed').length, 1);
      assert.equal(writes, 1);
      if (outcome === 'unknown') {
        const blocked = await monitor.performTopUp({ userId: 1, threshold: 20, amount: 10, source: 'manual' });
        await monitor.waitForIdle();
        assert.equal(blocked.attempted, false);
        assert.equal(writes, 1, 'notification failure must never trigger a credit retry');
        assert.equal(store.lastTopupForUser(1).status, 'unknown');
        assert.equal(store.countTopupRecords(), 1);
      }
    });
  }
});
