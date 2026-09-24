import test from 'node:test';
import assert from 'node:assert/strict';
import { createShipmentWorker } from '../worker.js';

const settings = {
    workerId: 'test-worker',
    workerClaimSize: 100,
    workerLeaseSeconds: 300,
    workerMaxAttempts: 3,
    workerConcurrency: 2,
    workerPollIntervalMs: 1000,
    orderDeskBatchSize: 100
};

const createQueue = (jobs) => {
    const events = [];
    return {
        events,
        async claimJobs() { return jobs; },
        async saveOrderId() {},
        async extendLeases() {},
        async markSucceeded(id, workerId, response) { events.push({ type: 'succeeded', id, response }); },
        async markFailed(id, workerId, error, code) { events.push({ type: 'failed', id, error, code }); },
        async markRetrying(id, workerId, retry) { events.push({ type: 'retrying', id, retry }); },
        async refreshBatch(id) { events.push({ type: 'refreshed', id }); }
    };
};

const batchJob = (id, position) => ({
    id,
    batch_id: 'batch-1',
    position,
    store_id: '21633',
    source_id: `21633-ORDER-${position}`,
    order_id: String(100 + position),
    status: 'processing',
    attempt_count: 1,
    last_error_code: null,
    payload: {
        source_id: `21633-ORDER-${position}`,
        tracking_number: `TRACK-${position}`,
        carrier_code: 'ups',
        shipment_method: 'Ground'
    }
});

test('worker records individual success and failure results from HTTP 200 batches', async () => {
    const queue = createQueue([batchJob('job-1', 0), batchJob('job-2', 1)]);
    const worker = createShipmentWorker({
        queue,
        settings,
        storeLookup: () => ({ STORE_ID: '21633', API_KEY: 'test-key' }),
        services: {
            async fetchOrderId() { throw new Error('not expected'); },
            async findMatchingShipment() { return null; },
            async createSingleShipment() { throw new Error('not expected'); },
            async createBatchShipments() {
                return {
                    results: [
                        { status: 'success', order_id: 100 },
                        { status: 'error', order_id: 101, message: 'Invalid shipment' }
                    ]
                };
            }
        }
    });

    assert.equal(await worker.runOnce(), 2);
    assert.ok(queue.events.some((event) => event.type === 'succeeded' && event.id === 'job-1'));
    assert.ok(queue.events.some((event) => event.type === 'failed' && event.id === 'job-2'));
    assert.ok(queue.events.some((event) => event.type === 'refreshed' && event.id === 'batch-1'));
});

test('worker reconciles an uncertain job before creating another shipment', async () => {
    const job = { ...batchJob('job-1', 0), last_error_code: 'uncertain' };
    const queue = createQueue([job]);
    let createCalls = 0;
    const worker = createShipmentWorker({
        queue,
        settings,
        storeLookup: () => ({ STORE_ID: '21633', API_KEY: 'test-key' }),
        services: {
            async fetchOrderId() { throw new Error('not expected'); },
            async findMatchingShipment() { return { id: 999, tracking_number: 'TRACK-0' }; },
            async createSingleShipment() { createCalls += 1; },
            async createBatchShipments() { createCalls += 1; }
        }
    });

    await worker.runOnce();
    assert.equal(createCalls, 0);
    assert.ok(queue.events.some((event) => event.type === 'succeeded' && event.id === 'job-1'));
});

