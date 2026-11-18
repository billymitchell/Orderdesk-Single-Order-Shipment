// Read-only JSON API behind the dashboard. User input never reaches SQL text:
// sort columns go through an allowlist and every value is a bind parameter.
import express from 'express';
import { retentionDays } from '../lib/retention.js';
import { stores } from '../stores.js';

export const DIRECTIONS = ['inbound', 'outbound'];
export const OUTCOMES = [
    'success', 'partial_failure', 'validation_error', 'unauthorized', 'not_found',
    'conflict', 'error', 'downstream_error', 'network_error'
];
const AUTH_RESULTS = ['ok', 'missing', 'invalid', 'not_required'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SORTABLE = {
    created_at: 'created_at',
    direction: 'direction',
    outcome: 'outcome',
    status: 'status',
    duration_ms: 'duration_ms',
    shipment_count: 'shipment_count'
};
const LIST_COLUMNS = `id, created_at, direction, outcome, method, url, status, duration_ms, inbound_auth,
    shipment_count, store_ids, batch_ids, tracking_numbers, order_numbers, error_message, tokens_remaining`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseDate = (value) => {
    if (!value) return null;
    const time = Date.parse(String(value));
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const escapeLike = (value) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

// Builds the WHERE clause shared by the list, counts, and CSV export.
export function buildFilters(query, { includeOutcome = true } = {}) {
    const clauses = [];
    const params = [];
    const add = (sql, ...values) => {
        let text = sql;
        for (const value of values) {
            params.push(value);
            text = text.replace('?', `$${params.length}`);
        }
        clauses.push(text);
    };

    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (from) add('created_at >= ?', from);
    if (to) add('created_at <= ?', to);

    if (DIRECTIONS.includes(query.direction)) add('direction = ?', query.direction);
    if (includeOutcome && OUTCOMES.includes(query.outcome)) add('outcome = ?', query.outcome);
    if (AUTH_RESULTS.includes(query.auth)) add('inbound_auth = ?', query.auth);
    if (METHODS.includes(String(query.method || '').toUpperCase())) add('method = ?', String(query.method).toUpperCase());

    const store = String(query.store || '').trim();
    if (/^\d{1,12}$/.test(store)) add('? = ANY(store_ids)', store);

    const batch = String(query.batch || '').trim();
    if (UUID_PATTERN.test(batch)) add('? = ANY(batch_ids)', batch.toLowerCase());

    const status = String(query.status || '');
    if (/^[1-5]xx$/.test(status)) {
        const base = Number(status[0]) * 100;
        add('status >= ? AND status < ?', base, base + 100);
    } else if (/^\d{3}$/.test(status)) {
        add('status = ?', Number(status));
    }

    const q = String(query.q || '').trim().toLowerCase().slice(0, 200);
    if (q) {
        // Every word must appear somewhere in the searchable identifiers.
        for (const word of q.split(/\s+/).slice(0, 8)) {
            add("search_text ILIKE ? ESCAPE '\\'", `%${escapeLike(word)}%`);
        }
    }

    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function buildOrder(query) {
    const column = SORTABLE[query.sort] || 'created_at';
    const direction = String(query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    return `ORDER BY ${column} ${direction} NULLS LAST, id ${direction}`;
}

export function csvCell(value) {
    if (value === null || value === undefined) return '';
    let text = Array.isArray(value) ? value.join(' ') : String(value instanceof Date ? value.toISOString() : value);
    // Keep spreadsheet apps from treating a cell as a formula.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createApi({ pool }) {
    const router = express.Router();

    router.get('/me', (req, res) => {
        res.json({
            email: req.user.email,
            retention_days: retentionDays(),
            stores: stores.map((store) => ({ id: store.STORE_ID, name: store.STORE_NAME }))
        });
    });

    router.get('/logs', async (req, res, next) => {
        try {
            const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 200);
            const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
            const filters = buildFilters(req.query);
            const countFilters = buildFilters(req.query, { includeOutcome: false });

            const [list, total, counts] = await Promise.all([
                pool.query(
                    `SELECT ${LIST_COLUMNS} FROM request_logs ${filters.where} ${buildOrder(req.query)}
                     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
                    filters.params
                ),
                pool.query(`SELECT count(*)::int AS total FROM request_logs ${filters.where}`, filters.params),
                pool.query(
                    `SELECT outcome, count(*)::int AS count FROM request_logs ${countFilters.where} GROUP BY outcome`,
                    countFilters.params
                )
            ]);

            res.json({
                rows: list.rows,
                total: total.rows[0].total,
                page,
                pageSize,
                counts: Object.fromEntries(counts.rows.map((row) => [row.outcome, row.count]))
            });
        } catch (error) {
            next(error);
        }
    });

    router.get('/logs/export.csv', async (req, res, next) => {
        try {
            const filters = buildFilters(req.query);
            const { rows } = await pool.query(
                `SELECT ${LIST_COLUMNS} FROM request_logs ${filters.where} ${buildOrder(req.query)} LIMIT 10000`,
                filters.params
            );
            const headers = ['id', 'created_at', 'direction', 'outcome', 'method', 'url', 'status', 'duration_ms',
                'inbound_auth', 'shipment_count', 'store_ids', 'batch_ids', 'tracking_numbers', 'order_numbers',
                'tokens_remaining', 'error_message'];
            const lines = [headers.join(',')].concat(
                rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))
            );
            const stamp = new Date().toISOString().slice(0, 10);
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="orderdesk-request-logs-${stamp}.csv"`);
            res.send(`${lines.join('\r\n')}\r\n`);
        } catch (error) {
            next(error);
        }
    });

    router.get('/logs/:id', async (req, res, next) => {
        try {
            if (!UUID_PATTERN.test(req.params.id)) {
                return res.status(404).json({ success: false, message: 'Not found.' });
            }
            const { rows } = await pool.query('SELECT * FROM request_logs WHERE id = $1', [req.params.id]);
            const row = rows[0];
            if (!row) return res.status(404).json({ success: false, message: 'Not found.' });
            delete row.search_text;

            // Other exchanges for the same batches: the inbound submission and
            // every Order Desk call made for it.
            let related = [];
            if (row.batch_ids.length) {
                const result = await pool.query(
                    `SELECT id, created_at, direction, outcome, method, url, status
                     FROM request_logs WHERE batch_ids && $1::text[] AND id <> $2
                     ORDER BY created_at ASC LIMIT 50`,
                    [row.batch_ids, row.id]
                );
                related = result.rows;
            }
            return res.json({ ...row, related });
        } catch (error) {
            return next(error);
        }
    });

    // API errors stay JSON and never echo internals.
    router.use((error, req, res, next) => {
        console.error('[admin] API error:', error.message);
        res.status(500).json({ success: false, message: 'Something went wrong loading logs.' });
    });

    return router;
}
