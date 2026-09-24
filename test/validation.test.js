import test from 'node:test';
import assert from 'node:assert/strict';
import { validateShipments } from '../validation.js';

test('validateShipments accepts the existing batch shipment format', () => {
    const result = validateShipments({
        source_id: '21633-ORD-1',
        tracking_number: '1Z123',
        carrier_code: 'UPS',
        shipment_method: 'Ground'
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.shipments.length, 1);
});

test('validateShipments reports every invalid entry before persistence', () => {
    const result = validateShipments([
        {
            source_id: '21633-ORD-1',
            tracking_number: '',
            carrier_code: 'unknown',
            shipment_method: ''
        },
        null
    ]);
    assert.ok(result.errors.some((error) => error.index === 0 && error.field === 'tracking_number'));
    assert.ok(result.errors.some((error) => error.index === 0 && error.field === 'carrier_code'));
    assert.ok(result.errors.some((error) => error.index === 1 && error.field === 'shipment'));
});

test('validateShipments accepts explicit order and store IDs for line-item shipments', () => {
    const result = validateShipments({
        store_id: '21633',
        order_id: '123456',
        tracking_number: '1Z123',
        carrier_code: 'ups',
        shipment_method: 'Ground',
        order_items: [{ code: 'SKU-1', quantity: 2 }]
    });
    assert.deepEqual(result.errors, []);
});

