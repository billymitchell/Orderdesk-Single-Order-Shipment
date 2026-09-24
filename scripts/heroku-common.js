import { spawnSync } from 'node:child_process';

const APP_NAME_PATTERN = /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/;
const PLACEHOLDER_PATTERN = /^(?:<.*>|replace(?:-me|_me| with|-)?.*|your[-_ ].*|change[-_ ]?me|example)$/i;

export const parseHerokuArgs = (argv) => {
    const result = { app: null, yes: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--yes' || argument === '-y') {
            result.yes = true;
        } else if (argument === '--help' || argument === '-h') {
            result.help = true;
        } else if (argument === '--app' || argument === '-a') {
            result.app = argv[index + 1];
            index += 1;
        } else if (argument.startsWith('--app=')) {
            result.app = argument.slice('--app='.length);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return result;
};

export const validateHerokuAppName = (appName) => {
    if (!appName) throw new Error('Heroku app name is required. Use --app YOUR_APP_NAME.');
    if (!APP_NAME_PATTERN.test(appName)) {
        throw new Error('Heroku app name must contain 3-30 lowercase letters, numbers, or hyphens and start with a letter.');
    }
    return appName;
};

export const isPlaceholder = (value) => {
    const normalized = String(value ?? '').trim();
    return normalized.length === 0 || PLACEHOLDER_PATTERN.test(normalized);
};

export const collectStoreConfig = (environment) => {
    const entries = Object.entries(environment)
        .filter(([name]) => /^STORE_\d+$/.test(name))
        .sort(([left], [right]) => left.localeCompare(right));
    const invalid = entries.filter(([, value]) => isPlaceholder(value)).map(([name]) => name);
    const values = Object.fromEntries(entries.filter(([, value]) => !isPlaceholder(value)));
    return { values, invalid };
};

export const mergeEnvText = (original, updates) => {
    const updateValues = new Map(Object.entries(updates));
    const written = new Set();
    const lines = original ? original.replace(/\r\n/g, '\n').split('\n') : [];
    const merged = lines.flatMap((line) => {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
        if (!match || !updateValues.has(match[1])) return [line];
        if (written.has(match[1])) return [];
        written.add(match[1]);
        return [`${match[1]}=${updateValues.get(match[1])}`];
    });

    while (merged.length > 0 && merged.at(-1) === '') merged.pop();
    const pending = [...updateValues].filter(([name]) => !written.has(name));
    if (pending.length > 0 && merged.length > 0) merged.push('');
    for (const [name, value] of pending) merged.push(`${name}=${value}`);
    return `${merged.join('\n')}\n`;
};

export const runHeroku = (args, { hideFailureOutput = false } = {}) => {
    const result = spawnSync('heroku', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error?.code === 'ENOENT') {
        throw new Error('Heroku CLI is not installed or is not available on PATH.');
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const details = hideFailureOutput
            ? 'Heroku rejected the configuration update; no secret values were printed.'
            : (result.stderr || result.stdout || 'Heroku command failed.').trim();
        throw new Error(details);
    }
    return result.stdout.trim();
};

export const parseJson = (value, description) => {
    try {
        return JSON.parse(value);
    } catch {
        throw new Error(`Heroku returned invalid JSON for ${description}.`);
    }
};
