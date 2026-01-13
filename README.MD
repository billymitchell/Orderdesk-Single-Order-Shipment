# Orderdesk Shipping API

This API accepts shipment notifications, looks up orders in Order Desk, and posts shipment updates, all while respecting Order Desk’s per-store rate limits. It’s built with [Express](https://expressjs.com), uses [Bottleneck](https://www.npmjs.com/package/bottleneck) for rate limiting, and [p-limit](https://www.npmjs.com/package/p-limit) for controlled concurrency.

## At a glance

- Accepts POSTs with shipments (single or array)
- Queues shipments in memory and processes in the background
- For each shipment: fetch order (by source_id) → build payload → batch-post per store
- Per-store rate limiter mirrors Order Desk limits and handles 429 retry logic
- Returns 202 immediately; processing continues asynchronously

## Project structure

- `index.js` — server, queue, rate limiting, Order Desk requests
- `.env` — environment variables (store API keys, PORT, logs)
- `package.json` — dependencies and scripts

## End-to-end flow (verbose)

1) Ingest
- Endpoint: POST `/`
- Payload: single shipment object or an array of shipment objects
- The request is validated to be an object or array (basic shape check). If invalid, returns 400.
- On success, the shipments are appended to an in-memory queue and the API responds `202 Accepted` immediately.

2) Background processor (every 5 seconds)
- Takes a snapshot of the queue (empties the queue immediately for processing) and works on that copy.
- Uses `p-limit(10)` to cap parallel work when fetching orders across all shipments.
- For each shipment (in parallel, up to 10 at a time):
  - Extract storeId from `source_id` by splitting on `-` (prefix must be the numeric store ID, e.g., `21633-...`).
  - Look up the store in a static table and read its API key from environment variables.
  - Call Order Desk GET `/api/v2/orders?source_id=...` to resolve the Order Desk `order_id`.
  - Prepare a minimal shipment payload: `{ order_id, tracking_number, carrier_code, shipment_method }`.
  - Group payloads by store to batch submit later.

3) Batch submissions (after lookups)
- For each store that has one or more shipment payloads, submit a single POST to `/api/v2/batch-shipments` with that store’s batch.
- In the current implementation, these per-store batch posts run one store at a time (sequential loop). This keeps logs simpler; it can be parallelized in the future if needed.

4) Logging and results
- Processing results (successes or errors per shipment or per store) are logged to the server console.
- The original HTTP caller does not receive these details (as processing is asynchronous).

## Request schema (accurate to code)

Each shipment object supports the following fields used by the system:

- `source_id` (string, required): Must start with the store ID followed by a dash, e.g., `21633-ORD-000001`. The prefix before the dash is used to select the store and API key.
- `tracking_number` (string, required): Tracking number.
- `carrier_code` (string, required): Carrier identifier that Order Desk recognizes (e.g., `ups`, `fedex`, `usps`).
- `shipment_method` (string, required): Human-friendly method name (e.g., `Ground`, `2Day`).
- `order_items` (array, optional): When present with at least one item, the API uses Order Desk's single create shipment endpoint.
- `order_id` (string|number, optional): If provided with `order_items`, skips the source_id lookup.
- `store_id` (string|number, optional): If provided, used to select the store when `source_id` is not present.

Example (single object):

```json
{
  "source_id": "21633-ORD-000001",
  "tracking_number": "1Z999AA10123456784",
  "carrier_code": "ups",
  "shipment_method": "Ground"
}
```

Example (array):

```json
[
  {
    "source_id": "21633-ORD-000001",
    "tracking_number": "1Z999AA10123456784",
    "carrier_code": "ups",
    "shipment_method": "Ground"
  },
  {
    "source_id": "21633-ORD-000002",
    "tracking_number": "1Z999AA10123456785",
    "carrier_code": "ups",
    "shipment_method": "Ground"
  }
]
```

Example (single create-shipment with order items):

```json
{
  "source_id": "21633-ORD-000003",
  "tracking_number": "1Z2398479234",
  "carrier_code": "UPS",
  "shipment_method": "Ground",
  "order_items": [
    { "code": "SKU1", "quantity": 1 },
    { "code": "SKU2", "quantity": 1 }
  ]
}
```

Example (single create-shipment with explicit order_id and store_id):

```json
{
  "store_id": "21633",
  "order_id": "123456789",
  "tracking_number": "1Z2398479234",
  "carrier_code": "UPS",
  "shipment_method": "Ground",
  "order_items": [
    { "code": "SKU1", "quantity": 1 },
    { "code": "SKU2", "quantity": 1 }
  ]
}
```

Response examples:

- 202 Accepted
  ```json
  { "message": "Shipments queued for processing" }
  ```
- 400 Bad Request
  ```json
  { "message": "Invalid request payload" }
  ```

## Rate limiting (deep dive)

Order Desk limits are modeled per store with a token-bucket/leaky-bucket using Bottleneck. Settings per store:

- `reservoir: 20` — initial burst capacity
- `reservoirIncreaseAmount: 3` — refill amount per interval
- `reservoirIncreaseInterval: 1000` ms — refill every second
- `reservoirIncreaseMaximum: 20` — cap burst bucket at 20
- `maxConcurrent: 3` — at most 3 in-flight requests per store

Behavior:

- All outbound calls to Order Desk run through a centralized helper `odFetch(...)` which schedules them on the per-store limiter.
- After each response, the code reads `X-Tokens-Remaining` (or `X-Tokens-Available`) and logs warnings if tokens are low.
- If Order Desk returns `429 Too Many Requests`, the code reads `X-Retry-After`, waits that many seconds (plus small jitter), and retries. It will retry up to `maxRetries` (default 5). If the header is missing, it uses a safe default delay (~2s + jitter).
- Non-429 errors (e.g., transient network issues) also retry with exponential backoff (up to `maxRetries`).

What slows down when limits are hit?

- Only the affected store’s outbound requests slow down. Other stores continue at their own pace because each store has its own limiter instance.
- The API itself does not return 429 to clients; throttling happens internally during background processing.

References: Order Desk API docs — https://apidocs.orderdesk.com/#rate-limits

## Concurrency model (deep dive)

- Global parallelism during lookups: `p-limit(10)` caps how many shipments are resolving their order IDs at once across all stores.
- Per-store concurrency: at most `3` in-flight requests per store (`maxConcurrent: 3`).
- Batch submissions: a single POST per store after lookups; currently executed sequentially across stores in a `for ... in` loop.

Throughput intuition (rule of thumb):

- For one store, steady-state is ~3 requests/second after the initial 20-token burst. The drain time for `R` requests is approximately `(max(R - 20, 0)) / 3` seconds, plus network latency and any 429 backoff. Example: 101 requests → about `(101 − 20) / 3 ≈ 27s` plus latency.

## Error handling and retries

- Input validation: rejects non-object/non-array bodies with HTTP 400.
- Per-shipment processing errors (e.g., bad store ID, missing API key, fetch failure) are caught and logged; other shipments proceed.
- `odFetch` handles:
  - 429s: honor `X-Retry-After`, jitter, bounded retries
  - other errors: exponential backoff with jitter, bounded retries
- If retries are exhausted, the error is logged and surfaced in the processing results; the system continues with other work.

## Logging and observability

Key log markers:

- `[processQueue]` — lifecycle of queue processing, grouping, and batch posts
- `[fetchOrder]` — order lookup requests and responses
- `[postShipments]` — batch submission requests and responses
- `[RateLimit]` / `[RateLimit Warning]` — token levels and warnings
- `[RateLimit OVERAGE]` — 429 events and enforced wait periods

Tunable via environment variables:

- `RATE_LIMIT_LOG`: `off` | `warn` (default) | `verbose`
- `RATE_LIMIT_WARN_TOKENS`: integer threshold (default `5`) for low-token warnings

## Configuration

Environment variables (examples):

```env
PORT=4000
RATE_LIMIT_LOG=warn
RATE_LIMIT_WARN_TOKENS=5

# One environment variable per store, referenced in code by store ID
STORE_21633=xxxxxxxx
STORE_40348=xxxxxxxx
# ...add others as needed
```

The mapping of `storeId → API key env var` is defined in `index.js` via a static array. Ensure any store you use in `source_id` has a corresponding entry and environment variable.

## Operational notes

- The in-memory queue is volatile. If the process restarts, queued (unprocessed) shipments are lost.
- Consider external persistence (Redis, DB) if you need durability and visibility of queue state.
- If you need higher throughput across many stores, options include:
  - Increasing global parallelism (`p-limit`) cautiously
  - Adjusting per-store `maxConcurrent` (mind API server tolerance)
  - Parallelizing per-store batch POSTs
  - Horizontal scaling (multiple instances) with a shared durable queue and a global limiter strategy

## Setup & run

1) Install dependencies

```sh
npm install
```

2) Configure `.env` (see Configuration section)

3) Start the server

```sh
npm start
```

Default port is `4000` unless overridden by `PORT`.

## Example usage

Send a batch of shipments for a single store (to observe rate limiting behavior):

```json
[
  { "source_id": "21633-ORD-000001", "tracking_number": "1Z999AA10123456784", "carrier_code": "ups", "shipment_method": "Ground" },
  { "source_id": "21633-ORD-000002", "tracking_number": "1Z999AA10123456785", "carrier_code": "ups", "shipment_method": "Ground" }
]
```

With many items (e.g., 50–100) for the same store, you’ll see token warnings and possibly 429-based pauses; other stores continue normally.

## Dependencies

- [Express](https://expressjs.com)
- [node-fetch](https://www.npmjs.com/package/node-fetch)
- [dotenv](https://www.npmjs.com/package/dotenv)
- [body-parser](https://www.npmjs.com/package/body-parser)
- [p-limit](https://www.npmjs.com/package/p-limit)
- [Bottleneck](https://www.npmjs.com/package/bottleneck)

## License

MIT
