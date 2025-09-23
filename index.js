///////////////////////////////////////////////////////////////////////////////
// SECTION 1: Store Configuration & Helper Functions
///////////////////////////////////////////////////////////////////////////////
import express from 'express';
import bodyParser from 'body-parser';
import 'dotenv/config';
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import Bottleneck from 'bottleneck';

const store_key = [
    { STORE_ID: "21633", API_KEY: process.env.STORE_21633, STORE_NAME: "Amentum Inventory" },
    { STORE_ID: "40348", API_KEY: process.env.STORE_40348, STORE_NAME: "Amentum Safety" },
    { STORE_ID: "12803", API_KEY: process.env.STORE_12803, STORE_NAME: "ASE" },
    { STORE_ID: "9672", API_KEY: process.env.STORE_9672, STORE_NAME: "Bon Appetit" },
    { STORE_ID: "47219", API_KEY: process.env.STORE_47219, STORE_NAME: "Bon Appetit Nudge" },
    { STORE_ID: "8366", API_KEY: process.env.STORE_8366, STORE_NAME: "BPA Store" },
    { STORE_ID: "16152", API_KEY: process.env.STORE_16152, STORE_NAME: "Chartwells K12 Nudge" },
    { STORE_ID: "8466", API_KEY: process.env.STORE_8466, STORE_NAME: "Compass Catalog" },
    { STORE_ID: "15521", API_KEY: process.env.STORE_15521, STORE_NAME: "Cuilinart Nudge" },
    { STORE_ID: "24121", API_KEY: process.env.STORE_24121, STORE_NAME: "EDTA Inventory" },
    { STORE_ID: "14077", API_KEY: process.env.STORE_14077, STORE_NAME: "Eurest Hero" },
    { STORE_ID: "12339", API_KEY: process.env.STORE_12339, STORE_NAME: "Eurest Nudge" },
    { STORE_ID: "43379", API_KEY: process.env.STORE_43379, STORE_NAME: "FBLA" },
    { STORE_ID: "9369", API_KEY: process.env.STORE_9369, STORE_NAME: "FCCLA" },
    { STORE_ID: "9805", API_KEY: process.env.STORE_9805, STORE_NAME: "Flik" },
    { STORE_ID: "67865", API_KEY: process.env.STORE_67865, STORE_NAME: "Flik PSR" },
    { STORE_ID: "48371", API_KEY: process.env.STORE_48371, STORE_NAME: "Forbes Brand Store" },
    { STORE_ID: "48551", API_KEY: process.env.STORE_48551, STORE_NAME: "Forbes Redemption" },
    { STORE_ID: "110641", API_KEY: process.env.STORE_110641, STORE_NAME: "Keystone Redemption" },
    { STORE_ID: "41778", API_KEY: process.env.STORE_41778, STORE_NAME: "Marriot Store" },
    { STORE_ID: "8267", API_KEY: process.env.STORE_8267, STORE_NAME: "NRA Competitive Shooting" },
    { STORE_ID: "75092", API_KEY: process.env.STORE_75092, STORE_NAME: "Phi Kappa Phi" },
    { STORE_ID: "8402", API_KEY: process.env.STORE_8402, STORE_NAME: "Ryder FMS" },
    { STORE_ID: "68125", API_KEY: process.env.STORE_68125, STORE_NAME: "Ryder SCS" },
    { STORE_ID: "8729", API_KEY: process.env.STORE_8729, STORE_NAME: "SkillsUSA" },
    { STORE_ID: "47257", API_KEY: process.env.STORE_47257, STORE_NAME: "Springs Living" },
    { STORE_ID: "8636", API_KEY: process.env.STORE_8636, STORE_NAME: "TSA" },
    { STORE_ID: "118741", API_KEY: process.env.STORE_118741, STORE_NAME: "Store AB" }
];

/**
 * Lookup a store's configuration using its store ID.
 */
const findStore = (storeId) => {
    const store = store_key.find(store => store.STORE_ID === storeId);
    if (!store) {
        console.warn(`[findStore] Store with ID ${storeId} not found.`);
    }
    return store;
};

///////////////////////////////////////////////////////////////////////////////
// SECTION 1b: Order Desk Fetch with Rate Limiting & Retry
///////////////////////////////////////////////////////////////////////////////

// Per-store limiters following Order Desk docs (leaky bucket):
// - Initial bucket size: 20
// - Refill: +3 tokens per second
// - Burst protection via 429 + X-Retry-After
const storeLimiters = new Map();

const getStoreLimiter = (storeId) => {
    if (!storeLimiters.has(storeId)) {
        const limiter = new Bottleneck({
            reservoir: 20, // initial tokens
            reservoirIncreaseAmount: 3,
            reservoirIncreaseInterval: 1000, // ms
            reservoirIncreaseMaximum: 20, // cap burst bucket at 20
            maxConcurrent: 3 // keep a small concurrency per store
        });
        storeLimiters.set(storeId, limiter);
    }
    return storeLimiters.get(storeId);
};

