// Deletes request logs older than LOG_RETENTION_DAYS (default 90) and expired
// dashboard sessions. Shipment batches and jobs are never touched.
const DAY_MS = 24 * 60 * 60 * 1000;

export const retentionDays = (env = process.env) => {
    const days = Number(env.LOG_RETENTION_DAYS || 90);
    return Number.isFinite(days) && days >= 1 ? Math.floor(days) : 90;
};

export const purge = async (pool) => {
    const days = retentionDays();
    const logs = await pool.query(
        'DELETE FROM request_logs WHERE created_at < now() - make_interval(days => $1)',
        [days]
    );
    const sessions = await pool.query('DELETE FROM auth_sessions WHERE expires_at < now()');
    return { days, logsDeleted: logs.rowCount, sessionsDeleted: sessions.rowCount };
};

// Purge shortly after boot and then once a day. On an Eco dyno the timer stops
// while the dyno sleeps, so the boot-time run (plus Heroku Scheduler running
// scripts/purge.js, if you add it) keeps the window enforced.
export const schedulePurge = (pool) => {
    const run = () => purge(pool)
        .then((result) => console.info('[retention] Purged request logs:', result))
        .catch((error) => console.error('[retention] Purge failed:', error.message));
    const first = setTimeout(run, 15 * 1000);
    const daily = setInterval(run, DAY_MS);
    first.unref();
    daily.unref();
    return { first, daily };
};
