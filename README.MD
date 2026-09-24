# Order Desk Shipping API

This Express API accepts shipment notifications and delivers them asynchronously to Order Desk. Incoming requests are committed to PostgreSQL before the API returns `202 Accepted`, so accepted shipments survive application restarts and worker crashes.

## What happens after a submission

1. The API validates every shipment in the request.
2. One batch and one job per shipment are inserted in a PostgreSQL transaction.
3. The API returns `202 Accepted` with a persistent `batch_id`.
4. A worker leases queued jobs with `FOR UPDATE SKIP LOCKED`.
5. Orders are resolved and shipments are grouped by store for Order Desk submission.
6. Every individual Order Desk batch result is stored as `succeeded`, `retrying`, or `failed`.
7. The caller uses the batch status endpoints to verify the final result.

If the process stops after step 3, the jobs remain in PostgreSQL. Expired worker leases are reclaimed automatically after restart.

## Setup

Requirements:

- Node.js 24.x (the version pinned for Heroku)
- PostgreSQL
- Order Desk API credentials for each configured store

Install dependencies:

```sh
npm install
```

Copy `.env.example` to `.env` and configure at least:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/orderdesk_shipping
STORE_21633=your-order-desk-api-key
```

The Heroku setup command generates the inbound and administrator API keys if they are blank. Do not put real credentials in `.env.example`.

For optional local development, `compose.yaml` provides PostgreSQL with a named volume:

```sh
docker compose up -d postgres
```

Use this local connection string:

```env
DATABASE_URL=postgresql://orderdesk:orderdesk-local-only@localhost:5432/orderdesk_shipping
```

The Compose password is for local development only and must not be used in a deployed environment.

Apply the database migrations:

```sh
npm run migrate
```

Start the API and worker:

```sh
npm start
```

The application checks both the database connection and required queue tables before opening its HTTP port. It will not accept shipments when durable storage is unavailable or has not been migrated.

## Submit shipments

Send `POST /` with `Content-Type: application/json`. The body can be one shipment object or an array.

An `Idempotency-Key` header is recommended. Repeating the same key and payload returns the existing batch instead of creating duplicate jobs. Reusing the key with different data returns `409 Conflict`.

### Submit one shipment

```sh
curl --request POST 'http://localhost:4000/' \
  --header 'Content-Type: application/json' \
  --header 'X-API-Key: your-inbound-api-key' \
  --header 'Idempotency-Key: fulfillment-run-2026-09-23-001' \
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
  --header 'X-API-Key: your-inbound-api-key' \
  --header 'Idempotency-Key: fulfillment-run-2026-09-23-002' \
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

The worker splits Order Desk batch requests into groups of `ORDERDESK_BATCH_SIZE`, which defaults to 100. Clients do not need to divide large incoming arrays into groups of 100.

### Shipment fields

| Field | Required | Meaning |
| --- | --- | --- |
| `source_id` | Usually | The Order Desk source ID. It must begin with the configured numeric store ID and a dash, such as `21633-ORD-000001`. |
| `tracking_number` | Yes | The carrier tracking number. |
| `carrier_code` | Yes | A configured carrier such as `ups`, `fedex`, or `usps`. Initial validation is case-insensitive. |
| `shipment_method` | Yes | The service name, such as `Ground` or `2Day`. |
| `order_items` | No | Items and quantities for a partial shipment. Each item requires `id` or `code`, plus a quantity greater than zero. |
| `order_id` | Conditional | Can replace the source-ID lookup for a line-item shipment. |
| `store_id` | Conditional | Required when a line-item shipment supplies `order_id` without `source_id`. |

Line-item example:

```json
{
  "store_id": "21633",
  "order_id": "123456789",
  "tracking_number": "1Z2398479234",
  "carrier_code": "ups",
  "shipment_method": "Ground",
  "order_items": [
    { "code": "SKU1", "quantity": 1 },
    { "code": "SKU2", "quantity": 1 }
  ]
}
```

## Submission response

A successful submission returns `202 Accepted` only after the PostgreSQL transaction commits:

