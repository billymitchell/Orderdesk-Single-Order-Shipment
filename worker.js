import pLimit from 'p-limit';
import { config } from './config.js';
import { findStore } from './stores.js';
import {
    OrderDeskError,
    createBatchShipments,
    createSingleShipment,
    fetchOrderId,
    findMatchingShipment
} from './orderdesk.js';

export const retryDelayMs = (attemptCount) => {
    const exponential = Math.min(300000, 1000 * (2 ** Math.max(1, attemptCount)));
    return exponential + Math.floor(Math.random() * 500);
};

const shipmentFields = (payload) => ({
    tracking_number: payload.tracking_number,
    carrier_code: payload.carrier_code,
    shipment_method: payload.shipment_method,
    ...(payload.weight !== undefined ? { weight: payload.weight } : {}),
    ...(payload.cost !== undefined ? { cost: payload.cost } : {}),
    ...(payload.status !== undefined ? { status: payload.status } : {}),
    ...(payload.tracking_url !== undefined ? { tracking_url: payload.tracking_url } : {})
});

const errorDetails = (error) => {
    if (error instanceof OrderDeskError) {
        return {
            message: error.message,
            code: error.uncertain ? 'uncertain' : error.code,
            retryable: error.retryable,
            retryAfterMs: error.retryAfterMs,
            response: error.response
        };
    }
    return {
        message: error?.message || 'Unexpected worker error',
        code: 'worker_error',
        retryable: true,
        retryAfterMs: null,
        response: null
    };
};

