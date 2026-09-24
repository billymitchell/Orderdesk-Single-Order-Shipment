import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import dotenv from 'dotenv';
import {
    collectStoreConfig,
    isPlaceholder,
    mergeEnvText,
    parseHerokuArgs,
    runHeroku,
    validateHerokuAppName
} from './heroku-common.js';

const help = `Usage: npm run heroku:configure -- --app YOUR_APP_NAME [--yes]

Checks the target app and Postgres add-on, loads STORE_* credentials from .env,
generates missing inbound/admin keys, and uploads only approved config vars.
Secret values are never printed. Use --yes to skip typing the app name.`;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const envPath = path.join(projectRoot, '.env');

const readLocalEnvironment = async () => {
    let text = '';
    try {
        text = await fs.readFile(envPath, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return { text, values: { ...dotenv.parse(text), ...process.env } };
};

const writeLocalSecrets = async (original, updates) => {
    const temporaryPath = `${envPath}.tmp-${process.pid}`;
    await fs.writeFile(temporaryPath, mergeEnvText(original, updates), { mode: 0o600 });
    await fs.rename(temporaryPath, envPath);
    await fs.chmod(envPath, 0o600);
};

const generateSecret = () => randomBytes(32).toString('hex');

const confirmTarget = async (appName, storeCount, skipPrompt) => {
    console.info(`Target app: ${appName}`);
    console.info(`Order Desk store credentials found: ${storeCount}`);
    if (skipPrompt) return;

    if (!stdin.isTTY) throw new Error('Interactive confirmation requires a terminal. Use --yes after verifying the app name.');
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
        const answer = await prompt.question(`Type ${appName} to upload configuration: `);
        if (answer.trim() !== appName) throw new Error('Configuration cancelled; app name did not match.');
    } finally {
        prompt.close();
    }
};

const main = async () => {
    const options = parseHerokuArgs(process.argv.slice(2));
    if (options.help) {
        console.info(help);
        return;
    }
    const appName = validateHerokuAppName(options.app);

    console.info('Checking Heroku CLI, login, app, and Postgres add-on...');
    runHeroku(['--version']);
    runHeroku(['auth:whoami']);
    runHeroku(['apps:info', '--app', appName]);
    const addons = runHeroku(['addons', '--app', appName]);
    if (!addons.toLowerCase().includes('heroku-postgresql')) {
        throw new Error(`No Heroku Postgres add-on is attached to ${appName}. Provision it before configuring the app.`);
    }

    const local = await readLocalEnvironment();
    const stores = collectStoreConfig(local.values);
    if (stores.invalid.length > 0) {
        throw new Error(`Replace placeholder or empty values for: ${stores.invalid.join(', ')}`);
    }
    if (Object.keys(stores.values).length === 0) {
        throw new Error('No usable STORE_<id> credentials were found in .env. Add at least one Order Desk store key.');
    }

    await confirmTarget(appName, Object.keys(stores.values).length, options.yes);

    const inboundApiKey = isPlaceholder(local.values.INBOUND_API_KEY)
        ? generateSecret()
        : local.values.INBOUND_API_KEY;
    const adminApiKey = isPlaceholder(local.values.ADMIN_API_KEY)
        ? generateSecret()
        : local.values.ADMIN_API_KEY;
    if (inboundApiKey.length < 32 || adminApiKey.length < 32) {
        throw new Error('INBOUND_API_KEY and ADMIN_API_KEY must each contain at least 32 characters.');
    }

    await writeLocalSecrets(local.text, { INBOUND_API_KEY: inboundApiKey, ADMIN_API_KEY: adminApiKey });
    console.info('Saved inbound and administrator keys to the ignored local .env file.');

    const assignments = [
        'NODE_ENV=production',
        'REQUIRE_INBOUND_AUTH=true',
        'DATABASE_SSL=true',
        'DATABASE_SSL_REJECT_UNAUTHORIZED=false',
        `INBOUND_API_KEY=${inboundApiKey}`,
        `ADMIN_API_KEY=${adminApiKey}`,
        ...Object.entries(stores.values).map(([name, value]) => `${name}=${value}`)
    ];
    runHeroku(['config:set', ...assignments, '--app', appName], { hideFailureOutput: true });

    console.info(`Configured ${appName} with ${Object.keys(stores.values).length} store credential(s).`);
    console.info('Secret values were not printed. Deploy the main branch, then run:');
    console.info(`npm run heroku:verify -- --app ${appName}`);
};

main().catch((error) => {
    console.error(`[heroku:configure] ${error.message}`);
    process.exitCode = 1;
});
