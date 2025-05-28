///////////////////////////////////////////////////////////////////////////////
// SECTION 1: Store Configuration & Helper Functions
///////////////////////////////////////////////////////////////////////////////
import express from 'express';
import bodyParser from 'body-parser';
import 'dotenv/config';
import fetch from 'node-fetch';
import pLimit from 'p-limit';

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

/**
 * Fetch order details from OrderDesk using source ID.
 * Logs detailed responses and errors.
 */
const fetchOrder = async (storeId, apiKey, sourceId) => {
    try {
        const response = await fetch(`https://app.orderdesk.me/api/v2/orders?source_id=${sourceId}`, {
            method: "GET",
            headers: {
                "ORDERDESK-STORE-ID": storeId,
                "ORDERDESK-API-KEY": apiKey,
                "Content-Type": "application/json"
            }
        });
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
        const response = await fetch(`https://app.orderdesk.me/api/v2/batch-shipments`, {
            method: "POST",
            headers: {
                "ORDERDESK-STORE-ID": storeId,
                "ORDERDESK-API-KEY": apiKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(shipments)
        });
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