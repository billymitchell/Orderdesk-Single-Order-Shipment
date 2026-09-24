import { createHash, randomUUID } from 'node:crypto';
import { resolveStoreId } from './stores.js';

export class QueueConflictError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'QueueConflictError';
        this.statusCode = 409;
        this.details = details;
    }
}

const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value)
            .sort()
            .reduce((result, key) => {
                result[key] = canonicalize(value[key]);
                return result;
            }, {});
    }
    return value;
};

export const stableStringify = (value) => JSON.stringify(canonicalize(value));

export const hashValue = (value) => createHash('sha256').update(stableStringify(value)).digest('hex');

export const normalizeShipment = (shipment) => ({
    ...shipment,
    ...(shipment.source_id !== undefined ? { source_id: String(shipment.source_id).trim() } : {}),
    ...(shipment.store_id !== undefined ? { store_id: String(shipment.store_id).trim() } : {}),
    ...(shipment.order_id !== undefined ? { order_id: String(shipment.order_id).trim() } : {}),
    ...(typeof shipment.tracking_number === 'string'
        ? { tracking_number: shipment.tracking_number.trim() }
        : {}),
    ...(typeof shipment.carrier_code === 'string'
        ? { carrier_code: shipment.carrier_code.trim().toLowerCase() }
        : {}),
    ...(typeof shipment.shipment_method === 'string'
        ? { shipment_method: shipment.shipment_method.trim() }
        : {})
});

export const deriveBatchStatus = ({ queued, processing, retrying, succeeded, failed, total }) => {
    if (succeeded + failed === total) return failed > 0 ? 'completed_with_errors' : 'completed';
    if (processing > 0 || retrying > 0 || succeeded > 0 || failed > 0) return 'processing';
    return queued > 0 ? 'queued' : 'processing';
};

const toCount = (value) => Number.parseInt(value, 10) || 0;

const summarizeBatchRow = (row) => {
    if (!row) return null;
    const counts = {
        total: toCount(row.total),
        queued: toCount(row.queued),
        processing: toCount(row.processing),
        retrying: toCount(row.retrying),
        succeeded: toCount(row.succeeded),
        failed: toCount(row.failed)
    };
    return {
        batch_id: row.id,
        status: deriveBatchStatus(counts),
        ...counts,
        created_at: row.created_at,
        updated_at: row.updated_at,
        completed_at: row.completed_at
    };
};

export class ShipmentQueue {
    constructor(pool) {
        this.pool = pool;
    }

