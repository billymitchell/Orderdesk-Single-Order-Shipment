import express from 'express';
import bodyParser from 'body-parser';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { QueueConflictError } from './queue.js';
import { isUuid, validateShipments } from './validation.js';

const asyncHandler = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
};

const parsePagination = (req) => ({
    limit: Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100)),
    offset: Math.max(0, Number.parseInt(req.query.offset, 10) || 0)
});

const storageUnavailableCodes = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', '57P01', '57P02',
    '57P03', '53300', '08000', '08001', '08003', '08004', '08006', '08007', '08P01'
]);

const secureEqual = (provided, expected) => {
    if (!provided || !expected) return false;
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
};

const incomingApiKey = (req) => {
    const authorization = req.get('Authorization');
    if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim();
    return req.get('X-API-Key');
};

export const createApp = ({ queue, pool, worker }) => {
    const app = express();
    app.disable('x-powered-by');

    app.get('/health/live', (req, res) => {
        res.json({ status: 'ok' });
    });

    const readinessHandler = asyncHandler(async (req, res) => {
        await pool.query('SELECT 1');
        const workerHealth = worker.getHealth();
        if (!workerHealth.running) {
            return res.status(503).json({ status: 'not_ready', database: 'ok', worker: workerHealth });
        }
        return res.json({ status: 'ok', database: 'ok', worker: workerHealth });
    });
    app.get('/health', readinessHandler);
    app.get('/health/ready', readinessHandler);

    app.use((req, res, next) => {
        if (!config.inboundApiKey && !config.requireInboundAuth) return next();
        if (!secureEqual(incomingApiKey(req), config.inboundApiKey)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        return next();
    });

    app.use(bodyParser.json({ limit: config.requestBodyLimit }));

    app.post('/', asyncHandler(async (req, res) => {
        const { shipments, errors } = validateShipments(req.body);
        if (errors.length > 0) {
            return res.status(400).json({ message: 'Invalid shipment payload', errors });
        }

        const idempotencyKey = req.get('Idempotency-Key');
        if (idempotencyKey && idempotencyKey.length > 255) {
            return res.status(400).json({ message: 'Idempotency-Key must be 255 characters or fewer' });
        }

        const result = await queue.enqueueBatch(shipments, idempotencyKey);
        const statusUrl = `/batches/${result.batchId}`;
        return res.status(202)
            .location(statusUrl)
            .json({
                message: 'Shipments queued for processing',
                batch_id: result.batchId,
                status: result.status,
                shipment_count: result.shipmentCount,
                status_url: statusUrl,
                replayed: result.replayed
            });
    }));

    app.get('/batches/:batchId', asyncHandler(async (req, res) => {
        if (!isUuid(req.params.batchId)) return res.status(400).json({ message: 'Invalid batch ID' });
        const batch = await queue.getBatch(req.params.batchId);
        if (!batch) return res.status(404).json({ message: 'Batch not found' });
        return res.json({ ...batch, shipments_url: `/batches/${req.params.batchId}/shipments` });
    }));

    app.get('/batches/:batchId/shipments', asyncHandler(async (req, res) => {
        if (!isUuid(req.params.batchId)) return res.status(400).json({ message: 'Invalid batch ID' });
        const batch = await queue.getBatch(req.params.batchId);
        if (!batch) return res.status(404).json({ message: 'Batch not found' });
        const pagination = parsePagination(req);
        const shipments = await queue.getBatchJobs(req.params.batchId, pagination);
        return res.json({ batch_id: req.params.batchId, ...pagination, shipments });
    }));

    app.post('/shipments/:jobId/retry', asyncHandler(async (req, res) => {
        if (!config.adminApiKey) {
            return res.status(503).json({ message: 'Manual retry is disabled because ADMIN_API_KEY is not configured' });
        }
        if (req.get('X-Admin-API-Key') !== config.adminApiKey) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
        if (!isUuid(req.params.jobId)) return res.status(400).json({ message: 'Invalid shipment job ID' });
        const retried = await queue.retryFailedJob(req.params.jobId);
        if (!retried) return res.status(409).json({ message: 'Only failed shipment jobs can be retried' });
        return res.status(202).json({ message: 'Shipment queued for retry', job_id: req.params.jobId });
    }));

    app.use((err, req, res, next) => {
        console.error('[HTTP] Request failed:', err);
        if (err instanceof QueueConflictError) {
            return res.status(409).json({ message: err.message, ...err.details });
        }
        if (err.type === 'entity.too.large') {
            return res.status(413).json({ message: `Request body exceeds the ${config.requestBodyLimit} limit` });
        }
        if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
            return res.status(400).json({ message: 'Malformed JSON request body' });
        }
        if (storageUnavailableCodes.has(err.code)) {
            return res.status(503).json({ message: 'Durable shipment storage is unavailable' });
        }
        return res.status(500).json({ message: 'Internal Server Error' });
    });

    return app;
};