export const createShipmentWorker = ({
    queue,
    settings = config,
    storeLookup = findStore,
    services = {
        createBatchShipments,
        createSingleShipment,
        fetchOrderId,
        findMatchingShipment
    }
}) => {
    let stopped = true;
    let timer = null;
    let currentRun = null;
    let lastPollAt = null;
    let lastSuccessAt = null;
    let lastError = null;

    const recordFailure = async (job, error) => {
        const details = errorDetails(error);
        if (details.retryable && job.attempt_count < settings.workerMaxAttempts) {
            await queue.markRetrying(job.id, settings.workerId, {
                error: details.message,
                code: details.code,
                delayMs: details.retryAfterMs ?? retryDelayMs(job.attempt_count),
                response: details.response
            });
            return;
        }
        await queue.markFailed(
            job.id,
            settings.workerId,
            details.message,
            details.code,
            details.response
        );
    };

    const prepareJob = async (job) => {
        const store = storeLookup(job.store_id);
        if (!store) {
            await recordFailure(job, new OrderDeskError(`Unknown store ID ${job.store_id}`, {
                code: 'invalid_store'
            }));
            return null;
        }
        if (!store.API_KEY) {
            await recordFailure(job, new OrderDeskError(`API key is not configured for store ${job.store_id}`, {
                code: 'missing_api_key'
            }));
            return null;
        }

        try {
            let orderId = job.order_id;
            if (!orderId) {
                orderId = await services.fetchOrderId({
                    storeId: job.store_id,
                    apiKey: store.API_KEY,
                    sourceId: job.source_id
                });
                await queue.saveOrderId(job.id, settings.workerId, orderId);
            }

            if (job.last_error_code === 'uncertain') {
                const existing = await services.findMatchingShipment({
                    storeId: job.store_id,
                    apiKey: store.API_KEY,
                    orderId,
                    payload: job.payload
                });
                if (existing) {
                    await queue.markSucceeded(job.id, settings.workerId, {
                        reconciled: true,
                        shipment: existing
                    }, existing.id ? String(existing.id) : null);
                    return null;
                }
            }

            return { job, store, orderId };
        } catch (error) {
            await recordFailure(job, error);
            return null;
        }
    };

    const processSingle = async ({ job, store, orderId }) => {
        try {
            const response = await services.createSingleShipment({
                storeId: job.store_id,
                apiKey: store.API_KEY,
                orderId,
                shipment: {
                    ...shipmentFields(job.payload),
                    order_items: job.payload.order_items
                }
            });
            await queue.markSucceeded(
                job.id,
                settings.workerId,
                response,
                response?.shipment?.id ? String(response.shipment.id) : null
            );
        } catch (error) {
            await recordFailure(job, error);
        }
    };

    const processBatchChunk = async (preparedJobs) => {
        const first = preparedJobs[0];
        const body = preparedJobs.map(({ job, orderId }) => ({
            order_id: Number(orderId),
            ...shipmentFields(job.payload)
        }));

        try {
            const response = await services.createBatchShipments({
                storeId: first.job.store_id,
                apiKey: first.store.API_KEY,
                shipments: body
            });
            const results = Array.isArray(response?.results) ? response.results : [];

            await Promise.all(preparedJobs.map(async ({ job }, index) => {
                const result = results[index];
                if (result?.status === 'success') {
                    await queue.markSucceeded(
                        job.id,
                        settings.workerId,
                        result,
                        result.shipment_id ? String(result.shipment_id) : null
                    );
                    return;
                }

                if (!result) {
                    await recordFailure(job, new OrderDeskError(
                        'Order Desk did not return a result for this shipment',
                        { code: 'missing_batch_result', retryable: true, uncertain: true, response }
                    ));
                    return;
                }

                await recordFailure(job, new OrderDeskError(
                    result.message || 'Order Desk rejected this shipment',
                    { code: 'shipment_rejected', response: result }
                ));
            }));
        } catch (error) {
            await Promise.all(preparedJobs.map(({ job }) => recordFailure(job, error)));
        }
    };

    const runOnce = async () => {
        lastPollAt = new Date().toISOString();
        const jobs = await queue.claimJobs({
            workerId: settings.workerId,
            limit: settings.workerClaimSize,
            leaseSeconds: settings.workerLeaseSeconds
        });
        if (jobs.length === 0) {
            lastSuccessAt = new Date().toISOString();
            lastError = null;
            return 0;
        }

        const batchIds = [...new Set(jobs.map((job) => job.batch_id))];
        const heartbeat = setInterval(() => {
            queue.extendLeases(settings.workerId, settings.workerLeaseSeconds).catch((error) => {
                console.error('[worker] Failed to extend job leases:', error);
            });
        }, Math.max(1000, Math.floor(settings.workerLeaseSeconds * 500)));

        try {
            const limit = pLimit(settings.workerConcurrency);
            const prepared = (await Promise.all(jobs.map((job) => limit(() => prepareJob(job))))).filter(Boolean);
            const singleJobs = prepared.filter(({ job }) => Array.isArray(job.payload.order_items) && job.payload.order_items.length > 0);
            const batchJobs = prepared.filter(({ job }) => !Array.isArray(job.payload.order_items) || job.payload.order_items.length === 0);

            await Promise.all(singleJobs.map((job) => limit(() => processSingle(job))));

            const byStore = new Map();
            for (const job of batchJobs) {
                if (!byStore.has(job.job.store_id)) byStore.set(job.job.store_id, []);
                byStore.get(job.job.store_id).push(job);
            }
            for (const storeJobs of byStore.values()) {
                for (let offset = 0; offset < storeJobs.length; offset += settings.orderDeskBatchSize) {
                    await processBatchChunk(storeJobs.slice(offset, offset + settings.orderDeskBatchSize));
                }
            }
        } finally {
            clearInterval(heartbeat);
            await Promise.all(batchIds.map((batchId) => queue.refreshBatch(batchId)));
        }
        lastSuccessAt = new Date().toISOString();
        lastError = null;
        return jobs.length;
    };

    const schedule = () => {
        if (stopped) return;
        timer = setTimeout(async () => {
            currentRun = runOnce();
            try {
                await currentRun;
            } catch (error) {
                lastError = error.message;
                console.error('[worker] Unexpected processing failure:', error);
            } finally {
                currentRun = null;
                schedule();
            }
        }, settings.workerPollIntervalMs);
    };

    return {
        runOnce,
        start() {
            if (!stopped) return;
            stopped = false;
            schedule();
        },
        async stop() {
            stopped = true;
            if (timer) clearTimeout(timer);
            if (currentRun) await currentRun.catch(() => {});
        },
        getHealth() {
            return {
                running: !stopped,
                active: Boolean(currentRun),
                last_poll_at: lastPollAt,
                last_success_at: lastSuccessAt,
                last_error: lastError
            };
        }
    };
};
