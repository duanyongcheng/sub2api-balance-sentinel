/** Stop admission and finish admitted requests before closing the ledger. */
export async function drainServer({ server, monitor, closeDatabase, timeoutMs }) {
  const httpDrained = new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
  });
  const monitorDrained = monitor.stop();
  let timer;
  try {
    await Promise.race([
      Promise.all([httpDrained, monitorDrained]),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          server.closeAllConnections();
          reject(new Error('shutdown deadline exceeded; unresolved ledger entries must be verified before retrying'));
        }, timeoutMs);
      }),
    ]);
    closeDatabase();
  } finally {
    clearTimeout(timer);
  }
}
