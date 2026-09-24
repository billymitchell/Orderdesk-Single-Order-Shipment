CREATE TABLE IF NOT EXISTS shipment_batches (
    id UUID PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    request_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'completed', 'completed_with_errors')),
    total_count INTEGER NOT NULL CHECK (total_count > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS shipment_jobs (
    id UUID PRIMARY KEY,
    batch_id UUID NOT NULL REFERENCES shipment_batches(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK (position >= 0),
    fingerprint TEXT NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    store_id TEXT NOT NULL,
    source_id TEXT,
    order_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'retrying', 'succeeded', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by TEXT,
    locked_at TIMESTAMPTZ,
    lock_expires_at TIMESTAMPTZ,
    last_error TEXT,
    last_error_code TEXT,
    last_response JSONB,
    remote_shipment_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE (batch_id, position)
);

CREATE INDEX IF NOT EXISTS shipment_jobs_claimable_idx
    ON shipment_jobs (next_attempt_at, created_at)
    WHERE status IN ('queued', 'retrying');

CREATE INDEX IF NOT EXISTS shipment_jobs_expired_lock_idx
    ON shipment_jobs (lock_expires_at)
    WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS shipment_jobs_batch_idx
    ON shipment_jobs (batch_id, position);

CREATE INDEX IF NOT EXISTS shipment_jobs_failed_idx
    ON shipment_jobs (updated_at DESC)
    WHERE status = 'failed';

