import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const createPool = (overrides = {}) => {
    if (!config.databaseUrl && !overrides.connectionString) {
        throw new Error('DATABASE_URL is required for durable shipment storage');
    }

    return new Pool({
        connectionString: config.databaseUrl,
        max: config.databasePoolMax,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        ...(config.databaseSsl ? { ssl: { rejectUnauthorized: config.databaseSslRejectUnauthorized } } : {}),
        ...overrides
    });
};

export const attachPoolErrorLogging = (pool) => {
    pool.on('error', (error) => {
        console.error('[database] Unexpected idle client error:', error);
    });
};

export const assertDatabaseReady = async (pool) => {
    await pool.query('SELECT 1');
    await pool.query('SELECT 1 FROM shipment_batches LIMIT 1');
    await pool.query('SELECT 1 FROM shipment_jobs LIMIT 1');
};
