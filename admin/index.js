// Everything under /admin: sign-in pages, the dashboard, and its JSON API.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { createAuth, normalizeAllowedEmail, missingConfig, allowedDomain } from './auth.js';
import { createApi } from './api.js';
import * as pages from './pages.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin');

const defaultLog = (level, message, details = {}) => {
    const line = JSON.stringify({ level, message, time: new Date().toISOString(), ...details });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
};

export function createAdmin({ pool, log = defaultLog, supabaseFactory } = {}) {
    const router = express.Router();
    const auth = createAuth({ pool, log, supabaseFactory });

    router.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"]
            }
        },
        crossOriginEmbedderPolicy: false
    }));
    router.use((req, res, next) => {
        res.set('X-Robots-Tag', 'noindex, nofollow');
        res.set('Cache-Control', 'no-store');
        next();
    });
    router.use(cookieParser());
    router.use(express.urlencoded({ extended: false, limit: '10kb' }));

    // Styles and scripts hold no data, so they load without a session.
    router.use('/static', express.static(path.join(PUBLIC_DIR, 'static'), { index: false, maxAge: 0 }));

    router.use((req, res, next) => {
        const missing = missingConfig();
        if (!missing.length) {
            return next();
        }
        if (req.path.startsWith('/api/')) {
            return res.status(503).json({ success: false, message: 'Dashboard is not configured.' });
        }
        return res.status(503).send(pages.notConfiguredPage(missing));
    });

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: Number(process.env.ADMIN_LOGIN_RATE_LIMIT || 10),
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res) => {
            const email = String((req.body && req.body.email) || '');
            const page = req.path === '/verify'
                ? pages.verifyPage({ email, error: 'Too many attempts. Wait 15 minutes and try again.' })
                : pages.loginPage({ email, domain: allowedDomain(), error: 'Too many attempts. Wait 15 minutes and try again.' });
            res.status(429).send(page);
        }
    });

    router.get('/login', async (req, res, next) => {
        try {
            if (await auth.loadSession(req)) {
                return res.redirect(303, '/admin');
            }
            return res.send(pages.loginPage({ domain: allowedDomain() }));
        } catch (error) {
            return next(error);
        }
    });

    router.post('/login', limiter, async (req, res, next) => {
        try {
            const typed = String(req.body.email || '').trim().slice(0, 254);
            const email = normalizeAllowedEmail(typed);
            if (!typed) {
                return res.status(400).send(pages.loginPage({
                    domain: allowedDomain(),
                    error: 'Enter your work email.'
                }));
            }
            if (email) {
                await auth.requestCode(email);
            } else {
                log('info', 'admin.login.rejected_domain', { domain: typed.split('@').pop() });
            }
            // Same screen either way, so the form never confirms who can sign in.
            const query = new URLSearchParams({ email: typed });
            if (req.body.resend) {
                query.set('sent', '1');
            }
            return res.redirect(303, `/admin/verify?${query}`);
        } catch (error) {
            return next(error);
        }
    });

    router.get('/verify', (req, res) => {
        const email = String(req.query.email || '').slice(0, 254);
        if (!email) {
            return res.redirect(303, '/admin/login');
        }
        return res.send(pages.verifyPage({
            email,
            info: req.query.sent ? 'A new code was requested.' : null
        }));
    });

    router.post('/verify', limiter, async (req, res, next) => {
        try {
            const typed = String(req.body.email || '').trim().slice(0, 254);
            const email = normalizeAllowedEmail(typed);
            const result = email
                ? await auth.verifyCode(email, req.body.code)
                : { ok: false, reason: 'domain not allowed' };
            if (!result.ok) {
                log('info', 'admin.verify.failed', { reason: result.reason });
                return res.status(401).send(pages.verifyPage({
                    email: typed,
                    error: "That code didn't work. Check it, or send a new one."
                }));
            }
            await auth.createSession(res, { email, user: result.user, session: result.session, req });
            log('info', 'admin.login.success', { email });
            return res.redirect(303, '/admin');
        } catch (error) {
            return next(error);
        }
    });

    router.post('/logout', async (req, res, next) => {
        try {
            const session = await auth.loadSession(req);
            if (session) {
                await auth.signOut(session);
            }
            res.clearCookie(auth.COOKIE_NAME, { path: '/admin' });
            return res.redirect(303, '/admin/login');
        } catch (error) {
            return next(error);
        }
    });

    // Everything below needs a signed-in Centricity user.
    router.use(auth.requireAuth);

    router.get('/', (req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });

    router.use('/api', createApi({ pool }));

    return router;
}

