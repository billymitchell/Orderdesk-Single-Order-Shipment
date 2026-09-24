import { findStore, resolveStoreId } from './stores.js';

const DEFAULT_ALLOWED_CARRIER_CODES = [
    'ups', 'fedex', 'usps', 'dhl', 'ontrac', 'lasership', 'canadapost',
    'australiapost', 'royalmail', 'gls', 'amazon', 'other'
];

export const allowedCarrierCodes = new Set(
    (process.env.ALLOWED_CARRIER_CODES || DEFAULT_ALLOWED_CARRIER_CODES.join(','))
        .split(',')
        .map((code) => code.trim().toLowerCase())
        .filter(Boolean)
);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

export const validateShipments = (value) => {
    const shipments = Array.isArray(value) ? value : [value];
    const errors = [];

    if (!value || typeof value !== 'object' || shipments.length === 0) {
        return { shipments: [], errors: [{ index: null, field: 'body', message: 'Expected a shipment object or non-empty array' }] };
    }

    shipments.forEach((shipment, index) => {
        if (!shipment || typeof shipment !== 'object' || Array.isArray(shipment)) {
            errors.push({ index, field: 'shipment', message: 'Shipment must be an object' });
            return;
        }

        const storeId = resolveStoreId(shipment);
        const hasLineItems = Array.isArray(shipment.order_items) && shipment.order_items.length > 0;
        const canUseExplicitOrder = hasLineItems && shipment.order_id !== undefined && shipment.order_id !== null;

        if (!storeId) {
            errors.push({ index, field: 'store_id', message: 'Provide store_id or a source_id beginning with the store ID' });
        } else if (!findStore(storeId)) {
            errors.push({ index, field: 'store_id', message: `Store ${storeId} is not configured` });
        }

        if (!isNonEmptyString(shipment.source_id) && !canUseExplicitOrder) {
            errors.push({ index, field: 'source_id', message: 'source_id is required unless a line-item shipment provides order_id and store_id' });
        }
        if (!isNonEmptyString(shipment.tracking_number)) {
            errors.push({ index, field: 'tracking_number', message: 'tracking_number is required' });
        }
        if (!isNonEmptyString(shipment.shipment_method)) {
            errors.push({ index, field: 'shipment_method', message: 'shipment_method is required' });
        }

        const carrierCode = isNonEmptyString(shipment.carrier_code)
            ? shipment.carrier_code.trim().toLowerCase()
            : '';
        if (!carrierCode || !allowedCarrierCodes.has(carrierCode)) {
            errors.push({
                index,
                field: 'carrier_code',
                message: `Unrecognized carrier code: ${shipment.carrier_code ?? 'missing'}`
            });
        }

        if (shipment.order_items !== undefined) {
            if (!Array.isArray(shipment.order_items) || shipment.order_items.length === 0) {
                errors.push({ index, field: 'order_items', message: 'order_items must be a non-empty array when provided' });
            } else {
                shipment.order_items.forEach((item, itemIndex) => {
                    if (!item || typeof item !== 'object' || (!item.id && !item.code)) {
                        errors.push({ index, field: `order_items[${itemIndex}]`, message: 'Each order item requires an id or code' });
                    }
                    if (!Number.isFinite(Number(item?.quantity)) || Number(item.quantity) <= 0) {
                        errors.push({ index, field: `order_items[${itemIndex}].quantity`, message: 'Quantity must be greater than zero' });
                    }
                });
            }
        }
    });

    return { shipments, errors };
};

export const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