```json
{
  "message": "Shipments queued for processing",
  "batch_id": "58c62447-c3e8-42d9-b3e6-9bf721ae694f",
  "status": "queued",
  "shipment_count": 500,
  "status_url": "/batches/58c62447-c3e8-42d9-b3e6-9bf721ae694f",
  "replayed": false
}
```

`202` means the shipments are durably queued. It does not mean Order Desk has created them yet.

When an identical request or matching idempotency key is replayed, the API returns the existing `batch_id` with `replayed: true`. A unique fingerprint also prevents the same normalized shipment from being accepted in a different batch.

## Check batch status

Request aggregate status:

```sh
curl --header 'X-API-Key: your-inbound-api-key' \
  'http://localhost:4000/batches/58c62447-c3e8-42d9-b3e6-9bf721ae694f'
```

Example response:

```json
{
  "batch_id": "58c62447-c3e8-42d9-b3e6-9bf721ae694f",
  "status": "processing",
  "total": 500,
  "queued": 20,
  "processing": 10,
  "retrying": 5,
  "succeeded": 460,
  "failed": 5,
  "shipments_url": "/batches/58c62447-c3e8-42d9-b3e6-9bf721ae694f/shipments"
}
```

Request per-shipment status with pagination:

```sh
curl --header 'X-API-Key: your-inbound-api-key' \
  'http://localhost:4000/batches/58c62447-c3e8-42d9-b3e6-9bf721ae694f/shipments?limit=100&offset=0'
```

The maximum page size is 500. Each entry includes its job ID, source/order identifiers, tracking number, carrier, status, attempts, last error, and timestamps.

## Status meanings

### Shipment job statuses

| Status | Meaning | Terminal? |
| --- | --- | --- |
| `queued` | Committed to PostgreSQL and waiting for a worker. | No |
| `processing` | Leased by a worker and being resolved, reconciled, or submitted. | No |
| `retrying` | A temporary failure occurred and another attempt is scheduled. | No |
| `succeeded` | Order Desk confirmed creation, or reconciliation found that the shipment already exists. | Yes |
| `failed` | A permanent error occurred or the retry limit was reached. | Yes |

### Batch statuses

| Status | Meaning |
| --- | --- |
| `queued` | All shipments are waiting to be processed. |
| `processing` | At least one shipment is processing, retrying, or has reached a terminal state while others remain. |
| `completed` | Every shipment succeeded. |
| `completed_with_errors` | Every shipment reached a terminal state, but at least one failed. |

Order Desk can return HTTP 200 for a batch while individual shipment entries fail. The worker inspects every result and records those failures individually.

## HTTP response statuses

| HTTP status | Meaning |
| --- | --- |
| `200 OK` | A health, batch-status, or shipment-status request succeeded. |
| `202 Accepted` | The incoming shipments were committed to PostgreSQL, or a failed job was queued for manual retry. |
| `400 Bad Request` | JSON, identifiers, shipment fields, line items, or pagination inputs are invalid. |
| `401 Unauthorized` | A protected endpoint received a missing or invalid inbound key, or manual retry received an invalid administrator key. |
| `404 Not Found` | The requested batch does not exist. |
| `409 Conflict` | An idempotency key was reused with different data, a duplicate shipment was detected, or a job is not eligible for manual retry. |
| `413 Payload Too Large` | The request exceeds `REQUEST_BODY_LIMIT`. |
| `500 Internal Server Error` | An unexpected application error occurred. |
| `503 Service Unavailable` | Durable storage is unavailable, or manual retry is disabled because `ADMIN_API_KEY` is not configured. |

Invalid requests are rejected as a whole; no shipment from that request is committed.

## Retry and restart behavior

- `429` is retried after Order Desk's `X-Retry-After` duration.
- Network failures, timeouts, `408`, and transient `5xx` responses use exponential backoff with jitter.
- Validation, configuration, authentication, and rejected shipment errors are stored as permanent failures.
- Failed attempts and the most recent Order Desk response are retained with the job.
- Retry exhaustion leaves the job in `failed`; it is never automatically deleted.
- Worker leases are renewed during active processing.
- An expired lease is treated as an uncertain outcome and reclaimed after restart.
- Before retrying an uncertain shipment creation, the worker lists the order's shipments and matches tracking, carrier, and line items. If it already exists, the job is marked successful instead of creating a duplicate.

