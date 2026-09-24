import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { createPool } from '../db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, '../migrations');
const pool = createPool();
const client = await pool.connect();

try {
    // Serialize migrations when multiple deployment instances start together.
    await client.query('SELECT pg_advisory_lock(721947, 1)');
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    const files = (await fs.readdir(migrationsDirectory))
        .filter((filename) => filename.endsWith('.sql'))
        .sort();

    for (const filename of files) {
        const alreadyApplied = await client.query(
            'SELECT 1 FROM schema_migrations WHERE filename = $1',
            [filename]
        );
        if (alreadyApplied.rowCount > 0) continue;

        const sql = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
            await client.query('COMMIT');
            console.info(`[migrate] Applied ${filename}`);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    }
} finally {
    await client.query('SELECT pg_advisory_unlock(721947, 1)').catch(() => {});
    client.release();
    await pool.end();
}
