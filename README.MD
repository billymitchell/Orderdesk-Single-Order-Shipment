# Orderdesk Shipping API

This API accepts shipment notifications, looks up orders in Order Desk, and posts shipment updates, all while respecting Order Desk’s per-store rate limits. It’s built with [Express](https://expressjs.com), uses [Bottleneck](https://www.npmjs.com/package/bottleneck) for rate limiting, and [p-limit](https://www.npmjs.com/package/p-limit) for controlled concurrency.

## At a glance

- Accepts POSTs with shipments (single or array)
- Queues shipments in memory and processes in the background
- For each shipment: fetch order (by source_id) → build payload → batch-post per store
- Per-store rate limiter mirrors Order Desk limits and handles 429 retry logic
- Returns 202 immediately; processing continues asynchronously

## Client guide: submitting shipments

Send an HTTP `POST` request to `/` with the `Content-Type: application/json` header. The body can contain one shipment object or an array of shipment objects. Sending an array is recommended when multiple shipments are ready at the same time.

The API acknowledges the request before Order Desk processing finishes. A `202 Accepted` response means that the payload passed initial validation and was added to this service's queue. It does **not** mean that Order Desk has created every shipment.

### Submit one shipment

```sh
curl --request POST 'http://localhost:4000/' \
  --header 'Content-Type: application/json' \
  --data '{
    "source_id": "21633-ORD-000001",
    "tracking_number": "1Z999AA10123456784",
    "carrier_code": "ups",
    "shipment_method": "Ground"
  }'
```

### Submit multiple shipments

```sh
curl --request POST 'http://localhost:4000/' \
  --header 'Content-Type: application/json' \
  --data '[
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
  ]'
```

The service groups shipments by store and sends them to Order Desk in batches of 100 by default. Clients do not need to divide a large request into groups of 100 themselves.

### Shipment fields

| Field | Required | Meaning |
| --- | --- | --- |
| `source_id` | Usually | The Order Desk source ID. It must begin with the configured numeric store ID and a dash, such as `21633-ORD-000001`. It can be omitted only for a line-item shipment that supplies both `store_id` and `order_id`. |
| `tracking_number` | Yes | The carrier tracking number. |
| `carrier_code` | Yes | A configured carrier code such as `ups`, `fedex`, or `usps`. Matching is case-insensitive during initial validation. |
| `shipment_method` | Yes | The service name, such as `Ground` or `2Day`. |
| `order_items` | No | Items and quantities included in a partial shipment. When supplied, the single-order shipment endpoint is used. |
| `order_id` | Conditional | The internal Order Desk order ID. It can replace the `source_id` lookup for a line-item shipment. |
| `store_id` | Conditional | Required when `source_id` is omitted. It selects the Order Desk store and API key. |

### Current HTTP response statuses

| HTTP status | Meaning | What the caller should do |
| --- | --- | --- |
| `202 Accepted` | The request passed initial validation and was placed in the in-memory queue. Order Desk processing is still pending. | Do not interpret this as delivery confirmation. Retain the submitted data until processing has been independently verified. |
| `400 Bad Request` | The request shape or a carrier code was rejected. No shipments from that request were queued. | Correct the payload and submit it again. The response body identifies carrier validation failures when available. |
| `500 Internal Server Error` | The service could not parse or handle the request. The request should not be assumed to be queued. | Review the response and server logs before retrying. Because the current API has no idempotency key, blindly retrying an uncertain request can create duplicates. |

Successful acceptance currently returns:

```json
{
  "message": "Shipments queued for processing"
}
```

There is currently no batch ID or status endpoint. Final successes, partial failures, retry exhaustion, invalid source IDs, and Order Desk errors are recorded in the server logs. In particular, Order Desk can return HTTP 200 for a batch while individual shipment results contain errors; the service inspects and logs those individual results.

### Processing status glossary for persistent storage

The following statuses describe the planned durable-queue workflow. They are documented here for the persistent-storage implementation, but they are **not yet returned by the current API**.

| Status | Meaning | Terminal? |
| --- | --- | --- |
| `queued` | The shipment has been committed to persistent storage and is waiting for a worker. | No |
| `processing` | A worker has claimed the shipment and is resolving or submitting it to Order Desk. | No |
| `retrying` | A temporary failure occurred and another attempt is scheduled. | No |
| `succeeded` | Order Desk confirmed that the shipment was created, or reconciliation found that it had already been created. | Yes |
| `failed` | A permanent error occurred or the retry limit was reached. The shipment requires correction or manual replay. | Yes |

A future batch-level status may be `queued`, `processing`, `completed`, or `completed_with_errors`. `completed_with_errors` means every shipment reached a terminal state, but at least one shipment failed.

### Important retry warning

Until persistent storage and idempotency protection are implemented, callers should not automatically resend a request merely because their connection timed out. The server may have accepted the request even if the caller did not receive the `202` response. Check application logs and Order Desk before resubmitting an uncertain shipment.

## TODO: persistent shipment queue

The tasks below are ordered by dependency. The persistent-queue cutover is complete only when a request is committed to storage before `202 Accepted` is returned, unfinished work survives a restart, and callers can inspect the final result of every shipment.

### 1. Confirm infrastructure and behavior

- [ ] Select PostgreSQL and provision separate development, test, and production databases.
- [ ] Add `DATABASE_URL` to the runtime environment without committing credentials.
- [ ] Decide how long completed and failed job records must be retained.
- [ ] Confirm the maximum request size and maximum number of shipments accepted in one incoming request.
- [ ] Define which Order Desk errors are permanent and which are safe to retry.

Acceptance criteria: the database environment, retention period, input limits, and retry classification are documented before schema work begins.

### 2. Add the database layer

- [ ] Choose and install the PostgreSQL client and migration tooling.
- [ ] Add a reusable connection pool with startup validation and graceful shutdown.
- [ ] Add migration commands to `package.json`.
- [ ] Ensure application logs never include database credentials.
- [ ] Add a database readiness check for deployment health checks.

Acceptance criteria: a fresh environment can create and verify the schema using one documented command.

### 3. Create the durable queue schema

- [ ] Create a `shipment_batches` table with UUID, status, shipment counts, idempotency key, and timestamps.
- [ ] Create a `shipment_jobs` table with the original payload, store ID, source/order IDs, status, attempt count, retry time, lock data, last error, Order Desk response, and timestamps.
- [ ] Add allowed-status constraints for `queued`, `processing`, `retrying`, `succeeded`, and `failed`.
- [ ] Add indexes for claimable jobs, batch lookups, expired locks, and failure reporting.
- [ ] Add a unique payload fingerprint or idempotency constraint to prevent duplicate jobs.
- [ ] Define foreign-key and deletion behavior so deleting a batch cannot accidentally erase active jobs.

Acceptance criteria: migrations can be applied and rolled back in the test environment, and invalid status values or duplicate fingerprints are rejected.

### 4. Persist incoming requests

- [ ] Replace `shipmentsQueue.push(...)` with a transaction that inserts one batch and its shipment jobs.
- [ ] Generate a stable fingerprint from normalized store, order/source, tracking, carrier, method, and line-item data.
- [ ] Support an optional `Idempotency-Key` request header.
- [ ] Return the existing batch when the same idempotency key and payload are submitted again.
- [ ] Return `409 Conflict` when an idempotency key is reused with different data.
- [ ] Return `503 Service Unavailable` if the request cannot be committed to PostgreSQL.
- [ ] Return `202 Accepted` only after the transaction commits.
- [ ] Include `batch_id`, `shipment_count`, `status`, and `status_url` in the `202` response while retaining the existing `message` field.

Acceptance criteria: killing the application immediately after a `202` response does not lose the accepted jobs.

### 5. Implement atomic worker claiming

- [ ] Replace the five-second in-memory queue snapshot with database job claiming.
- [ ] Claim jobs in a transaction using `FOR UPDATE SKIP LOCKED`.
- [ ] Record `locked_by`, `locked_at`, and `lock_expires_at` when a worker claims jobs.
- [ ] Add a configurable worker batch size and lease duration.
- [ ] Renew leases for work that may exceed the original lease duration.
- [ ] Return expired `processing` jobs to a recoverable state.
- [ ] Handle graceful shutdown by stopping new claims and finishing or releasing active work.

Acceptance criteria: two workers can run simultaneously without claiming the same job, and interrupted jobs become eligible again after their leases expire.

### 6. Integrate Order Desk processing

- [ ] Resolve and persist the Order Desk `order_id` so successful lookups are not repeated unnecessarily.
- [ ] Continue grouping shipment creation requests by store.
- [ ] Preserve the current per-store rate limiting and `X-Retry-After` handling.
- [ ] Coordinate rate limits across workers, or assign each worker a conservative portion of the per-store limit.
- [ ] Continue chunking Order Desk batch requests using `ORDERDESK_BATCH_SIZE`.
- [ ] Map every Order Desk batch `results[index]` entry back to its exact database job.
- [ ] Mark confirmed results `succeeded` and store the Order Desk response.
- [ ] Treat a missing batch-result entry as an uncertain result rather than success.

Acceptance criteria: every submitted job reaches a recorded state, including partial failures returned inside an HTTP 200 response.

### 7. Add retry and reconciliation behavior

- [ ] Retry `429` responses after the duration in `X-Retry-After`.
- [ ] Retry network failures, timeouts, `408`, and transient `5xx` responses with exponential backoff and jitter.
- [ ] Mark authentication, configuration, invalid-order, and invalid-payload errors as permanent failures where appropriate.
- [ ] Set a configurable maximum attempt count.
- [ ] Store `attempt_count`, `next_attempt_at`, and the last error for every retry.
- [ ] Before retrying an uncertain shipment creation, retrieve the order's shipments from Order Desk and compare tracking, carrier, and line-item data.
- [ ] Mark the job `succeeded` when reconciliation shows the shipment already exists.
- [ ] Keep exhausted jobs as `failed`; do not delete them automatically.

Acceptance criteria: a timeout after Order Desk creates a shipment does not result in a second shipment when the job is retried.

### 8. Add client status and replay endpoints

- [ ] Add `GET /batches/:batchId` with aggregate counts and batch status.
- [ ] Add `GET /batches/:batchId/shipments` with per-shipment status and errors.
- [ ] Add pagination for batches containing hundreds or thousands of shipments.
- [ ] Add an authenticated `POST /shipments/:jobId/retry` endpoint for eligible failed jobs.
- [ ] Define batch statuses `queued`, `processing`, `completed`, and `completed_with_errors` from job counts.
- [ ] Avoid exposing API keys, internal stack traces, or unrelated store data in status responses.

Acceptance criteria: the submitter can determine whether every shipment succeeded and can identify each shipment requiring correction.

### 9. Add observability and operations

- [ ] Emit structured logs containing batch ID, job ID, store ID, attempt, status transition, and error classification.
- [ ] Add metrics for queued, processing, retrying, succeeded, and failed jobs.
- [ ] Track oldest queued-job age, processing duration, retry counts, and expired leases.
- [ ] Alert on growing queue age, repeated authentication failures, exhausted jobs, and database connectivity failures.
- [ ] Add an administrative procedure for replaying, cancelling, and inspecting jobs.
- [ ] Add a retention or archival job for old terminal records.

Acceptance criteria: operators can detect a stalled queue and identify the affected batches without searching unstructured request bodies.

### 10. Test restart and failure recovery

- [ ] Add unit tests for normalization, fingerprints, status transitions, retry classification, and backoff calculations.
- [ ] Add database integration tests for transactions, unique constraints, job claiming, and expired leases.
- [ ] Add mocked Order Desk tests for partial HTTP 200 failures, `429`, `5xx`, timeouts, and malformed responses.
- [ ] Test duplicate incoming requests with and without `Idempotency-Key`.
- [ ] Test a process termination immediately after the API returns `202`.
- [ ] Test a worker termination after claiming jobs and during Order Desk submission.
- [ ] Test multiple workers processing different jobs concurrently.
- [ ] Test reconciliation when Order Desk accepted a shipment but the response was lost.

Acceptance criteria: automated tests demonstrate that accepted jobs survive restarts, are not concurrently claimed, and do not silently disappear.

### 11. Deploy and cut over safely

- [ ] Apply production migrations before enabling database-backed ingestion.
- [ ] Deploy the new code with the database worker disabled.
- [ ] Verify connectivity, migrations, status endpoints, metrics, and alerts.
- [ ] Pause incoming traffic or coordinate a maintenance window.
- [ ] Allow the existing in-memory queue to drain completely.
- [ ] Enable database-backed ingestion and workers together so jobs are never processed by both queue systems.
- [ ] Submit a controlled production batch and verify every job through completion.
- [ ] Monitor failures, retries, queue age, duplicates, and rate-limit responses during the observation period.
- [ ] Remove the in-memory queue only after the durable path is stable.
- [ ] Document rollback steps that preserve already-committed database jobs.

Acceptance criteria: production accepts and completes a controlled batch, a planned restart recovers unfinished work, and rollback does not discard persisted jobs.

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
- For each store that has one or more shipment payloads, submit POSTs to `/api/v2/batch-shipments` in configurable chunks (100 shipments by default).
- In the current implementation, these per-store batch posts run one store at a time (sequential loop). This keeps logs simpler; it can be parallelized in the future if needed.

4) Logging and results
- Processing results (successes or errors per shipment or per store) are logged to the server console. HTTP 200 batch responses are inspected for individual failed entries.
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
- Batch submissions: chunked POSTs per store after lookups; currently executed sequentially across stores in a `for ... in` loop.

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
- `ORDERDESK_REQUEST_TIMEOUT_MS`: timeout for each Order Desk request (default `30000`)
- `ORDERDESK_BATCH_SIZE`: number of shipments per batch request (default `100`)

## Configuration

Environment variables (examples):

```env
PORT=4000
RATE_LIMIT_LOG=warn
RATE_LIMIT_WARN_TOKENS=5
ORDERDESK_REQUEST_TIMEOUT_MS=30000
ORDERDESK_BATCH_SIZE=100

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
