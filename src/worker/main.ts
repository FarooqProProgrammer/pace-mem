import { rmSync, writeFileSync } from 'node:fs';
import { loadSettings, paths } from '../shared/config.js';
import { Store } from '../db/store.js';
import { Processor } from './processor.js';
import { createWorkerServer, VERSION } from './server.js';
import { log } from './log.js';
import type { Llm } from './llm.js';

const settings = loadSettings();
const store = new Store(paths.db());
const llm: Llm = { generate: async () => { throw new Error('model compression is disabled'); } };
const processor = new Processor(store, llm, settings);
const server = createWorkerServer(store, processor, settings);

server.on('error', (err: NodeJS.ErrnoException) => {
  // Another worker already owns the port: that one serves everyone, so exit quietly.
  log(err.code === 'EADDRINUSE' ? `port ${settings.port} in use; exiting` : `server error: ${err.message}`);
  process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
});

server.listen(settings.port, '127.0.0.1', () => {
  writeFileSync(paths.pid(), String(process.pid));
  log(`pace-mem worker ${VERSION} listening on 127.0.0.1:${settings.port}`);
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  log('worker shutting down');
  server.closeAllConnections();
  server.close(() => {
    store.close();
    rmSync(paths.pid(), { force: true });
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err}`));
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${(err as Error)?.stack ?? err}`));
