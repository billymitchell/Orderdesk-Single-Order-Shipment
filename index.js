import express from 'express';
import bodyParser from 'body-parser';
import 'dotenv/config';
import fetch from 'node-fetch';

// Store keys with their corresponding API keys and store names
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
    { STORE_ID: "118741", API_KEY: process.env.STORE_118741, STORE_NAME: "Store AB" } // Placeholder for any unmatched store
];

// Helper function to find a store by its ID
const findStore = (storeId) => store_key.find(store => store.STORE_ID === storeId);

// Fetch order details from OrderDesk API
const fetchOrder = async (storeId, apiKey, sourceId) => {
    const response = await fetch(`https://app.orderdesk.me/api/v2/orders?source_id=${sourceId}`, {
        method: "GET",
        headers: {
            "ORDERDESK-STORE-ID": storeId,
            "ORDERDESK-API-KEY": apiKey,
            "Content-Type": "application/json"
        }
    });

    const responseData = await response.json();
    console.log(`fetchOrder response for storeId ${storeId}, sourceId ${sourceId}:`, responseData);

    if (response.ok && responseData.orders && responseData.orders.length > 0) {
        const orderId = responseData.orders[0].id; // Extract the order ID
        console.log(`Extracted order ID: ${orderId}`);
        return orderId; // Return the extracted order ID
    } else {
        throw new Error(`Failed to fetch order details: ${responseData.message || 'Unknown error'}`);
    }
};

// Post multiple shipment details to OrderDesk API
const postShipments = async (storeId, apiKey, shipments) => {
    console.log("Sending shipments to OrderDesk batch-shipments endpoint:", { storeId, shipments });

    const response = await fetch(`https://app.orderdesk.me/api/v2/batch-shipments`, {
        method: "POST",
        headers: {
            "ORDERDESK-STORE-ID": storeId,
            "ORDERDESK-API-KEY": apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(shipments) // Send shipments as an array
    });

    const responseData = await response.json();
    console.log("OrderDesk API response:", responseData);

    return response.ok ? responseData : Promise.reject(responseData);
};

// Initialize Express app
const app = express();
app.use(bodyParser.json()); // Middleware to parse JSON request bodies

// Middleware to validate request payloads
app.use((req, res, next) => {
    if (!req.body || (!Array.isArray(req.body) && typeof req.body !== 'object')) {
        return res.status(400).json({ message: 'Invalid request payload' });
    }
    next();
});

// Wrapper for handling async errors in route handlers
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// POST endpoint to process orders
app.post('/', asyncHandler(async (req, res) => {
    const shipments = Array.isArray(req.body) ? req.body : [req.body]; // Ensure shipments is an array
    const results = [];

    // Group shipments by store ID
    const shipmentsByStore = {};

    for (const shipment of shipments) {
        const { source_id, tracking_number, carrier_code, shipment_method } = shipment;
        const [storeId] = source_id.split('-'); // Extract store ID from order ID

        // Find the store by its ID
        const store = findStore(storeId);
        if (!store) {
            results.push({ shipment, error: `Invalid store ID: ${storeId}` });
            continue;
        }

        const { API_KEY: apiKey } = store;
        if (!apiKey) {
            results.push({ shipment, error: `API key not found for store ID: ${storeId}` });
            continue;
        }

        try {
            // Fetch order details from OrderDesk
            const orderId = await fetchOrder(storeId, apiKey, source_id);
            console.log(`Fetched Order ID for source_id ${source_id}: ${orderId}`);

            // Prepare the shipment payload
            const shipmentPayload = {
                order_id: orderId, // Use the fetched order ID
                tracking_number,
                carrier_code,
                shipment_method
            };

            // Group shipments by store ID
            if (!shipmentsByStore[storeId]) {
                shipmentsByStore[storeId] = { apiKey, shipments: [] };
            }
            shipmentsByStore[storeId].shipments.push(shipmentPayload);
        } catch (error) {
            results.push({ shipment, error: error.message || 'Unknown error' });
        }
    }

    // Send shipments to OrderDesk grouped by store
    for (const storeId in shipmentsByStore) {
        const { apiKey, shipments } = shipmentsByStore[storeId];
        try {
            const postResponse = await postShipments(storeId, apiKey, shipments);
            results.push({ storeId, postResponse });
        } catch (error) {
            results.push({ storeId, error: error.message || 'Failed to post shipments' });
        }
    }

    // Respond with the results
    res.status(200).json({
        message: 'Shipments processed',
        results
    });
}));

// Error-handling middleware for catching unhandled errors
app.use((err, req, res, next) => {
    console.error(err.stack); // Log the error stack trace
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
});

// Start the server on the specified port
const port = process.env.PORT || 4000;
app.listen(port, () => {
    console.log(`Server running on port ${port}: http://localhost:${port}`);
});