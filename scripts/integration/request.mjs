import assert from 'node:assert/strict';

// Bootstrap transport for a newly created fixture, run in its network namespace.
// Credentials enter through stdin, never argv, environment variables or logs.
try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { baseUrl = 'http://127.0.0.1:8080', route, body, bearer } = JSON.parse(input);
  const url = new URL(baseUrl);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/');
  assert.equal(url.username + url.password + url.search + url.hash, '');
  assert.ok(['/api/v1/auth/login', '/api/v1/admin/users',
    '/api/v1/admin/settings/admin-api-key/regenerate'].includes(route));
  const response = await fetch(url.origin + route, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
} catch {
  process.stderr.write('Isolated bootstrap request failed; response withheld\n');
  process.exitCode = 1;
}
