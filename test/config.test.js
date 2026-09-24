import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, validateRuntimeConfig } from '../config.js';

test('buildConfig automatically applies secure Heroku runtime defaults', () => {
    const result = buildConfig({
        DYNO: 'web.1',
        DATABASE_URL: 'postgresql://example',
        INBOUND_API_KEY: 'a'.repeat(32)
    });

    assert.equal(result.isHeroku, true);
    assert.equal(result.nodeEnv, 'production');
    assert.equal(result.databaseSsl, true);
    assert.equal(result.databaseSslRejectUnauthorized, false);
    assert.equal(result.requireInboundAuth, true);
    assert.doesNotThrow(() => validateRuntimeConfig(result));
});

test('buildConfig retains simple local development defaults', () => {
    const result = buildConfig({ DATABASE_URL: 'postgresql://example' });

    assert.equal(result.isHeroku, false);
    assert.equal(result.nodeEnv, 'development');
    assert.equal(result.databaseSsl, false);
    assert.equal(result.databaseSslRejectUnauthorized, true);
    assert.equal(result.requireInboundAuth, false);
});

test('production validation still requires a long inbound key', () => {
    const missing = buildConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://example' });
    assert.throws(() => validateRuntimeConfig(missing), /INBOUND_API_KEY is required/);

    const short = buildConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://example',
        INBOUND_API_KEY: 'too-short'
    });
    assert.throws(() => validateRuntimeConfig(short), /at least 32 characters/);
});