### Manually retry a failed job

Set `ADMIN_API_KEY`, then send:

```sh
curl --request POST 'http://localhost:4000/shipments/JOB_UUID/retry' \
  --header 'X-API-Key: your-inbound-api-key' \
  --header 'X-Admin-API-Key: your-admin-key'
```

Only jobs currently in `failed` can be manually retried.

## Rate limiting and concurrency

Each process maintains a limiter for each Order Desk store:

- Initial reservoir: 20 requests
- Refill: 3 requests per second
- Maximum concurrent requests per store: 3
- Global order-lookup concurrency: `WORKER_CONCURRENCY`, default 10

The worker honors `X-Retry-After` by scheduling the durable job for a later attempt. Batch creation consumes one Order Desk rate-limit token for the entire outgoing batch.

The limiter is process-local. Run one worker process unless a shared/distributed rate limiter is added or each worker is assigned a conservative portion of the per-store allowance. PostgreSQL job leases themselves are safe with multiple workers.

## API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/` | Validate and durably queue one or more shipments. |
| `GET` | `/health/live` | Verify that the HTTP process is alive; no authentication required. |
| `GET` | `/health/ready` | Verify PostgreSQL and worker readiness; no authentication required. |
| `GET` | `/health` | Alias for `/health/ready`. |
| `GET` | `/batches/:batchId` | Return aggregate batch status. |
| `GET` | `/batches/:batchId/shipments` | Return paginated shipment job statuses. |
| `POST` | `/shipments/:jobId/retry` | Manually retry a failed job using administrator authentication. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Required | PostgreSQL connection string. |
| `DATABASE_SSL` | Heroku: `true`; otherwise `false` | Optional TLS override for the PostgreSQL connection. |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | Heroku: `false`; otherwise `true` | Optional PostgreSQL certificate-verification override. |
| `DATABASE_POOL_MAX` | `10` | Maximum PostgreSQL connections per application instance. |
| `PORT` | `4000` | HTTP port. |
| `NODE_ENV` | Heroku: `production`; otherwise `development` | Runtime mode; normally automatic. |
| `REQUIRE_INBOUND_AUTH` | Heroku/production: `true` | Optional authentication override. |
| `INBOUND_API_KEY` | Required in production | Accepted as `Authorization: Bearer` or `X-API-Key`; minimum 32 characters in production. |
| `REQUEST_BODY_LIMIT` | `5mb` | Maximum incoming JSON body size. |
| `ORDERDESK_REQUEST_TIMEOUT_MS` | `30000` | Timeout for each Order Desk request. |
| `ORDERDESK_BATCH_SIZE` | `100` | Shipments per outgoing batch request. |
| `RATE_LIMIT_LOG` | `warn` | `off`, `warn`, or `verbose`. |
| `RATE_LIMIT_WARN_TOKENS` | `5` | Low-token warning threshold. |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Delay between worker polling cycles. |
| `WORKER_CLAIM_SIZE` | `100` | Jobs leased per cycle. |
| `WORKER_CONCURRENCY` | `10` | Parallel order resolution and single-shipment work. |
| `WORKER_LEASE_SECONDS` | `300` | Processing lease duration. |
| `WORKER_MAX_ATTEMPTS` | `8` | Maximum automatic attempts. |
| `WORKER_ID` | Unique generated value | Optional stable worker name for logs and leases. |
| `ADMIN_API_KEY` | Disabled | Enables authenticated manual retry. |
| `ALLOWED_CARRIER_CODES` | Built-in list | Comma-separated accepted carrier codes. |
| `STORE_<id>` | Per store | Order Desk API key for a configured store. |

Store metadata is defined in `stores.js`.

## Database schema and migrations

`shipment_batches` stores request identity, aggregate status, and timestamps. `shipment_jobs` stores each original payload, fingerprint, processing status, attempts, retry schedule, lease, errors, responses, and completion data.

