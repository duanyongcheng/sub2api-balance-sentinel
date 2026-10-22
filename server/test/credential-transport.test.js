import test from 'node:test';
import assert from 'node:assert/strict';
import { withCredentialTransport } from '../../shared/credential-transport.js';

test('credentials are not dispatched from non-loopback plaintext pages', () => {
  for (const hostname of ['sentinel.example.com', '10.0.0.5', 'localhost.evil.invalid', '127.0.0.1.evil.invalid', '127.999.0.1', '0.0.0.0']) {
    let sent = false;
    assert.throws(() => withCredentialTransport({ protocol: 'http:', hostname }, () => { sent = true; }), /Use HTTPS/);
    assert.equal(sent, false);
  }
});

test('HTTPS and genuine local loopback pages may submit credentials', () => {
  for (const [protocol, hostname] of [['https:', 'sentinel.example.com'], ['http:', 'localhost'], ['http:', '127.0.0.1'], ['http:', '127.1.2.3'], ['http:', '[::1]']]) {
    assert.equal(withCredentialTransport({ protocol, hostname }, () => 'sent'), 'sent');
  }
});
