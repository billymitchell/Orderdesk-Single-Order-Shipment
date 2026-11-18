-- One row per HTTP exchange, in either direction:
--   inbound  = a caller hitting this API (what they sent, what we answered)
--   outbound = this service calling Order Desk (what we sent, what Order Desk answered)
-- Outbound rows carry the batch IDs of the jobs they served, so an inbound
-- submission and the Order Desk calls it caused can be found together.
CREATE TABLE IF NOT EXISTS request_logs (
    id                uuid PRIMARY KEY,
    created_at        timestamptz NOT NULL DEFAULT now(),
    direction         text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    outcome           text NOT NULL,          -- success | validation_error | unauthorized | conflict | not_found | error | downstream_error | network_error
    method            text NOT NULL,
    url               text NOT NULL,          -- inbound: path; outbound: full Order Desk URL
    status            integer,                -- inbound: status we returned; outbound: Order Desk status
    duration_ms       integer,
    inbound_auth      text,                   -- ok | missing | invalid | not_required (inbound only)
    idempotency_key   text,
    request_headers   json,                   -- inbound: allowlisted; outbound: API key masked
    request_body      json,
    response_body     json,
    error_message     text,
    error_code        text,
    tokens_remaining  integer,                -- Order Desk x-tokens-remaining
    store_ids         text[] NOT NULL DEFAULT '{}',
    batch_ids         text[] NOT NULL DEFAULT '{}',
    job_ids           text[] NOT NULL DEFAULT '{}',
    tracking_numbers  text[] NOT NULL DEFAULT '{}',
    order_numbers     text[] NOT NULL DEFAULT '{}',   -- source_id and Order Desk order_id values
    shipment_count    integer,
    search_text       text NOT NULL DEFAULT ''        -- lowercased identifiers for ILIKE search
);

CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS request_logs_direction_idx ON request_logs (direction, created_at DESC);
CREATE INDEX IF NOT EXISTS request_logs_outcome_idx ON request_logs (outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS request_logs_batch_idx ON request_logs USING gin (batch_ids);
CREATE INDEX IF NOT EXISTS request_logs_tracking_idx ON request_logs USING gin (tracking_numbers);
