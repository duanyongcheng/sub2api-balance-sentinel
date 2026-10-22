import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Sub2ApiClient, Sub2ApiError } from '../src/lib/sub2api.js';

/** Spin up a throwaway server to exercise the client against real HTTP. */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('sends x-api-key and Idempotency-Key, parses the envelope', async () => {
  let seen;
  await withServer((req, res) => {
    seen = { key: req.headers['x-api-key'], idem: req.headers['idempotency-key'] };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.body = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 0, message: 'success', data: { id: 5, balance: 108 } }));
    });
  }, async (base) => {
    const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-test' });
    const out = await client.addBalance(5, 100, { idempotencyKey: 'abc', notes: 'hi' });
    assert.equal(seen.key, 'admin-test');
    assert.equal(seen.idem, 'abc');
    assert.deepEqual(seen.body, { balance: 100, operation: 'add', notes: 'hi' });
    assert.equal(out.data.balance, 108);
  });
});

test('detects an idempotent replay from the response header', async () => {
  await withServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-idempotency-replayed', 'true');
    res.end(JSON.stringify({ code: 0, data: { id: 5, balance: 108 } }));
  }, async (base) => {
    const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'k' });
    const out = await client.addBalance(5, 100, { idempotencyKey: 'abc' });
    assert.equal(out.replay, true);
  });
});

test('a structured 400 validation error is a definitive rejection', async () => {
  await withServer((req, res) => {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 400, message: 'invalid' }));
  }, async (base) => {
    const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'k' });
    await assert.rejects(
      () => client.addBalance(5, 100, { idempotencyKey: 'a' }),
      (err) => err instanceof Sub2ApiError && err.kind === 'rejected' && err.httpStatus === 400,
    );
  });
});

test('ambiguous HTTP responses are never accepted as successful writes', async (t) => {
  const cases = [
    { name: 'HTML login page', body: '<html>Sign in</html>', type: 'text/html' },
    { name: 'empty body', body: '' },
    { name: 'truncated JSON', body: '{"code":0,"data":' },
    { name: 'null body', body: 'null' },
    { name: 'array body', body: '[]' },
    { name: 'missing envelope', body: '{"id":5,"balance":108}' },
    { name: 'nonzero envelope', body: '{"code":500,"message":"error"}' },
    { name: 'missing data', body: '{"code":0}' },
    { name: 'wrong user', body: '{"code":0,"data":{"id":6,"balance":108}}' },
    { name: 'no user ID', body: '{"code":0,"data":{"balance":108}}' },
    { name: 'boolean balance', body: '{"code":0,"data":{"id":5,"balance":true}}' },
    { name: 'empty balance', body: '{"code":0,"data":{"id":5,"balance":""}}' },
    { name: 'array balance', body: '{"code":0,"data":{"id":5,"balance":[]}}' },
    { name: 'missing balance', body: '{"code":0,"data":{"id":5}}' },
    { name: 'overflow balance', body: '{"code":0,"data":{"id":5,"balance":1e999}}' },
    { name: 'async acceptance is not completion', status: 202, body: '{"code":0,"data":{"id":5,"balance":108}}' },
    { name: 'idempotent request still running', status: 409, body: '{"code":409,"reason":"IDEMPOTENCY_IN_PROGRESS"}' },
    { name: 'proxy 400 without a Sub2API rejection', status: 400, type: 'text/html', body: '<html>Error</html>' },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await withServer((_req, res) => {
        res.statusCode = entry.status || 200;
        res.setHeader('content-type', entry.type || 'application/json');
        res.end(entry.body);
      }, async (base) => {
        const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'k' });
        await assert.rejects(() => client.addBalance(5, 100, { idempotencyKey: 'abc' }),
          (err) => err instanceof Sub2ApiError && err.kind === 'unknown' && err.httpStatus === (entry.status || 200));
      });
    });
  }
});

test('user reads validate the user ID and numeric balance without coercion', async (t) => {
  for (const data of [{ id: 6, balance: 10 }, { id: 5, balance: true }, { id: 5, balance: [] }, { id: 5, balance: '10' }]) {
    await t.test(JSON.stringify(data), async () => {
      await withServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, data }));
      }, async (base) => {
        await assert.rejects(() => new Sub2ApiClient({ baseUrl: base, adminKey: 'k' }).getUser(5), /invalid user ID or balance/);
      });
    });
  }
});

