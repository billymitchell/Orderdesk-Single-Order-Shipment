import fetch from 'node-fetch';
import Bottleneck from 'bottleneck';
import { config, retryableHttpStatuses } from './config.js';

const storeLimiters = new Map();

const getStoreLimiter = (storeId) => {
    if (!storeLimiters.has(storeId)) {
        storeLimiters.set(storeId, new Bottleneck({
            reservoir: 20,
            reservoirIncreaseAmount: 3,
            reservoirIncreaseInterval: 1000,
            reservoirIncreaseMaximum: 20,
            maxConcurrent: 3
        }));
    }
    return storeLimiters.get(storeId);
};

const maskApiKey = (value) => {
    if (!value) return 'missing';
    const stringValue = String(value);
    if (stringValue.length <= 8) return '***';
    return `${stringValue.slice(0, 4)}...${stringValue.slice(-4)}`;
};

const parseBody = (text) => {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

export class OrderDeskError extends Error {
    constructor(message, {
        code = 'orderdesk_error',
        status = null,
        retryable = false,
        uncertain = false,
        retryAfterMs = null,
        response = null
    } = {}) {
        super(message);
        this.name = 'OrderDeskError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.uncertain = uncertain;
        this.retryAfterMs = retryAfterMs;
        this.response = response;
    }
}

const request = async ({ storeId, apiKey, url, method = 'GET', body, mutating = false }) => {
    const limiter = getStoreLimiter(storeId);

    return limiter.schedule(async () => {
        const headers = {
            'ORDERDESK-STORE-ID': storeId,
            'ORDERDESK-API-KEY': apiKey,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.orderDeskRequestTimeoutMs);
        let response;

        console.info('[OrderDesk][request]', {
            storeId,
            method,
            url,
            apiKey: maskApiKey(apiKey),
            shipmentCount: Array.isArray(body) ? body.length : (body ? 1 : 0)
        });

        try {
            response = await fetch(url, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });
        } catch (error) {
            const isTimeout = error.name === 'AbortError';
            throw new OrderDeskError(
                isTimeout ? `Order Desk request timed out after ${config.orderDeskRequestTimeoutMs}ms` : error.message,
                {
                    code: isTimeout ? 'timeout' : 'network_error',
                    retryable: true,
                    uncertain: mutating
                }
            );
        } finally {
            clearTimeout(timeout);
        }

        const responseText = await response.text();
        const responseBody = parseBody(responseText);
        const tokensRemaining = response.headers.get('x-tokens-remaining');
        const retryAfterSeconds = Number.parseInt(response.headers.get('x-retry-after'), 10);
        const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : null;

        console.info('[OrderDesk][response]', {
            storeId,
            method,
            url,
            status: response.status,
            tokensRemaining,
            retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
            body: responseBody
        });

        const parsedTokens = Number.parseInt(tokensRemaining, 10);
        if (Number.isFinite(parsedTokens)) {
            if (parsedTokens <= 0) {
                console.error(`[RateLimit OVERAGE] store=${storeId} tokens=0 method=${method} url=${url}`);
            } else if (config.rateLimitLog !== 'off' && parsedTokens <= config.rateLimitWarnTokens) {
                console.warn(`[RateLimit Warning] store=${storeId} tokens=${parsedTokens} method=${method} url=${url}`);
            } else if (config.rateLimitLog === 'verbose') {
                console.info(`[RateLimit] store=${storeId} tokens=${parsedTokens} method=${method} url=${url}`);
            }
        }

        if (!response.ok) {
            const message = responseBody?.message || `Order Desk returned HTTP ${response.status}`;
            throw new OrderDeskError(message, {
                code: response.status === 429 ? 'rate_limited' : `http_${response.status}`,
                status: response.status,
                retryable: retryableHttpStatuses.has(response.status),
                uncertain: mutating && response.status >= 500,
                retryAfterMs,
                response: responseBody
            });
        }

        return responseBody;
    });
};

export const fetchOrderId = async ({ storeId, apiKey, sourceId }) => {
    const data = await request({
        storeId,
        apiKey,
        url: `https://app.orderdesk.me/api/v2/orders?source_id=${encodeURIComponent(sourceId)}`
    });
    if (!Array.isArray(data?.orders) || data.orders.length === 0) {
        throw new OrderDeskError(`No Order Desk order found for source_id ${sourceId}`, {
            code: 'order_not_found',
            response: data
        });
    }
    return String(data.orders[0].id);
};

export const createBatchShipments = async ({ storeId, apiKey, shipments }) => request({
    storeId,
    apiKey,
    url: 'https://app.orderdesk.me/api/v2/batch-shipments',
    method: 'POST',
    body: shipments,
    mutating: true
});

export const createSingleShipment = async ({ storeId, apiKey, orderId, shipment }) => request({
    storeId,
    apiKey,
    url: `https://app.orderdesk.me/api/v2/orders/${encodeURIComponent(orderId)}/shipments`,
    method: 'POST',
    body: shipment,
    mutating: true
});

export const listOrderShipments = async ({ storeId, apiKey, orderId }) => request({
    storeId,
    apiKey,
    url: `https://app.orderdesk.me/api/v2/orders/${encodeURIComponent(orderId)}/shipments`
});

const normalizeComparable = (value) => String(value ?? '').trim().toLowerCase();

const itemKey = (item) => normalizeComparable(item.id ?? item.code);

const lineItemsMatch = (expectedItems, actualItems) => {
    if (!Array.isArray(expectedItems) || expectedItems.length === 0) return true;
    if (!Array.isArray(actualItems)) return false;
    const actualQuantities = new Map(actualItems.map((item) => [itemKey(item), Number(item.quantity)]));
    return expectedItems.every((item) => actualQuantities.get(itemKey(item)) === Number(item.quantity));
};

export const findMatchingShipment = async ({ storeId, apiKey, orderId, payload }) => {
    const data = await listOrderShipments({ storeId, apiKey, orderId });
    const shipment = (data?.shipments || []).find((candidate) => (
        normalizeComparable(candidate.tracking_number) === normalizeComparable(payload.tracking_number)
        && normalizeComparable(candidate.carrier_code) === normalizeComparable(payload.carrier_code)
        && lineItemsMatch(payload.order_items, candidate.order_items)
    ));
    return shipment || null;
};
