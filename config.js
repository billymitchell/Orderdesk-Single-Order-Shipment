import { randomUUID } from 'node:crypto';

const positiveInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const booleanValue = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).toLowerCase() === 'true';
};

export const buildConfig = (env = process.env) => {
    const isHeroku = Boolean(env.DYNO);
    const nodeEnv = env.NODE_ENV || (isHeroku ? 'production' : 'development');

    return {
        isHeroku,
        nodeEnv,
        port: positiveInteger(env.PORT, 4000),
        databaseUrl: env.DATABASE_URL,
        databaseSsl: booleanValue(env.DATABASE_SSL, isHeroku),
        databaseSslRejectUnauthorized: booleanValue(env.DATABASE_SSL_REJECT_UNAUTHORIZED, !isHeroku),
        databasePoolMax: positiveInteger(env.DATABASE_POOL_MAX, 10),
        requestBodyLimit: env.REQUEST_BODY_LIMIT || '5mb',
        orderDeskRequestTimeoutMs: positiveInteger(env.ORDERDESK_REQUEST_TIMEOUT_MS, 30000),
        orderDeskBatchSize: positiveInteger(env.ORDERDESK_BATCH_SIZE, 100),
        rateLimitWarnTokens: positiveInteger(env.RATE_LIMIT_WARN_TOKENS, 5),
        rateLimitLog: (env.RATE_LIMIT_LOG || 'warn').toLowerCase(),
        workerPollIntervalMs: positiveInteger(env.WORKER_POLL_INTERVAL_MS, 1000),
        workerClaimSize: positiveInteger(env.WORKER_CLAIM_SIZE, 100),
        workerConcurrency: positiveInteger(env.WORKER_CONCURRENCY, 10),
        workerLeaseSeconds: positiveInteger(env.WORKER_LEASE_SECONDS, 300),
        workerMaxAttempts: positiveInteger(env.WORKER_MAX_ATTEMPTS, 8),
        workerId: env.WORKER_ID || `worker-${process.pid}-${randomUUID()}`,
        inboundApiKey: env.INBOUND_API_KEY || null,
        requireInboundAuth: booleanValue(env.REQUIRE_INBOUND_AUTH, nodeEnv === 'production' || isHeroku),
        adminApiKey: env.ADMIN_API_KEY || null
    };
};

export const config = buildConfig();

export const retryableHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

export const validateRuntimeConfig = (runtimeConfig = config) => {
    if (!runtimeConfig.databaseUrl) throw new Error('DATABASE_URL is required for durable shipment storage');
    if (runtimeConfig.requireInboundAuth && !runtimeConfig.inboundApiKey) {
        throw new Error('INBOUND_API_KEY is required when REQUIRE_INBOUND_AUTH=true');
    }
    if (runtimeConfig.nodeEnv === 'production' && runtimeConfig.inboundApiKey && runtimeConfig.inboundApiKey.length < 32) {
        throw new Error('INBOUND_API_KEY must contain at least 32 characters in production');
    }
    if (runtimeConfig.nodeEnv === 'production' && runtimeConfig.adminApiKey && runtimeConfig.adminApiKey.length < 32) {
        throw new Error('ADMIN_API_KEY must contain at least 32 characters in production');
    }
};
