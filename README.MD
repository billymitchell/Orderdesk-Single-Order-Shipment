# Orderdesk Shipping API

This project is an API designed to process shipping orders for multiple stores using [Express](https://expressjs.com). It securely manages store-specific API keys through environment variables and integrates with the [OrderDesk API](https://orderdesk.com/) to fetch order details and post shipment information.

## Features

- Processes shipping orders for multiple stores.
- Queues incoming shipments in memory and processes them in the background.
- Fetches order details from the OrderDesk API.
- Posts shipment details to the OrderDesk API in batches per store.
- Respects Order Desk API rate limits with per-store token-bucket limiting and automatic retries on 429.
- Validates request payloads for correctness.
- Handles errors gracefully with middleware.
- Responds immediately to API requests while processing shipments asynchronously.

## Project Structure

- **index.js**:  
  The main entry point of the application. It initializes the Express server, sets up middleware, and defines the API routes and background queue processor.

- **.env**:  
  Stores environment variables such as API keys for each store (e.g., `STORE_21633`, `STORE_40348`, etc.) and the server port.

- **package.json**:  
  Defines project metadata and dependencies, including:
  - `express`: Web framework for building the API.
  - `node-fetch`: Used for making HTTP requests to the OrderDesk API.
  - `dotenv`: Loads environment variables from a `.env` file.
  - `body-parser`: Middleware for parsing JSON request bodies.
  - `p-limit`: Controls concurrency for background processing.

## How It Works

1. **API receives shipment data** via POST `/` (single object or array).
2. **Shipments are added to an in-memory queue**. The API immediately responds with a `202 Accepted` status and a message indicating the shipments are queued for processing.
3. **A background process runs every 5 seconds** to process the queue:
   - Shipments are grouped by store.
   - For each shipment, the app fetches order details from OrderDesk.
   - Shipments are posted in batches to OrderDesk per store.
   - Results and errors are logged to the console (not returned to the original API caller).
4. **Errors in processing** are logged, but do not affect the API response to the client.

### Order Desk Rate Limits (New)

Order Desk recently introduced rate limits. This app follows their guidance:

- Leaky bucket per store: initial 20 tokens, refills at 3 requests/second (≈100 requests per rolling 30s)
- We read the response headers:
  - `X-Tokens-Remaining` (or `X-Tokens-Available`): remaining tokens
  - `X-Retry-After`: seconds to pause when burst protection kicks in
- Behavior on 429 Too Many Requests:
  - We pause the affected store's requests for `X-Retry-After` seconds (with slight jitter) and retry with backoff
  - Max 5 retry attempts per request (configurable)
- GET requests do not send `Content-Type` headers per Order Desk docs.

Implementation details:

- Centralized `odFetch` wrapper handles headers, per-store Bottleneck limiter, and 429/backoff
- The limiter settings are: reservoir=20, reservoirIncreaseAmount=3, reservoirIncreaseInterval=1000ms, reservoirIncreaseMaximum=20, maxConcurrent=3

Reference: https://apidocs.orderdesk.com/#rate-limits

Environment flags for logging:

- `RATE_LIMIT_LOG`: one of `off`, `warn` (default), or `verbose`
  - `warn`: warns when tokens fall below threshold and logs 429 blocks as errors
  - `verbose`: logs token counts after each request
  - `off`: disables rate-limit token logs (still logs 429 errors)
- `RATE_LIMIT_WARN_TOKENS`: integer threshold (default 5) at or below which a warning is emitted

## API Endpoints

### POST `/`
Queues shipping orders for one or more stores for background processing.

#### Request Body
The request body should be a JSON object or an array of objects with the following fields:
- `tracking_number` (string): The tracking number for the shipment.
- `shipment_date` (string): The shipment date in ISO 8601 format (e.g., `YYYY-MM-DD`).
- `order_number` (string): The order number, which includes the store ID as a prefix (e.g., `21633-001`).

#### Example Request
```json
{
  "tracking_number": "123456789",
  "shipment_date": "2025-04-21",
  "order_number": "21633-001"
}
```

#### Example Response
- **Accepted (202)**:
  ```json
  {
    "message": "Shipments queued for processing"
  }
  ```
- **Error (400)**:
  ```json
  {
    "message": "Invalid request payload"
  }
  ```

> **Note:** The API does not return the result of shipment processing in the response. Processing happens asynchronously in the background. Check server logs for processing results and errors.

## Setup & Installation

1. **Clone the Repository:**  
   ```sh
   git clone <repository-url>
   cd Orderdesk
   ```

2. **Install Dependencies:**  
   Run the following command to install dependencies:
   ```sh
   npm install
   ```

3. **Set Up Environment Variables:**  
   Create a `.env` file in the root directory and add the following variables:
   ```env
   PORT=3000
   STORE_21633=<API_KEY_FOR_STORE_21633>
   STORE_40348=<API_KEY_FOR_STORE_40348>
   # Add API keys for other stores as needed
   ```

4. **Start the Server:**  
   Run the following command to start the server:
   ```sh
   npm start
   ```
   The server will run on `http://localhost:3000` by default.

## Dependencies

- [Express](https://expressjs.com): Web framework for building the API.
- [node-fetch](https://www.npmjs.com/package/node-fetch): For making HTTP requests.
- [dotenv](https://www.npmjs.com/package/dotenv): For managing environment variables.
- [body-parser](https://www.npmjs.com/package/body-parser): Middleware for parsing JSON request bodies.
- [p-limit](https://www.npmjs.com/package/p-limit): Controls concurrency for background processing.
- [Bottleneck](https://www.npmjs.com/package/bottleneck): Token bucket rate limiter used to comply with Order Desk limits.

## Notes

- Ensure that all required environment variables are set in the `.env` file before starting the server.
- The API queues shipments and processes them asynchronously. The response only confirms queuing, not processing.
- Processing results and errors are logged to the server console.
- The in-memory queue is volatile: if the server restarts, queued shipments are lost.

## License

This project is licensed under the [MIT License](LICENSE).