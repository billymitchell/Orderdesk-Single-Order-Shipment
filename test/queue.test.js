import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBatchStatus, hashValue, normalizeShipment, stableStringify } from '../queue.js';

test('stableStringify and hashValue ignore object key order', () => {
    const first = { b: 2, a: { d: 4, c: 3 } };
    const second = { a: { c: 3, d: 4 }, b: 2 };
    assert.equal(stableStringify(first), stableStringify(second));
    assert.equal(hashValue(first), hashValue(second));
});

test('normalizeShipment produces consistent identifiers and carrier codes', () => {
    assert.deepEqual(normalizeShipment({
        store_id: 21633,
        order_id: 123,
        source_id: ' 21633-ABC ',
        tracking_number: ' 1Z123 ',
        carrier_code: ' UPS ',
        shipment_method: ' Ground '
    }), {
        store_id: '21633',
        order_id: '123',
        source_id: '21633-ABC',
        tracking_number: '1Z123',
        carrier_code: 'ups',
        shipment_method: 'Ground'
    });
});

test('deriveBatchStatus reports queued, processing, and terminal outcomes', () => {
    assert.equal(deriveBatchStatus({ total: 2, queued: 2, processing: 0, retrying: 0, succeeded: 0, failed: 0 }), 'queued');
    assert.equal(deriveBatchStatus({ total: 2, queued: 0, processing: 1, retrying: 0, succeeded: 1, failed: 0 }), 'processing');
    assert.equal(deriveBatchStatus({ total: 2, queued: 0, processing: 0, retrying: 0, succeeded: 2, failed: 0 }), 'completed');
    assert.equal(deriveBatchStatus({ total: 2, queued: 0, processing: 0, retrying: 0, succeeded: 1, failed: 1 }), 'completed_with_errors');
});

