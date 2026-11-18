// Request log: one row per HTTP exchange in either direction.
//   inbound  - a caller hitting this API (request + our response)
//   outbound - this service calling Order Desk (request + Order Desk's response)
//
// Rule: logging must never block or break shipment processing. Rows are written
// without await and every database error is swallowed (and reported once to
// the console).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { resolveStoreId } from '../stores.js';

let pool = null;
let reportError = (error) => {
    console.error('[request-log] Failed to save log row:', error.message);
};

// Called once at boot. Without a pool (tests, scripts) logging is a no-op.
export const configureRequestLog = ({ pool: nextPool, onError } = {}) => {
    pool = nextPool || null;
    if (onError) reportError = onError;
};

export const isRequestLogEnabled = () => Boolean(pool);

// The worker runs each Order Desk call inside a context naming the jobs it
// serves, so outbound rows can be linked back to batches and tracking numbers.
const logContext = new AsyncLocalStorage();
export const withLogContext = (context, fn) => logContext.run(context, fn);
export const currentLogContext = () => logContext.getStore() || null;

// Only these inbound headers are stored. Credentials are never in this list.
export const INBOUND_HEADER_ALLOWLIST = [
    'content-type',
    'content-length',
    'user-agent',
    'idempotency-key',
    'x-forwarded-for',
    'x-request-id'
];

const SECRET_HEADER_PATTERN = /^(x-api-key|x-admin-api-key|authorization|cookie|proxy-authorization|orderdesk-api-key)$/i;

export const sanitizeInboundHeaders = (headers = {}) => {
    const result = {};
    for (const name of INBOUND_HEADER_ALLOWLIST) {
        if (headers[name] !== undefined) result[name] = headers[name];
    }
    return result;
};

export const redactHeaders = (headers = {}) => Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, SECRET_HEADER_PATTERN.test(name) ? '[redacted]' : value])
);

export const uniqueStrings = (values) => [...new Set(
    values
        .filter((value) => value !== null && value !== undefined && value !== '')
        .map((value) => String(value).trim())
        .filter(Boolean)
)];

// Pull searchable identifiers out of anything shaped like a shipment, or a
// list of them (inbound submissions, worker payloads, Order Desk bodies).
export const describeShipments = (value) => {
    const list = (Array.isArray(value) ? value : [value]).filter((item) => item && typeof item === 'object');
    return {
        storeIds: uniqueStrings(list.map((item) => {
            try { return resolveStoreId(item); } catch { return null; }
        })),
        trackingNumbers: uniqueStrings(list.map((item) => item.tracking_number)),
        orderNumbers: uniqueStrings(list.flatMap((item) => [item.source_id, item.order_id])),
        count: list.length
    };
};

// Context for one or more shipment jobs claimed by the worker.
export const logContextForJobs = (jobs) => {
    const described = describeShipments(jobs.map((job) => job.payload || {}));
    return {
        jobIds: uniqueStrings(jobs.map((job) => job.id)),
        batchIds: uniqueStrings(jobs.map((job) => job.batch_id)),
        storeIds: uniqueStrings([...jobs.map((job) => job.store_id), ...described.storeIds]),
        trackingNumbers: described.trackingNumbers,
        orderNumbers: uniqueStrings([
            ...described.orderNumbers,
            ...jobs.flatMap((job) => [job.source_id, job.order_id])
        ])
    };
};

const UUID_IN_PATH = /\/(?:batches|shipments)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export const inboundOutcome = (status) => {
    if (status >= 200 && status < 300) return 'success';
    if (status === 400 || status === 413) return 'validation_error';
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 404) return 'not_found';
    if (status === 409) return 'conflict';
    return 'error';
};

export const buildSearchText = (record) => uniqueStrings([
    record.id,
    record.url,
    record.idempotency_key,
    record.error_message,
    record.error_code,
    ...(record.store_ids || []),
    ...(record.batch_ids || []),
    ...(record.job_ids || []),
    ...(record.tracking_numbers || []),
    ...(record.order_numbers || [])
]).join(' ').toLowerCase();