// Utility delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Configurable logging flags
const RATE_LIMIT_WARN_TOKENS = Number.isFinite(parseInt(process.env.RATE_LIMIT_WARN_TOKENS, 10))
    ? parseInt(process.env.RATE_LIMIT_WARN_TOKENS, 10)
    : 5;
// off | warn | verbose
const RATE_LIMIT_LOG = (process.env.RATE_LIMIT_LOG || 'warn').toLowerCase();

/**
 * Centralized fetch wrapper for Order Desk with per-store rate limiting,
 * 429 handling (X-Retry-After), and header normalization.
 */
const odFetch = async ({ storeId, apiKey, url, method = 'GET', body, extraHeaders = {}, maxRetries = 5 }) => {
    const limiter = getStoreLimiter(storeId);

    const makeRequest = async () => {
        const headers = {
            'ORDERDESK-STORE-ID': storeId,
            'ORDERDESK-API-KEY': apiKey,
            // Only send Content-Type when there is a body (non-GET per docs)
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...extraHeaders
        };

        const res = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });

        const tokensHeader = res.headers.get('x-tokens-remaining') ?? res.headers.get('x-tokens-available');
        if (tokensHeader !== null && tokensHeader !== undefined) {
            const tokensRemaining = parseInt(tokensHeader, 10);
            const info = `${method} ${url}`;
            if (RATE_LIMIT_LOG === 'verbose') {
                console.info(`[RateLimit] store=${storeId} tokens=${tokensHeader} after ${info}`);
            }
            if (Number.isFinite(tokensRemaining)) {
                if (tokensRemaining <= 0) {
                    console.error(`[RateLimit OVERAGE] store=${storeId} tokens=0 at ${info}`);
                } else if (RATE_LIMIT_LOG !== 'off' && tokensRemaining <= RATE_LIMIT_WARN_TOKENS) {
                    console.warn(`[RateLimit Warning] store=${storeId} tokens=${tokensRemaining} (<= ${RATE_LIMIT_WARN_TOKENS}) at ${info}`);
                }
            }
        }

        return res;
    };

    let attempt = 0;
    while (true) {
        try {
            const response = await limiter.schedule(() => makeRequest());

            if (response.status !== 429) {
                return response;
            }

            // 429 handling
            const retryAfterHeader = response.headers.get('x-retry-after');
            const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
            const baseDelayMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000; // default 2s
            attempt += 1;
            if (attempt > maxRetries) {
                const text = await response.text().catch(() => '');
                throw new Error(`429 Too Many Requests after ${maxRetries} retries. Last body: ${text}`);
            }
            const jitter = Math.floor(Math.random() * 300);
            const delay = baseDelayMs + jitter;
            console.error(`[RateLimit OVERAGE] 429 block: store=${storeId} retry_after=${retryAfterHeader ?? 'n/a'}s attempt=${attempt}/${maxRetries} waiting_ms=${delay} method=${method} url=${url}`);
            await sleep(delay);
            continue;
        } catch (err) {
            // Network or other errors: retry with backoff up to maxRetries
            attempt += 1;
            if (attempt > maxRetries) {
                throw err;
            }
            const delay = Math.min(30000, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 250);
            console.warn(`[odFetch] Error attempt ${attempt}/${maxRetries} for store ${storeId}: ${err.message}. Retrying in ${delay}ms`);
            await sleep(delay);
        }
    }
};

/**
 * Fetch order details from OrderDesk using source ID.
 * Logs detailed responses and errors.
 */
const fetchOrder = async (storeId, apiKey, sourceId) => {
    try {
        const url = `https://app.orderdesk.me/api/v2/orders?source_id=${encodeURIComponent(sourceId)}`;
        const response = await odFetch({ storeId, apiKey, url, method: 'GET' });
        const responseData = await response.json();
        console.info(`[fetchOrder] Response for storeId ${storeId}, sourceId ${sourceId}:`, responseData);
        if (response.ok && responseData.orders && responseData.orders.length > 0) {
            const orderId = responseData.orders[0].id;
            console.info(`[fetchOrder] Extracted order ID: ${orderId}`);
            return orderId;
        } else {
            console.error(`[fetchOrder] Error: Failed to fetch order details for storeId ${storeId}, sourceId ${sourceId}`, responseData);
            throw new Error(`Failed to fetch order details: ${responseData.message || 'Unknown error'}`);
        }
    } catch (err) {
        console.error(`[fetchOrder] Exception for storeId ${storeId}, sourceId ${sourceId}:`, err);
        throw err;
    }
};

/**
 * Post a batch of shipments to OrderDesk.
 * Returns API response or rejects if error.
 */