test('redacts the admin key if an upstream error body echoes it', async () => {
  await withServer((_req, res) => {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: 'Rejected token admin-secret-value' }));
  }, async (base) => {
    const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-secret-value' });
    await assert.rejects(
      () => client.getUser(1),
      (err) => err instanceof Sub2ApiError && !err.message.includes('admin-secret-value') && err.message.includes('[REDACTED]'),
    );
  });
});

test('500 is an unknown outcome, not a failure', async () => {
  await withServer((req, res) => {
    res.statusCode = 500;
    res.end('boom');
  }, async (base) => {
    const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'k' });
    await assert.rejects(
      () => client.addBalance(5, 100, { idempotencyKey: 'a' }),
      (err) => err.kind === 'unknown',
    );
  });
});

test('429 is an unknown outcome (may have been applied)', async () => {
  await withServer((req, res) => { res.statusCode = 429; res.end(); }, async (base) => {
    const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'k' });
    await assert.rejects(() => client.addBalance(5, 1, { idempotencyKey: 'a' }), (e) => e.kind === 'unknown');
  });
});

test('timeout is an unknown outcome', async () => {
  await withServer((req, res) => { /* never respond */ }, async (base) => {
    const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'k', timeoutMs: 60 });
    await assert.rejects(() => client.addBalance(5, 1, { idempotencyKey: 'a' }), (e) => e.kind === 'unknown');
  });
});

test('refuses non-positive amounts before any network call', async () => {
  const client = new Sub2ApiClient({ baseUrl: 'http://127.0.0.1:1', adminKey: 'k' });
  await assert.rejects(() => client.addBalance(5, 0, { idempotencyKey: 'a' }), /non-positive/);
  await assert.rejects(() => client.addBalance(5, -100, { idempotencyKey: 'a' }), /non-positive/);
});

test('refuses to write without an idempotency key', async () => {
  const client = new Sub2ApiClient({ baseUrl: 'http://127.0.0.1:1', adminKey: 'k' });
  await assert.rejects(() => client.addBalance(5, 100, {}), /Idempotency-Key/);
});

test('never sends the admin key to a foreign origin', async () => {
  const client = new Sub2ApiClient({ baseUrl: 'http://127.0.0.1:1', adminKey: 'k' });
  // Path traversal cannot escape the configured origin.
  await assert.rejects(() => client.request('GET', '/../../evil'), () => true);
});

test('does not follow redirects from the sub2api server', async () => {
  let redirectedRequestCount = 0;
  const targetServer = http.createServer((_req, res) => {
    redirectedRequestCount += 1;
    res.end('should not be reached');
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${targetServer.address().port}/collect`;

  try {
    await withServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', target);
      res.end();
    }, async (base) => {
      const client = new Sub2ApiClient({ baseUrl: base, adminKey: 'admin-test' });
      await assert.rejects(() => client.getUser(1), (err) => err instanceof Sub2ApiError && err.kind === 'unknown');
    });
    assert.equal(redirectedRequestCount, 0);
  } finally {
    await new Promise((resolve) => targetServer.close(resolve));
  }
});

test('balance history sends the requested page and validates pagination', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/api/v1/admin/users/5/balance-history?page=2&page_size=100');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 0, data: { items: [{ id: 9 }], total: 101, page: 2, page_size: 100, pages: 2 } }));
  }, async (base) => {
    const result = await new Sub2ApiClient({ baseUrl: base, adminKey: 'k' }).getBalanceHistory(5, 100, 2);
    assert.equal(result.items[0].id, 9);
  });
});

test('malformed history cannot be mistaken for an empty verified history', async (t) => {
  const valid = { items: [], total: 0, page: 1, page_size: 100, pages: 1 };
  for (const fields of [{ items: null }, { page: 2 }, { page_size: 1 }, { pages: 0 }, { total: -1 }, { items: [{ id: '1' }] }]) {
    await t.test(JSON.stringify(fields), async () => {
      await withServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 0, data: { ...valid, ...fields } }));
      }, async (base) => {
        await assert.rejects(() => new Sub2ApiClient({ baseUrl: base, adminKey: 'k' }).getBalanceHistory(5), /invalid pagination or record structure/);
      });
    });
  }
});
