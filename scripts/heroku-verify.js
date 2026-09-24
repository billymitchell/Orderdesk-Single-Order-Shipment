import {
    parseHerokuArgs,
    parseJson,
    runHeroku,
    validateHerokuAppName
} from './heroku-common.js';

const help = `Usage: npm run heroku:verify -- --app YOUR_APP_NAME

Checks the app, Postgres attachment, required config, latest releases, web dyno,
and the public /health/ready endpoint. Secret values are never printed.`;

const checks = [];
const record = (name, passed, details) => {
    checks.push({ name, passed, details });
    console.info(`${passed ? 'PASS' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};

const main = async () => {
    const options = parseHerokuArgs(process.argv.slice(2));
    if (options.help) {
        console.info(help);
        return;
    }
    const appName = validateHerokuAppName(options.app);

    runHeroku(['--version']);
    runHeroku(['auth:whoami']);
    const appInfo = parseJson(runHeroku(['apps:info', '--app', appName, '--json']), 'app information');
    record('Heroku app', true, appName);

    const addons = runHeroku(['addons', '--app', appName]);
    record('Heroku Postgres', addons.toLowerCase().includes('heroku-postgresql'), 'attached as durable storage');
    try {
        runHeroku(['pg:info', '--app', appName]);
        record('Postgres status', true, 'available');
    } catch (error) {
        record('Postgres status', false, error.message);
    }

    const remoteConfig = parseJson(runHeroku(['config', '--app', appName, '--json']), 'app configuration');
    const required = ['DATABASE_URL', 'INBOUND_API_KEY'];
    const missing = required.filter((name) => !remoteConfig[name]);
    const storeCount = Object.entries(remoteConfig)
        .filter(([name, value]) => /^STORE_\d+$/.test(name) && Boolean(value)).length;
    if (storeCount === 0) missing.push('STORE_<id>');
    if (remoteConfig.INBOUND_API_KEY && remoteConfig.INBOUND_API_KEY.length < 32) {
        missing.push('INBOUND_API_KEY (must be at least 32 characters)');
    }
    record('Required config', missing.length === 0, missing.length === 0
        ? `${storeCount} store credential(s); values hidden`
        : `missing or invalid: ${missing.join(', ')}`);

    try {
        runHeroku(['releases', '--app', appName]);
        record('Release history', true, 'available');
    } catch (error) {
        record('Release history', false, error.message);
    }

    const processes = runHeroku(['ps', '--app', appName]);
    record('Web dyno', /web\.\d+.*\bup\b/i.test(processes), 'one running web dyno is required');

    const baseUrl = appInfo.web_url || appInfo.webUrl || `https://${appName}.herokuapp.com/`;
    const healthUrl = new URL('/health/ready', baseUrl).toString();
    try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(15000) });
        const body = await response.json().catch(() => null);
        const healthy = response.ok && body?.status === 'ok' && body?.database === 'ok' && body?.worker?.running === true;
        record('Readiness endpoint', healthy, `${response.status} ${healthUrl}`);
    } catch (error) {
        record('Readiness endpoint', false, error.message);
    }

    if (checks.some((check) => !check.passed)) {
        console.error('Verification failed. Review the failed checks and Heroku Activity logs.');
        process.exitCode = 1;
        return;
    }
    console.info('Heroku deployment is ready to accept durably queued shipments.');
};

main().catch((error) => {
    console.error(`[heroku:verify] ${error.message}`);
    process.exitCode = 1;
});