const postShipments = async (storeId, apiKey, shipments) => {
    try {
        console.info(`[postShipments] Sending shipments for storeId ${storeId}:`, shipments);
        const url = `https://app.orderdesk.me/api/v2/batch-shipments`;
        const response = await odFetch({ storeId, apiKey, url, method: 'POST', body: shipments });
        const responseData = await response.json();
        console.info(`[postShipments] API response for storeId ${storeId}:`, responseData);
        if (response.ok) {
            return responseData;
        } else {
            console.error(`[postShipments] Error response for storeId ${storeId}:`, responseData);
            return Promise.reject(responseData);
        }
    } catch (err) {
        console.error(`[postShipments] Exception for storeId ${storeId}:`, err);
        throw err;
    }
};

///////////////////////////////////////////////////////////////////////////////
// SECTION 2: In-Memory Queue & Background Processing
///////////////////////////////////////////////////////////////////////////////

// In-memory queue for shipments (volatile).
let shipmentsQueue = [];

/**
 * Add shipments to the in-memory queue.
 */
const addShipmentsToQueue = (shipments) => {
    shipments.forEach(shipment => shipmentsQueue.push(shipment));
    console.info(`[addShipmentsToQueue] Queue length: ${shipmentsQueue.length}`);
};

/**
 * Process the in-memory queue.
 * - Uses pLimit to restrict concurrency.
 * - Groups shipments by store and posts in batches.
 */
const processQueue = async () => {
    if (shipmentsQueue.length === 0) return;
    
    console.info('[processQueue] Shipments found in queue. Processing...');
    const queuedShipments = shipmentsQueue.splice(0); // Clear queue snapshot.
    const limit = pLimit(10);
    const results = [];
    const shipmentsByStore = {};
    
    await Promise.all(queuedShipments.map(shipment => limit(async () => {
        const { source_id, tracking_number, carrier_code, shipment_method } = shipment;
        const [storeId] = source_id.split('-');
        const store = findStore(storeId);
        if (!store) {
            const errMsg = `Invalid store ID: ${storeId}`;
            console.error(`[processQueue] ${errMsg}`, shipment);
            results.push({ shipment, error: errMsg });
            return;
        }
        const { API_KEY: apiKey } = store;
        if (!apiKey) {
            const errMsg = `API key not found for store ID: ${storeId}`;
            console.error(`[processQueue] ${errMsg}`, shipment);
            results.push({ shipment, error: errMsg });
            return;
        }
        try {
            // Retrieve order details.
            const orderId = await fetchOrder(storeId, apiKey, source_id);
            console.info(`[processQueue] Fetched Order ID for source_id ${source_id}: ${orderId}`);
            const shipmentPayload = { order_id: orderId, tracking_number, carrier_code, shipment_method };
            if (!shipmentsByStore[storeId]) {
                shipmentsByStore[storeId] = { apiKey, shipments: [] };
            }
            shipmentsByStore[storeId].shipments.push(shipmentPayload);
        } catch (error) {
            console.error(`[processQueue] Error processing shipment with source_id ${source_id}:`, error);
            results.push({ shipment, error: error.message || 'Unknown error' });
        }
    })));
    
    // Batch post shipments grouped by store.
    for (const storeId in shipmentsByStore) {
        const { apiKey, shipments } = shipmentsByStore[storeId];
        try {
            const postResponse = await postShipments(storeId, apiKey, shipments);
            console.info(`[processQueue] Successfully posted shipments for storeId ${storeId}`);
            results.push({ storeId, postResponse });
        } catch (error) {
            console.error(`[processQueue] Failed to post shipments for storeId ${storeId}:`, error);
            results.push({ storeId, error: error.message || 'Failed to post shipments' });
        }
    }
    console.info('[processQueue] Completed processing with results:', results);
};

// Run the background processor every 5 seconds.
setInterval(processQueue, 5000);

///////////////////////////////////////////////////////////////////////////////
// SECTION 3: Express Server Setup
///////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(bodyParser.json());

// Middleware: Validate incoming request payload.
app.use((req, res, next) => {
    if (!req.body || (!Array.isArray(req.body) && typeof req.body !== 'object')) {
        console.error('[Middleware] Invalid request payload:', req.body);
        return res.status(400).json({ message: 'Invalid request payload' });
    }
    next();
});

// Async wrapper for route error handling.
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// POST Endpoint: Add shipments to the in-memory queue.
app.post('/', asyncHandler(async (req, res) => {
    console.info('[POST /] Received:', req.body);
    const shipments = Array.isArray(req.body) ? req.body : [req.body];
    addShipmentsToQueue(shipments);
    console.info(`[POST /] Shipments queued. Total in queue: ${shipmentsQueue.length}`);
    res.status(202).json({ message: 'Shipments queued for processing' });
}));

// Global Error Handling Middleware.
app.use((err, req, res, next) => {
    console.error('[Global Error] Encountered:', err.stack);
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
});

// Start the Express server.
const port = process.env.PORT || 4000;
app.listen(port, () => {
    console.info(`[Server] Running on port ${port}.`);
});