Run migrations before every deployment:

```sh
npm run migrate
```

Migrations are transactional and tracked in `schema_migrations`.
An advisory lock serializes migrations when multiple instances start concurrently.

## Heroku deployment

After provisioning Heroku Postgres in the Dashboard, put the real `STORE_<id>` credentials in the ignored local `.env` file. Then run:

```sh
heroku login
npm run heroku:configure -- --app YOUR_APP_NAME
```

The guarded setup command confirms the app and database, refuses placeholder store keys, generates missing inbound and administrator keys, saves those keys to `.env`, and uploads only the approved production variables. It never uploads the local `DATABASE_URL` or `PORT`, and it never prints secrets.

Commit and push the application, deploy the `main` branch through the Heroku GitHub integration, then verify the result:

```sh
npm run heroku:verify -- --app YOUR_APP_NAME
```

The verification command checks Postgres, required variables without printing their values, releases, the web dyno, and `/health/ready`.

The `Procfile` defines:

```text
release: npm run migrate
web: npm start
```

The release phase applies transactional migrations before a new release receives traffic. The single `web` dyno runs both the HTTP API and durable worker. Heroku supplies `PORT` and `DATABASE_URL`. The application recognizes Heroku and selects production authentication and PostgreSQL TLS defaults automatically.

Use a non-sleeping dyno plan. Eco dynos sleep after inactivity, which also stops this application's worker until the web dyno wakes again. Keep the formation at exactly one web dyno until the process-local Order Desk rate limiter is replaced by a shared limiter.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the short deployment path, cutover, and rollback procedure.

## Container deployment

Build the production image:

```sh
docker build -t orderdesk-shipping-api .
```

The container entrypoint applies pending migrations and then starts the API with signal forwarding. It runs as a non-root user and exposes port 4000. `/health/ready` is configured as the container health check.

The container path is available for non-Heroku deployments. Heroku's Node.js buildpack uses the `Procfile`, not this `Dockerfile`.

## Verification

Run the unit and worker behavior tests:

```sh
npm test
```

Covered behavior includes stable fingerprints, normalization, status derivation, request validation, partial failures inside HTTP 200 batch responses, and reconciliation before retrying uncertain jobs.

Production rollout still requires:

- [ ] Provision and back up the production PostgreSQL database.
- [ ] Apply the migration in production.
- [ ] Add database integration tests against a disposable PostgreSQL instance.
- [ ] Add centralized metrics and alerts for queue age, retries, expired leases, and failures.
- [ ] Add a shared limiter before running multiple worker processes against the same stores.
- [ ] Drain the old deployment's in-memory queue before cutover.
- [ ] Submit a controlled batch and verify restart recovery before full traffic.
- [ ] Define retention and archival rules for terminal jobs.

## Project structure

- `index.js` — startup and graceful shutdown
- `app.js` — HTTP routes and response handling
- `config.js` — environment configuration
- `db.js` — PostgreSQL connection pool and readiness checks
- `queue.js` — transactional ingestion, leases, status queries, and transitions
- `worker.js` — durable processing, retries, batching, and reconciliation
- `orderdesk.js` — Order Desk HTTP client and per-store rate limiting
- `stores.js` — store configuration
- `validation.js` — incoming shipment validation
- `migrations/` — PostgreSQL schema migrations
- `scripts/migrate.js` — migration runner
- `scripts/heroku-configure.js` — guarded Heroku configuration automation
- `scripts/heroku-verify.js` — deployment and readiness verification
- `test/` — automated tests
- `compose.yaml` — optional local PostgreSQL service with persistent volume
- `Dockerfile` and `.dockerignore` — production container build
- `Procfile` — Heroku release and web process definitions
- `.github/workflows/ci.yml` — Node 24 tests and dependency audit

## Dependencies

- [Express](https://expressjs.com)
- [PostgreSQL client for Node.js](https://node-postgres.com/)
- [Bottleneck](https://www.npmjs.com/package/bottleneck)
- [p-limit](https://www.npmjs.com/package/p-limit)
- [node-fetch](https://www.npmjs.com/package/node-fetch)

## License

ISC
