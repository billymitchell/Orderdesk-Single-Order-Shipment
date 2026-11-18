// One-off retention purge, for Heroku Scheduler:
//   heroku addons:create scheduler:standard
//   job: node scripts/purge.js   (daily)
import 'dotenv/config';
import { createPool } from '../db.js';
import { purge } from '../lib/retention.js';

const pool = createPool();
try {
    console.info(JSON.stringify({ message: 'retention.purge', ...(await purge(pool)) }));
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await pool.end();
}
