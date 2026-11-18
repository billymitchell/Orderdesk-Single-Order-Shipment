import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSearchText,
    describeShipments,
    inboundOutcome,
    logContextForJobs,
    redactHeaders,
    rowFromRecord,
    sanitizeInboundHeaders
} from '../lib/requestLog.js';
import { buildFilters, buildOrder, csvCell } from '../admin/api.js';

test('describeShipments pulls stores, tracking numbers and order identifiers', () => {
    const described = describeShipments([
        { source_id: '21633-1001', tracking_number: '1Z999', carrier_code: 'ups' },
        { store_id: '40348', order_id: 555, tracking_number: '1Z888' },
        null
    ]);
    assert.deepEqual(described.storeIds, ['21633', '40348']);
    assert.deepEqual(described.trackingNumbers, ['1Z999', '1Z888']);
    assert.deepEqual(described.orderNumbers, ['21633-1001', '555']);
    assert.equal(described.count, 2);
});

test('logContextForJobs links jobs to their batches and identifiers', () => {
    const context = logContextForJobs([
        { id: 'job-1', batch_id: 'batch-1', store_id: '21633', source_id: '21633-1', order_id: '9', payload: { tracking_number: 'T1' } },
        { id: 'job-2', batch_id: 'batch-1', store_id: '21633', source_id: '21633-2', payload: { tracking_number: 'T2' } }
    ]);
    assert.deepEqual(context.jobIds, ['job-1', 'job-2']);
    assert.deepEqual(context.batchIds, ['batch-1']);
    assert.deepEqual(context.trackingNumbers, ['T1', 'T2']);
    assert.deepEqual(context.orderNumbers, ['21633-1', '9', '21633-2']);
});

test('inbound headers are allowlisted and outbound secrets are redacted', () => {
    assert.deepEqual(
        sanitizeInboundHeaders({ 'content-type': 'application/json', 'x-api-key': 'secret', authorization: 'Bearer x' }),
        { 'content-type': 'application/json' }
    );
    assert.deepEqual(
        redactHeaders({ 'ORDERDESK-STORE-ID': '21633', 'ORDERDESK-API-KEY': 'secret' }),
        { 'ORDERDESK-STORE-ID': '21633', 'ORDERDESK-API-KEY': '[redacted]' }
    );
});

test('inboundOutcome maps HTTP statuses to outcomes', () => {
    assert.equal(inboundOutcome(202), 'success');
    assert.equal(inboundOutcome(400), 'validation_error');
    assert.equal(inboundOutcome(413), 'validation_error');
    assert.equal(inboundOutcome(401), 'unauthorized');
    assert.equal(inboundOutcome(404), 'not_found');
    assert.equal(inboundOutcome(409), 'conflict');
    assert.equal(inboundOutcome(503), 'error');
});

test('rowFromRecord dedupes identifiers and builds lowercase search text', () => {
    const record = {
        id: 'ID-1', direction: 'outbound', outcome: 'success', method: 'POST', url: 'https://x',
        tracking_numbers: ['1ZABC', '1ZABC', null], batch_ids: ['B-1'], store_ids: ['21633']
    };
    const row = rowFromRecord(record);
    assert.deepEqual(row[18], ['1ZABC']);
    assert.match(buildSearchText(record), /1zabc/);
    assert.match(row[21], /b-1/);
});

test('buildFilters binds every value and supports direction, store, batch and status ranges', () => {
    const { where, params } = buildFilters({
        direction: 'outbound',
        outcome: 'downstream_error',
        store: '21633',
        batch: '0b7c3a52-7d0e-4c3a-9d1f-2b8a6c4e5f10',
        status: '4xx',
        method: 'post',
        q: "1z99 o'brien"
    });
    assert.match(where, /direction = \$1/);
    assert.match(where, /\$\d+ = ANY\(store_ids\)/);
    assert.match(where, /\$\d+ = ANY\(batch_ids\)/);
    assert.match(where, /status >= \$\d+ AND status < \$\d+/);
    assert.ok(!where.includes('1z99'));
    assert.ok(params.includes('POST'));
    assert.ok(params.includes(400) && params.includes(500));
});

test('buildFilters ignores values outside the allowlists', () => {
    const { where, params } = buildFilters({ direction: 'sideways', outcome: 'x; drop', store: 'abc', batch: 'nope' });
    assert.equal(where, '');
    assert.deepEqual(params, []);
    assert.equal(buildOrder({ sort: 'id; drop table', dir: 'asc' }), 'ORDER BY created_at ASC NULLS LAST, id ASC');
});

test('csvCell quotes and neutralizes formulas', () => {
    assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell(['1', '2']), '1 2');
});
