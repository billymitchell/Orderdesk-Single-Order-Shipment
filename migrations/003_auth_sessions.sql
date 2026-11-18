-- Dashboard sign-in sessions, built like Syncore's: the cookie holds a random
-- token, this table keeps only its SHA-256 hash, and the Supabase tokens are
-- stored encrypted with AUTH_SESSION_KEY.
CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash        text PRIMARY KEY,               -- SHA-256 of the cookie token
    email             text NOT NULL,
    supabase_user_id  uuid NOT NULL,
    tokens_enc        text NOT NULL,                  -- AES-256-GCM(access + refresh tokens)
    created_at        timestamptz NOT NULL DEFAULT now(),
    checked_at        timestamptz NOT NULL,           -- last Supabase getUser check
    expires_at        timestamptz NOT NULL,           -- created_at + 8 hours
    ip                text,
    user_agent        text
);

CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions (expires_at);
