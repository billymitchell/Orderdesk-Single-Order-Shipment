// AES-256-GCM helpers for storing Supabase tokens at rest, plus SHA-256 for
// session token hashes. AUTH_SESSION_KEY must be 32 bytes as 64 hex chars:
//   openssl rand -hex 32
import crypto from 'node:crypto';

function sessionKey() {
    const hex = process.env.AUTH_SESSION_KEY || '';
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('AUTH_SESSION_KEY must be 64 hex characters (openssl rand -hex 32).');
    }
    return Buffer.from(hex, 'hex');
}

export function isKeyConfigured() {
    return /^[0-9a-fA-F]{64}$/.test(process.env.AUTH_SESSION_KEY || '');
}

// Output: v1.<iv>.<tag>.<ciphertext>, each part base64url.
export function encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv, tag, ciphertext].map((part) => (
        typeof part === 'string' ? part : part.toString('base64url')
    )).join('.');
}

export function decrypt(payload) {
    const [version, iv, tag, ciphertext] = String(payload).split('.');
    if (version !== 'v1' || !iv || !tag || ciphertext === undefined) {
        throw new Error('Unrecognized encrypted payload');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final()
    ]).toString('utf8');
}

export function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}