// Stored as json (not jsonb) so key order matches what was actually sent.
// \u0000 escapes are stripped so rows stay convertible to jsonb.
const toJson = (value) => {
    if (value === undefined || value === null) return null;
    try {
        return JSON.stringify(value).replace(/\\u0000/g, '');
    } catch {
        return JSON.stringify({ unserializable: String(value) });
    }
};

const INSERT_SQL = `INSERT INTO request_logs (
    id, direction, outcome, method, url, status, duration_ms, inbound_auth, idempotency_key,
    request_headers, request_body, response_body, error_message, error_code, tokens_remaining,
    store_ids, batch_ids, job_ids, tracking_numbers, order_numbers, shipment_count, search_text
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
ON CONFLICT (id) DO NOTHING`;

export const rowFromRecord = (record) => [
    record.id,
    record.direction,
    record.outcome,
    record.method,
    String(record.url || '').slice(0, 2000),
    record.status ?? null,
    record.duration_ms ?? null,
    record.inbound_auth ?? null,
    record.idempotency_key ?? null,
    toJson(record.request_headers),
    toJson(record.request_body),
    toJson(record.response_body),
    record.error_message ? String(record.error_message).slice(0, 2000) : null,
    record.error_code ?? null,
    Number.isFinite(record.tokens_remaining) ? record.tokens_remaining : null,
    uniqueStrings(record.store_ids || []),
    uniqueStrings(record.batch_ids || []),
    uniqueStrings(record.job_ids || []),
    uniqueStrings(record.tracking_numbers || []),
    uniqueStrings(record.order_numbers || []),
    record.shipment_count ?? null,
    buildSearchText(record)
];

export const saveLog = async (record) => {
    if (!pool || !record) return false;
    try {
        await pool.query(INSERT_SQL, rowFromRecord({ id: randomUUID(), ...record }));
        return true;
    } catch (error) {
        reportError(error);
        return false;
    }
};

// Fire and forget.
export const recordLog = (record) => {
    saveLog(record).catch(() => {});
};

// Express middleware for the public API. Mount it before inbound auth so
// rejected calls are logged too, and after /health so probes are not.
export const inboundRequestLogger = () => (req, res, next) => {
    if (!pool) return next();
    const id = randomUUID();
    const started = Date.now();
    res.set('X-Request-Id', id);

    let responseBody;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        responseBody = body;
        return originalJson(body);
    };

    res.on('finish', () => {
        const requestBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length
            ? req.body
            : (Array.isArray(req.body) ? req.body : null);
        const fromRequest = requestBody ? describeShipments(requestBody) : null;
        const fromResponse = Array.isArray(responseBody?.shipments)
            ? describeShipments(responseBody.shipments.map((row) => ({ ...(row.payload || {}), ...row })))
            : null;
        const pathId = req.originalUrl.match(UUID_IN_PATH)?.[1];
        const isJobPath = /\/shipments\//i.test(req.originalUrl);
        const status = res.statusCode;

        recordLog({
            id,
            direction: 'inbound',
            outcome: inboundOutcome(status),
            method: req.method,
            url: req.originalUrl,
            status,
            duration_ms: Date.now() - started,
            inbound_auth: res.locals.inboundAuth || null,
            idempotency_key: req.get('Idempotency-Key') || null,
            request_headers: sanitizeInboundHeaders(req.headers),
            request_body: requestBody,
            response_body: responseBody ?? null,
            error_message: status >= 400 ? (responseBody?.message || null) : null,
            store_ids: [...(fromRequest?.storeIds || []), ...(fromResponse?.storeIds || [])],
            batch_ids: [responseBody?.batch_id, !isJobPath ? pathId : null],
            job_ids: [responseBody?.job_id, isJobPath ? pathId : null],
            tracking_numbers: [...(fromRequest?.trackingNumbers || []), ...(fromResponse?.trackingNumbers || [])],
            order_numbers: [...(fromRequest?.orderNumbers || []), ...(fromResponse?.orderNumbers || [])],
            shipment_count: responseBody?.shipment_count ?? fromRequest?.count ?? null
        });
    });

    return next();
};
