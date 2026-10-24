import http from 'node:http';
import { config, assertConfigured } from './config.js';
import { openDb, createStore } from './db/store.js';
import { Monitor } from './lib/monitor.js';
import { Sub2ApiClient } from './lib/sub2api.js';
import { Notifier } from './lib/notify.js';
import { createApp } from './app.js';
import { drainServer } from './lib/shutdown.js';

console.log('[boot] sub2api-balance-sentinel');
console.log(`[boot] listen: http://${config.server.host}:${config.server.port}`);
console.log(`[boot] auto top-up: ${config.monitor.autoTopUpEnabled ? 'ENABLED' : 'DISABLED'}`);

try {
  assertConfigured();
} catch (err) {
  console.error(`\n${err.message}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

console.log(`[boot] target origin: ${new URL(config.baseUrl).origin}`);

const db = openDb(config.dbPath);
const client = new Sub2ApiClient();
const store = createStore(db, { instance: client });
const binding = store.instanceBindingStatus(client);
if (!binding.ok) console.warn(`[boot] upstream operations BLOCKED: ${binding.reason}`);
const notifier = new Notifier({ store });
const monitor = new Monitor({ store, client, notifier });

if (notifier.enabled) {
  console.log(`[boot] notifications: ${config.notify.format} -> ${new URL(config.notify.url).host}`);
} else {
  console.log('[boot] notifications: disabled (set NOTIFY_WEBHOOK_URL to enable)');
}

if (config.server.host === '0.0.0.0' || config.server.host === '::') {
  // Expected inside a container: the port mapping is what limits exposure.
  console.warn(
    `[boot] binding to ${config.server.host} (all interfaces). Inside Docker this is normal; ` +
    'make sure the published port is bound to the host loopback (127.0.0.1) or protected by an authenticated reverse proxy.',
  );
} else if (config.server.host !== '127.0.0.1' && config.server.host !== 'localhost') {
  console.warn(
    `[boot] WARNING: binding to ${config.server.host}. This process holds a full-admin sub2api key; ` +
    'keep this privileged dashboard behind HTTPS and network access controls, in addition to its own authentication.',
  );
}

if (!config.auth.secureCookies && config.server.host !== '127.0.0.1' && config.server.host !== 'localhost') {
  console.warn('[boot] WARNING: enable AUTH_SECURE_COOKIES=true when TLS terminates at the reverse proxy.');
}

const app = createApp({ store, monitor, client, notifier });
const server = http.createServer(app);

server.listen(config.server.port, config.server.host, () => {
  monitor.start();
});

let shutdownPromise;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shutdownPromise) return;
    console.log(`\n[boot] ${sig} received, shutting down`);
    shutdownPromise = drainServer({
      server, monitor, closeDatabase: () => db.close(),
      timeoutMs: Math.max(30_000, config.requestTimeoutMs * 2 + 15_000),
    }).then(() => process.exit(0)).catch((err) => {
      console.error('[boot]', client.redact(err.message));
      // Do not close a ledger that still has asynchronous writers. Persisted
      // pending reservations remain fail-closed after a forced process exit.
      process.exit(1);
    });
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandled rejection:', err);
});