    async enqueueBatch(rawShipments, rawIdempotencyKey = null) {
        const shipments = rawShipments.map(normalizeShipment);
        const requestHash = hashValue(shipments);
        const idempotencyKey = rawIdempotencyKey?.trim() || null;
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            if (idempotencyKey) {
                const existingKey = await client.query(
                    'SELECT id, request_hash, total_count, status FROM shipment_batches WHERE idempotency_key = $1',
                    [idempotencyKey]
                );
                if (existingKey.rowCount > 0) {
                    const existing = existingKey.rows[0];
                    if (existing.request_hash !== requestHash) {
                        throw new QueueConflictError('Idempotency-Key was already used with a different payload', {
                            batch_id: existing.id
                        });
                    }
                    await client.query('COMMIT');
                    return {
                        batchId: existing.id,
                        shipmentCount: existing.total_count,
                        status: existing.status,
                        replayed: true
                    };
                }
            }

            const existingRequest = await client.query(
                'SELECT id, total_count, status FROM shipment_batches WHERE request_hash = $1',
                [requestHash]
            );
            if (existingRequest.rowCount > 0) {
                const existing = existingRequest.rows[0];
                await client.query('COMMIT');
                return {
                    batchId: existing.id,
                    shipmentCount: existing.total_count,
                    status: existing.status,
                    replayed: true
                };
            }

            const batchId = randomUUID();
            await client.query(
                `INSERT INTO shipment_batches
                    (id, idempotency_key, request_hash, status, total_count)
                 VALUES ($1, $2, $3, 'queued', $4)`,
                [batchId, idempotencyKey, requestHash, shipments.length]
            );

            for (const [position, shipment] of shipments.entries()) {
                const storeId = resolveStoreId(shipment);
                await client.query(
                    `INSERT INTO shipment_jobs
                        (id, batch_id, position, fingerprint, payload, store_id, source_id, order_id)
                     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
                    [
                        randomUUID(),
                        batchId,
                        position,
                        hashValue(shipment),
                        JSON.stringify(shipment),
                        storeId,
                        shipment.source_id ?? null,
                        shipment.order_id ?? null
                    ]
                );
            }

            await client.query('COMMIT');
            return {
                batchId,
                shipmentCount: shipments.length,
                status: 'queued',
                replayed: false
            };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            if (error instanceof QueueConflictError) throw error;
            if (error.code === '23505') {
                const existing = await client.query(
                    `SELECT id, idempotency_key, request_hash, total_count, status
                     FROM shipment_batches
                     WHERE request_hash = $1
                        OR ($2::text IS NOT NULL AND idempotency_key = $2)
                     ORDER BY created_at
                     LIMIT 1`,
                    [requestHash, idempotencyKey]
                );
                if (existing.rowCount > 0) {
                    const batch = existing.rows[0];
                    if (batch.request_hash === requestHash) {
                        return {
                            batchId: batch.id,
                            shipmentCount: batch.total_count,
                            status: batch.status,
                            replayed: true
                        };
                    }
                    throw new QueueConflictError('Idempotency-Key was already used with a different payload', {
                        batch_id: batch.id
                    });
                }
                throw new QueueConflictError('One or more shipments have already been accepted', {
                    constraint: error.constraint
                });
            }
            throw error;
        } finally {
            client.release();
        }
    }

    async getBatch(batchId) {
        const result = await this.pool.query(
            `SELECT b.id, b.created_at, b.updated_at, b.completed_at,
                    COUNT(j.id)::int AS total,
                    COUNT(*) FILTER (WHERE j.status = 'queued')::int AS queued,
                    COUNT(*) FILTER (WHERE j.status = 'processing')::int AS processing,
                    COUNT(*) FILTER (WHERE j.status = 'retrying')::int AS retrying,
                    COUNT(*) FILTER (WHERE j.status = 'succeeded')::int AS succeeded,
                    COUNT(*) FILTER (WHERE j.status = 'failed')::int AS failed
             FROM shipment_batches b
             LEFT JOIN shipment_jobs j ON j.batch_id = b.id
             WHERE b.id = $1
             GROUP BY b.id`,
            [batchId]
        );
        return summarizeBatchRow(result.rows[0]);
    }

    async getBatchJobs(batchId, { limit = 100, offset = 0 } = {}) {
        const result = await this.pool.query(
            `SELECT id AS job_id, position, store_id, source_id, order_id,
                    payload->>'tracking_number' AS tracking_number,
                    payload->>'carrier_code' AS carrier_code,
                    status,
                    attempt_count, next_attempt_at, last_error, last_error_code,
                    remote_shipment_id, created_at, updated_at, completed_at
             FROM shipment_jobs
             WHERE batch_id = $1
             ORDER BY position
             LIMIT $2 OFFSET $3`,
            [batchId, limit, offset]
        );
        return result.rows;
    }

    async claimJobs({ workerId, limit, leaseSeconds }) {
        const result = await this.pool.query(
            `WITH candidates AS (
                SELECT id
                FROM shipment_jobs
                WHERE (
                    (status IN ('queued', 'retrying') AND next_attempt_at <= NOW())
                    OR (status = 'processing' AND lock_expires_at <= NOW())
                )
                ORDER BY next_attempt_at, created_at
                FOR UPDATE SKIP LOCKED
                LIMIT $1
             )
             UPDATE shipment_jobs AS j
             SET status = 'processing',
                 attempt_count = attempt_count + 1,
                 locked_by = $2,
                 locked_at = NOW(),
                 lock_expires_at = NOW() + ($3 * INTERVAL '1 second'),
                 last_error = CASE
                     WHEN j.status = 'processing' THEN 'Worker lease expired before completion'
                     ELSE j.last_error
                 END,
                 last_error_code = CASE
                     WHEN j.status = 'processing' THEN 'uncertain'
                     ELSE j.last_error_code
                 END,
                 updated_at = NOW()
             FROM candidates
             WHERE j.id = candidates.id
             RETURNING j.*`,
            [limit, workerId, leaseSeconds]
        );
        return result.rows;
    }

    async saveOrderId(jobId, workerId, orderId) {
        await this.pool.query(
            `UPDATE shipment_jobs
             SET order_id = $3, updated_at = NOW()
             WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
            [jobId, workerId, String(orderId)]
        );
    }

    async extendLeases(workerId, leaseSeconds) {
        await this.pool.query(
            `UPDATE shipment_jobs
             SET lock_expires_at = NOW() + ($2 * INTERVAL '1 second'), updated_at = NOW()
             WHERE locked_by = $1 AND status = 'processing'`,
            [workerId, leaseSeconds]
        );
    }

    async markSucceeded(jobId, workerId, response, remoteShipmentId = null) {
        await this.pool.query(
            `UPDATE shipment_jobs
             SET status = 'succeeded', last_error = NULL, last_error_code = NULL,
                 last_response = $3::jsonb, remote_shipment_id = COALESCE($4, remote_shipment_id),
                 locked_by = NULL, locked_at = NULL, lock_expires_at = NULL,
                 updated_at = NOW(), completed_at = NOW()
             WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
            [jobId, workerId, JSON.stringify(response ?? {}), remoteShipmentId]
        );
    }

    async markFailed(jobId, workerId, error, code, response = null) {
        await this.pool.query(
            `UPDATE shipment_jobs
             SET status = 'failed', last_error = $3, last_error_code = $4,
                 last_response = $5::jsonb, locked_by = NULL, locked_at = NULL,
                 lock_expires_at = NULL, updated_at = NOW(), completed_at = NOW()
             WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
            [jobId, workerId, error, code, JSON.stringify(response)]
        );
    }

    async markRetrying(jobId, workerId, { error, code, delayMs, response = null }) {
        await this.pool.query(
            `UPDATE shipment_jobs
             SET status = 'retrying', last_error = $3, last_error_code = $4,
                 last_response = $5::jsonb,
                 next_attempt_at = NOW() + ($6 * INTERVAL '1 millisecond'),
                 locked_by = NULL, locked_at = NULL, lock_expires_at = NULL,
                 updated_at = NOW(), completed_at = NULL
             WHERE id = $1 AND locked_by = $2 AND status = 'processing'`,
            [jobId, workerId, error, code, JSON.stringify(response), delayMs]
        );
    }

    async retryFailedJob(jobId) {
        const result = await this.pool.query(
            `UPDATE shipment_jobs
             SET status = 'retrying', attempt_count = 0, next_attempt_at = NOW(),
                 last_error = NULL, last_error_code = NULL, completed_at = NULL,
                 updated_at = NOW()
             WHERE id = $1 AND status = 'failed'
             RETURNING batch_id`,
            [jobId]
        );
        if (result.rowCount > 0) await this.refreshBatch(result.rows[0].batch_id);
        return result.rowCount > 0;
    }

    async refreshBatch(batchId) {
        await this.pool.query(
            `WITH counts AS (
                SELECT batch_id,
                       COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
                       COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
                       COUNT(*) FILTER (WHERE status = 'retrying')::int AS retrying,
                       COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
                       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
                FROM shipment_jobs
                WHERE batch_id = $1
                GROUP BY batch_id
             )
             UPDATE shipment_batches b
             SET status = CASE
                    WHEN counts.succeeded + counts.failed = counts.total
                        THEN CASE WHEN counts.failed > 0 THEN 'completed_with_errors' ELSE 'completed' END
                    WHEN counts.processing > 0 OR counts.retrying > 0 OR counts.succeeded > 0 OR counts.failed > 0
                        THEN 'processing'
                    ELSE 'queued'
                 END,
                 updated_at = NOW(),
                 completed_at = CASE
                    WHEN counts.succeeded + counts.failed = counts.total THEN COALESCE(b.completed_at, NOW())
                    ELSE NULL
                 END
             FROM counts
             WHERE b.id = counts.batch_id`,
            [batchId]
        );
    }
}
