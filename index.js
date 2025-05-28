import express from 'express';
import bodyParser from 'body-parser';
import 'dotenv/config';
import fetch from 'node-fetch';
import cluster from 'cluster';
import os from 'os';
import pLimit from 'p-limit';

//
// Store configuration: Map store IDs to API keys and store names
//
let store_key = [
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
    { STORE_ID: "118741", API_KEY: process.env.STORE_118741, STORE_NAME: "Store AB" } // Placeholder for unmatched store
];

//
// Helper function to find a store by its ID
//
const findStore = (storeId) => store_key.find(store => store.STORE_ID === storeId);

//
// Function: fetchOrder
// Description: Fetches order details from the OrderDesk API using source_id
// Logs the API response and errors in detail.
// Throws an error if the order details are not retrievable.
//
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
        console.log(`[fetchOrder] Response for storeId ${storeId}, sourceId ${sourceId}:`, responseData);
    
        if (response.ok && responseData.orders && responseData.orders.length > 0) {
            const orderId = responseData.orders[0].id; // Extract the order ID
            console.log(`[fetchOrder] Extracted order ID: ${orderId}`);
            return orderId;
        } else {
            // Include full response data in error logging for troubleshooting
            console.error(`[fetchOrder] Error: Failed to fetch order details for storeId ${storeId}, sourceId ${sourceId}`, responseData);
            throw new Error(`Failed to fetch order details: ${responseData.message || 'Unknown error'}`);
        }
    } catch (err) {
        console.error(`[fetchOrder] Exception caught for storeId ${storeId}, sourceId ${sourceId}:`, err);
        throw err;
    }
};

//
// Function: postShipments
// Description: Posts multiple shipment details to the OrderDesk API in a batch.
// Logs success and detailed error responses.
// Returns the API response or rejects with an error.
//
const postShipments = async (storeId, apiKey, shipments) => {
    try {
        console.log(`[postShipments] Sending shipments for storeId ${storeId}:`, shipments);
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
        console.log(`[postShipments] OrderDesk API response for storeId ${storeId}:`, responseData);
    
        if (response.ok) {
            return responseData;
        } else {
            console.error(`[postShipments] Error response for storeId ${storeId}:`, responseData);
            return Promise.reject(responseData);
        }
    } catch (err) {
        console.error(`[postShipments] Exception caught for storeId ${storeId}:`, err);
        throw err;
    }
};

//
// Express app and Middleware setup
//
const app = express();

// Use bodyParser to parse incoming JSON payloads
app.use(bodyParser.json());

// Validate incoming request payloads
app.use((req, res, next) => {
    if (!req.body || (!Array.isArray(req.body) && typeof req.body !== 'object')) {
        console.error('[Payload Validation] Invalid request payload:', req.body);
        return res.status(400).json({ message: 'Invalid request payload' });
    }
    next();
});

// Wrapper for async route handlers to catch errors and pass them to error-handling middleware
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

//
// POST Endpoint: Process orders and shipments
// Description: Processes incoming shipment(s), groups them by store, and sends batch shipment updates.
// Logs each step for clarity and troubleshooting. Uses a concurrency limiter to process shipment items.
// This approach helps avoiding overloading the server when hundreds of requests happen in rapid succession.
//
app.post('/', asyncHandler(async (req, res) => {
    console.log('[POST /] Received request:', req.body);
    const shipments = Array.isArray(req.body) ? req.body : [req.body]; // Ensure shipments is an array

    // Concurrency limiter to restrict simultaneous external API calls.
    // Adjust the concurrency value (e.g., 10) as needed.
    const limit = pLimit(10);

    // Temporary storage for results and grouped shipments
    const results = [];
    const shipmentsByStore = {};

    // Process each shipment concurrently with the limiter.
    await Promise.all(shipments.map(shipment => limit(async () => {
        const { source_id, tracking_number, carrier_code, shipment_method } = shipment;
        const [storeId] = source_id.split('-'); // Extract store ID from order ID
        
        // Find the store by its ID
        const store = findStore(storeId);
        if (!store) {
            const errMsg = `Invalid store ID: ${storeId}`;
            console.error(`[POST /] ${errMsg}`, shipment);
            results.push({ shipment, error: errMsg });
            return;
        }
    
        const { API_KEY: apiKey } = store;
        if (!apiKey) {
            const errMsg = `API key not found for store ID: ${storeId}`;
            console.error(`[POST /] ${errMsg}`, shipment);
            results.push({ shipment, error: errMsg });
            return;
        }
    
        try {
            // Fetch order details using OrderDesk API
            const orderId = await fetchOrder(storeId, apiKey, source_id);
            console.log(`[POST /] Fetched Order ID for source_id ${source_id}: ${orderId}`);
    
            // Build the shipment payload for the batch API
            const shipmentPayload = {
                order_id: orderId,
                tracking_number,
                carrier_code,
                shipment_method
            };
    
            // Group shipments by store ID for batch processing
            if (!shipmentsByStore[storeId]) {
                shipmentsByStore[storeId] = { apiKey, shipments: [] };
            }
            shipmentsByStore[storeId].shipments.push(shipmentPayload);
        } catch (error) {
            console.error(`[POST /] Error processing shipment with source_id ${source_id}:`, error);
            results.push({ shipment, error: error.message || 'Unknown error' });
        }
    })));

    console.log(`[POST /] Completed processing individual shipments. Grouped shipments:`, shipmentsByStore);
    
    // Process posting grouped shipments for each store.
    for (const storeId in shipmentsByStore) {
        const { apiKey, shipments } = shipmentsByStore[storeId];
        try {
            const postResponse = await postShipments(storeId, apiKey, shipments);
            console.log(`[POST /] Successfully posted shipments for storeId ${storeId}`);
            results.push({ storeId, postResponse });
        } catch (error) {
            console.error(`[POST /] Failed to post shipments for storeId ${storeId}:`, error);
            results.push({ storeId, error: error.message || 'Failed to post shipments' });
        }
    }
    
    // Final response with detailed results
    console.log('[POST /] Final results:', results);
    res.status(200).json({
        message: 'Shipments processed',
        results
    });
}));

//
// Global Error Handling Middleware
// Logs full error stack and responds with a standardized error message.
//
app.use((err, req, res, next) => {
    console.error('[Global Error Handling] Error encountered:', err.stack);
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
});

//
// Clustering Setup to Utilize Available CPU Cores
//
if (cluster.isMaster) {
    const numCPUs = os.cpus().length;
    console.log(`[Cluster] Master ${process.pid} is running. Forking ${numCPUs} workers.`);
    
    // Fork worker processes
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }
    
    // Listen for dying workers and replace them
    cluster.on('exit', (worker, code, signal) => {
        console.error(`[Cluster] Worker ${worker.process.pid} died (code: ${code}, signal: ${signal}). Restarting...`);
        cluster.fork();
    });
} else {
    // Start the server for worker processes
    const port = process.env.PORT || 4000;
    app.listen(port, () => {
        console.log(`[Server] Worker ${process.pid} running on port ${port}. Access at http://localhost:${port}`);
    });
}