import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectStoreConfig,
    isPlaceholder,
    mergeEnvText,
    parseHerokuArgs,
    validateHerokuAppName
} from '../scripts/heroku-common.js';

test('parseHerokuArgs accepts standard app arguments', () => {
    assert.deepEqual(parseHerokuArgs(['--app', 'shipping-api', '--yes']), {
        app: 'shipping-api',
        yes: true,
        help: false
    });
    assert.equal(parseHerokuArgs(['--app=shipping-api']).app, 'shipping-api');
    assert.throws(() => parseHerokuArgs(['--unknown']), /Unknown argument/);
});

test('validateHerokuAppName rejects unsafe or malformed names', () => {
    assert.equal(validateHerokuAppName('shipping-api'), 'shipping-api');
    assert.throws(() => validateHerokuAppName(''), /required/);
    assert.throws(() => validateHerokuAppName('--app'), /must contain/);
    assert.throws(() => validateHerokuAppName('Shipping API'), /must contain/);
});

test('collectStoreConfig returns real credentials without exposing placeholders', () => {
    const result = collectStoreConfig({
        STORE_21633: 'real-key',
        STORE_40348: 'replace-me',
        NOT_A_STORE: 'ignored'
    });

    assert.deepEqual(result.values, { STORE_21633: 'real-key' });
    assert.deepEqual(result.invalid, ['STORE_40348']);
    assert.equal(isPlaceholder('<Order-Desk-key>'), true);
    assert.equal(isPlaceholder('real-key'), false);
});

test('mergeEnvText updates secrets while preserving unrelated local settings', () => {
    const result = mergeEnvText('PORT=4000\nINBOUND_API_KEY=old\nINBOUND_API_KEY=duplicate\n', {
        INBOUND_API_KEY: 'new',
        ADMIN_API_KEY: 'admin'
    });

    assert.equal(result, 'PORT=4000\nINBOUND_API_KEY=new\n\nADMIN_API_KEY=admin\n');
});
