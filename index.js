import express from 'express';
import bodyParser from 'body-parser';
import 'dotenv/config';
import fetch from 'node-fetch';

// Store keys with their corresponding API keys loaded from environment variables
let store_key = [
    { STORE_ID: "21633", API_KEY: process.env.STORE_21633 },
    { STORE_ID: "40348", API_KEY: process.env.STORE_40348 },
    { STORE_ID: "12803", API_KEY: process.env.STORE_12803 },
    { STORE_ID: "9672", API_KEY: process.env.STORE_9672 },
    { STORE_ID: "47219", API_KEY: process.env.STORE_47219 },
    { STORE_ID: "8366", API_KEY: process.env.STORE_8366 },
    { STORE_ID: "16152", API_KEY: process.env.STORE_16152 },
    { STORE_ID: "8466", API_KEY: process.env.STORE_8466 },
    { STORE_ID: "15521", API_KEY: process.env.STORE_15521 },
    { STORE_ID: "24121", API_KEY: process.env.STORE_24121 },
    { STORE_ID: "14077", API_KEY: process.env.STORE_14077 },
    { STORE_ID: "12339", API_KEY: process.env.STORE_12339 },
    { STORE_ID: "43379", API_KEY: process.env.STORE_43379 },
    { STORE_ID: "9369", API_KEY: process.env.STORE_9369 },
    { STORE_ID: "9805", API_KEY: process.env.STORE_9805 },
    { STORE_ID: "67865", API_KEY: process.env.STORE_67865 },
    { STORE_ID: "48371", API_KEY: process.env.STORE_48371 },
    { STORE_ID: "48551", API_KEY: process.env.STORE_48551 },
    { STORE_ID: "110641", API_KEY: process.env.STORE_110641 },
    { STORE_ID: "41778", API_KEY: process.env.STORE_41778 },
    { STORE_ID: "8267", API_KEY: process.env.STORE_8267 },
    { STORE_ID: "75092", API_KEY: process.env.STORE_75092 },
    { STORE_ID: "8402", API_KEY: process.env.STORE_8402 },
    { STORE_ID: "68125", API_KEY: process.env.STORE_68125 },
    { STORE_ID: "8729", API_KEY: process.env.STORE_8729 },
    { STORE_ID: "47257", API_KEY: process.env.STORE_47257 },
    { STORE_ID: "8636", API_KEY: process.env.STORE_8636 },
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
    // Return the response JSON if successful, otherwise reject with the error response
    return response.ok ? response.json() : Promise.reject(await response.json());
};

// Post shipment details to OrderDesk API
const postShipment = async (storeId, apiKey, orderId, postBody) => {
    const response = await fetch(`https://app.orderdesk.me/api/v2/orders/${orderId}/shipments`, {
        method: "POST",
        headers: {
            "ORDERDESK-STORE-ID": storeId,
            "ORDERDESK-API-KEY": apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(postBody)
    });
    // Return the response JSON
    return response.json();
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
    const orders = Array.isArray(req.body) ? req.body : [req.body]; // Ensure orders is an array
    const results = [];

    // Process orders one at a time sequentially
    for (const order of orders) {
        const result = await processOrder(order); // Process the order
        results.push(result); // Collect the result
        if (result.error) {
            // Stop processing further orders if an error occurs
            return res.status(400).json({
                message: 'Not OKAY',
                results
            });
        }
    }

    // If all orders are processed successfully
    res.status(200).json({
        message: 'Orders processed',
        results
    });
}));

// Function to process a single order
const processOrder = async (orderPayload) => {
    const { tracking_number, shipment_date, order_number } = orderPayload;
    const [storeId] = order_number.split('-'); // Extract store ID from order number
    const sourceId = order_number;

    // Find the store by its ID
    const store = findStore(storeId);
    if (!store) return { order: orderPayload, error: 'Invalid store ID' };

    const { API_KEY: apiKey } = store;
    if (!apiKey) return { order: orderPayload, error: 'API key not found for the store' };

    try {
        // Fetch order details from OrderDesk
        const orderData = await fetchOrder(storeId, apiKey, sourceId);
        const order = orderData.orders?.[0]; // Get the first order from the response
        if (!order || !order.id) return { order: orderPayload, error: 'Order not found or invalid' };

        // Extract carrier code and shipment method from the shipping method
        const [carrier_code, shipment_method] = (order.shipping_method || '').split(' ');
        if (!carrier_code || !shipment_method) {
            return { order: orderPayload, error: 'Invalid shipping_method format' };
        }

        // Prepare the shipment payload
        const postBody = { tracking_number, carrier_code, shipment_method, shipment_date };
        // Post the shipment details to OrderDesk
        const postResponse = await postShipment(storeId, apiKey, order.id, postBody);

        // Return the processed order details
        return { order: orderPayload, getResponse: orderData, postResponse };
    } catch (error) {
        // Handle errors during order processing
        return { order: orderPayload, error: error.message || 'Unknown error' };
    }
};

// Error-handling middleware for catching unhandled errors
app.use((err, req, res, next) => {
    console.error(err.stack); // Log the error stack trace
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
});

// Start the server on the specified port
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}: http://localhost:${port}`);
});