// Passwordless email-code sign-in through Supabase Auth, the same pattern the
// Syncore app uses:
//   1. Only @centricitynow.com addresses are accepted (normalizeAllowedEmail).
//   2. Supabase signInWithOtp emails a 6-digit code (valid 15 minutes).
//   3. verifyOtp checks the code; the returned account's email must match.
//   4. This app sets its own 8-hour HttpOnly, SameSite=Strict cookie holding a
//      random token. The DB stores only its SHA-256 hash, and the Supabase
//      tokens are stored encrypted (AES-256-GCM, AUTH_SESSION_KEY).
//   5. About every 5 minutes the session is re-checked against Supabase
//      (getUser, refreshing first when the access token is near expiry). If the
//      user can't be verified, is banned, or their email changed, the session
//      is deleted.
import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt, sha256, randomToken, isKeyConfigured } from '../lib/sessionCrypto.js';

export const COOKIE_NAME = 'orderdesk_logs_session';
const SESSION_HOURS = 8;
const RECHECK_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_S = 120;

export function allowedDomain() {
    return String(process.env.ALLOWED_EMAIL_DOMAIN || 'centricitynow.com').trim().toLowerCase();
}

// Returns the normalized address, or null when it is not an allowed company email.
export function normalizeAllowedEmail(input) {
    const email = String(input || '').trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
        return null;
    }
    const domain = email.slice(email.lastIndexOf('@') + 1);
    return domain === allowedDomain() ? email : null;
}

export function missingConfig() {
    const missing = [];
    if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!process.env.SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
    if (!isKeyConfigured()) missing.push('AUTH_SESSION_KEY');
    return missing;
}

function defaultSupabaseFactory() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
}

function cookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
        path: '/admin',
        maxAge: SESSION_HOURS * 60 * 60 * 1000
    };
}

function packTokens(session) {
    return encrypt(JSON.stringify({
        access: session.access_token,
        refresh: session.refresh_token,
        expires_at: session.expires_at
            || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600)
    }));
}

export function createAuth({ pool, log, supabaseFactory = defaultSupabaseFactory } = {}) {
    const db = pool;
    // One in-flight re-check per session, so parallel dashboard requests don't
    // race to use the same refresh token.
    const inflight = new Map();

    async function createSession(res, { email, user, session, req }) {
        const token = randomToken();
        await db.query(
            `INSERT INTO auth_sessions
                (token_hash, email, supabase_user_id, tokens_enc, checked_at, expires_at, ip, user_agent)
             VALUES ($1, $2, $3, $4, now(), now() + make_interval(hours => $5), $6, $7)`,
            [
                sha256(token),
                email,
                user.id,
                packTokens(session),
                SESSION_HOURS,
                req.ip || null,
                String(req.get('User-Agent') || '').slice(0, 300)
            ]
        );
        res.cookie(COOKIE_NAME, token, cookieOptions());
    }

    async function deleteSession(tokenHash) {
        await db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash]);
    }

    async function recheck(row) {
        const supabase = supabaseFactory();
        let tokens = JSON.parse(decrypt(row.tokens_enc));
        const nowS = Math.floor(Date.now() / 1000);

        if (!tokens.expires_at || tokens.expires_at - nowS < REFRESH_MARGIN_S) {
            const { data, error } = await supabase.auth.refreshSession({ refresh_token: tokens.refresh });
            if (error || !data || !data.session) {
                return { ok: false, reason: `refresh failed: ${error ? error.message : 'no session'}` };
            }
            tokens = JSON.parse(decrypt(packTokens(data.session)));
        }

        const { data, error } = await supabase.auth.getUser(tokens.access);
        const user = data && data.user;
        if (error || !user) {
            return { ok: false, reason: `getUser failed: ${error ? error.message : 'no user'}` };
        }
        if (String(user.email || '').toLowerCase() !== row.email) {
            return { ok: false, reason: 'email changed' };
        }
        if (user.banned_until && Date.parse(user.banned_until) > Date.now()) {
            return { ok: false, reason: 'user banned' };
        }
        if (!normalizeAllowedEmail(user.email)) {
            return { ok: false, reason: 'email no longer allowed' };
        }

        await db.query(
            'UPDATE auth_sessions SET tokens_enc = $2, checked_at = now() WHERE token_hash = $1',
            [row.token_hash, encrypt(JSON.stringify(tokens))]
        );
        return { ok: true };
    }

    async function loadSession(req) {
        const token = req.cookies && req.cookies[COOKIE_NAME];
        if (!token || typeof token !== 'string' || token.length > 200) {
            return null;
        }
        const tokenHash = sha256(token);
        const { rows } = await db.query(
            'SELECT * FROM auth_sessions WHERE token_hash = $1 AND expires_at > now()',
            [tokenHash]
        );
        const row = rows[0];
        if (!row) {
            return null;
        }

        if (Date.now() - new Date(row.checked_at).getTime() > RECHECK_MS) {
            if (!inflight.has(tokenHash)) {
                inflight.set(tokenHash, recheck(row)
                    .catch((error) => ({ ok: false, reason: error.message }))
                    .finally(() => inflight.delete(tokenHash)));
            }
            const result = await inflight.get(tokenHash);
            if (!result.ok) {
                log('warn', 'admin.session.revoked', { email: row.email, reason: result.reason });
                await deleteSession(tokenHash);
                return null;
            }
        }
        return { email: row.email, tokenHash, row };
    }

    // Middleware: pages redirect to sign-in, API calls get 401 JSON.
    function requireAuth(req, res, next) {
        loadSession(req)
            .then((session) => {
                if (session) {
                    req.user = { email: session.email };
                    req.session = session;
                    return next();
                }
                res.clearCookie(COOKIE_NAME, { path: '/admin' });
                if (req.path.startsWith('/api/')) {
                    return res.status(401).json({ success: false, message: 'Sign in required.' });
                }
                return res.redirect(303, '/admin/login');
            })
            .catch(next);
    }

    async function requestCode(email) {
        const { error } = await supabaseFactory().auth.signInWithOtp({
            email,
            options: { shouldCreateUser: process.env.SUPABASE_CREATE_USERS !== 'false' }
        });
        if (error) {
            log('warn', 'admin.login.otp_failed', { email, error: error.message, status: error.status });
        }
        return !error;
    }

    async function verifyCode(email, code) {
        const { data, error } = await supabaseFactory().auth.verifyOtp({
            email,
            token: String(code || '').replace(/\s+/g, ''),
            type: 'email'
        });
        if (error || !data || !data.user || !data.session) {
            return { ok: false, reason: error ? error.message : 'no session' };
        }
        if (String(data.user.email || '').toLowerCase() !== email) {
            return { ok: false, reason: 'email mismatch' };
        }
        return { ok: true, user: data.user, session: data.session };
    }

    async function signOut(session) {
        try {
            const tokens = JSON.parse(decrypt(session.row.tokens_enc));
            await supabaseFactory().auth.admin.signOut(tokens.access, 'local');
        } catch (error) {
            log('warn', 'admin.logout.supabase_failed', { error: error.message });
        }
        await deleteSession(session.tokenHash);
    }

    return {
        COOKIE_NAME,
        cookieOptions,
        requireAuth,
        loadSession,
        createSession,
        requestCode,
        verifyCode,
        signOut
    };
}

