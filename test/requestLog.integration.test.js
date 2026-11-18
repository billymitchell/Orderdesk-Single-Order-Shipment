// End-to-end request logging against a real PostgreSQL database. Skipped
// unless TEST_DATABASE_URL points at a migrated, disposable database.
import test from 'node:test';
import assert from 'node:assert/strict';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('inbound submissions and outbound Order Desk calls are logged and searchable', { skip: !databaseUrl }, async () => {
    process.env.STORE_21633 = 'test-store-key-1234567890';
    const { default: pg } = await import('pg');
    const { default: express } = await import('express');
    const { configureRequestLog } = await import('../lib/requestLog.js');
    const { setFetchImplementation } = await import('../orderdesk.js');
    const { ShipmentQueue } = await import('../queue.js');
    const { createShipmentWorker } = await import('../worker.js');
    const { createApp } = await import('../app.js');
    const { createApi } = await import('../admin/api.js');

    const pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query('TRUNCATE request_logs, shipment_jobs, shipment_batches');
    configureRequestLog({ pool });

    const waitForRows = async (sql, params, count) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const { rows } = await pool.query(sql, params);
            if (rows.length >= count) return rows;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Timed out waiting for ${count} rows: ${sql}`);
    };

    const queue = new ShipmentQueue(pool);
    const fakeWorker = { getHealth: () => ({ running: true }) };
    const server = createApp({ queue, pool, worker: fakeWorker, admin: false }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        const accepted = await fetch(`${base}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'it-1' },
            body: JSON.stringify({
                source_id: '21633-ORDER-77',
                tracking_number: '1ZINTEGRATION',
                carrier_code: 'ups',
                shipment_method: 'Ground'
            })
        });
        assert.equal(accepted.status, 202);
        const { batch_id: batchId } = await accepted.json();

        const rejected = await fetch(`${base}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_id: '21633-ORDER-78' })
        });
        assert.equal(rejected.status, 400);

        const inbound = await waitForRows(
            "SELECT * FROM request_logs WHERE direction = 'inbound' ORDER BY created_at",
            [],
            2
        );
        const [ok, bad] = inbound;
        assert.equal(ok.outcome, 'success');
        assert.equal(ok.status, 202);
        assert.equal(ok.inbound_auth, 'not_required');
        assert.equal(ok.idempotency_key, 'it-1');
        assert.deepEqual(ok.batch_ids, [batchId]);
        assert.deepEqual(ok.tracking_numbers, ['1ZINTEGRATION']);
        assert.equal(ok.request_body.tracking_number, '1ZINTEGRATION');
        assert.equal(ok.response_body.batch_id, batchId);
        assert.equal(bad.outcome, 'validation_error');
        assert.equal(bad.response_body.message, 'Invalid shipment payload');

        // Run the real worker against a fake Order Desk.
        const calls = [];
        setFetchImplementation(async (url, options) => {
            calls.push({ url, options });
            const respond = (body) => new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'x-tokens-remaining': '17' }
            });
            if (url.includes('/orders?source_id=')) return respond({ orders: [{ id: 4242 }] });
            if (url.endsWith('/batch-shipments')) return respond({ results: [{ status: 'success', shipment_id: 99 }] });
            throw new Error(`Unexpected URL ${url}`);
        });
        const worker = createShipmentWorker({ queue });
        assert.equal(await worker.runOnce(), 1);
        setFetchImplementation(null);
        assert.equal(calls.length, 2);

        const outbound = await waitForRows(
            "SELECT * FROM request_logs WHERE direction = 'outbound' ORDER BY created_at",
            [],
            2
        );
        const [lookup, create] = outbound;
        assert.equal(lookup.method, 'GET');
        assert.equal(lookup.tokens_remaining, 17);
        assert.deepEqual(lookup.batch_ids, [batchId]);
        assert.equal(create.method, 'POST');
        assert.equal(create.outcome, 'success');
        assert.equal(create.request_headers['ORDERDESK-API-KEY'], '[redacted]');
        assert.ok(!JSON.stringify(create).includes('test-store-key'));
        assert.deepEqual(create.batch_ids, [batchId]);
        assert.ok(create.tracking_numbers.includes('1ZINTEGRATION'));
        assert.ok(create.order_numbers.includes('4242'));
        assert.equal(create.response_body.results[0].shipment_id, 99);

        // Dashboard API: filters, search, and related requests.
        const adminApp = express();
        adminApp.use((req, res, next) => { req.user = { email: 'test@centricitynow.com' }; next(); });
        adminApp.use('/api', createApi({ pool }));
        const adminServer = adminApp.listen(0);
        const adminBase = `http://127.0.0.1:${adminServer.address().port}/api`;
        try {
            const get = async (path) => (await fetch(`${adminBase}${path}`)).json();

            const byBatch = await get(`/logs?batch=${batchId}`);
            assert.equal(byBatch.total, 3);

            const outboundOnly = await get('/logs?direction=outbound');
            assert.equal(outboundOnly.total, 2);

            const search = await get('/logs?q=1zintegration');
            assert.equal(search.total, 3);

            const byStatus = await get('/logs?status=4xx');
            assert.equal(byStatus.total, 1);
            assert.equal(byStatus.counts.validation_error, 1);

            const byStore = await get('/logs?store=21633&method=GET');
            assert.equal(byStore.total, 1);

            const detail = await get(`/logs/${ok.id}`);
            assert.equal(detail.related.length, 2);
            assert.ok(detail.related.every((row) => row.direction === 'outbound'));
            assert.equal(detail.search_text, undefined);

            const csv = await (await fetch(`${adminBase}/logs/export.csv?direction=inbound`)).text();
            assert.equal(csv.trim().split('\r\n').length, 3);
        } finally {
            adminServer.close();
        }
    } finally {
        server.close();
        configureRequestLog({ pool: null });
        await pool.end();
    }
});
