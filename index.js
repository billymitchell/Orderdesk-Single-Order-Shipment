import 'dotenv/config';
import { config, validateRuntimeConfig } from './config.js';
import { createPool, assertDatabaseReady, attachPoolErrorLogging } from './db.js';
import { ShipmentQueue } from './queue.js';
import { createShipmentWorker } from './worker.js';
import { createApp } from './app.js';

validateRuntimeConfig();
const pool = createPool();
attachPoolErrorLogging(pool);
await assertDatabaseReady(pool);

const queue = new ShipmentQueue(pool);
const worker = createShipmentWorker({ queue });
const app = createApp({ queue, pool, worker });
const server = app.listen(config.port, () => {
    console.info(`[Server] Running on port ${config.port} with durable PostgreSQL queueing.`);
});

worker.start();

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[Server] ${signal} received; stopping worker and HTTP server.`);
    await new Promise((resolve) => server.close(resolve));
    await worker.stop();
    await pool.end();
    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
    console.error('[Server] Shutdown failed:', error);
    process.exit(1);
}));
process.on('SIGINT', () => shutdown('SIGINT').catch((error) => {
    console.error('[Server] Shutdown failed:', error);
    process.exit(1);
}));
