// Server-rendered sign-in pages. Every dynamic value goes through escapeHtml.
export function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function layout(title, body) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · Order Desk Shipment Logs</title>
<link rel="stylesheet" href="/admin/static/admin.css">
</head>
<body class="auth-page">
<main class="auth-card">
<p class="eyebrow">Centricity</p>
<h1>Order Desk Shipment Logs</h1>
${body}
</main>
</body>
</html>`;
}

function notice(message, kind = 'info') {
    if (!message) {
        return '';
    }
    return `<p class="notice notice-${escapeHtml(kind)}" role="${kind === 'error' ? 'alert' : 'status'}">${escapeHtml(message)}</p>`;
}

export function loginPage({ error, email, domain } = {}) {
    return layout('Sign in', `
<p class="lead">Sign in with your <strong>@${escapeHtml(domain)}</strong> email. We'll send you a 6-digit code.</p>
${notice(error, 'error')}
<form method="post" action="/admin/login" class="stack">
  <label for="email">Work email</label>
  <input id="email" name="email" type="email" autocomplete="email" required autofocus
         placeholder="name@${escapeHtml(domain)}" value="${escapeHtml(email)}">
  <button type="submit">Send code</button>
</form>`);
}

export function verifyPage({ email, error, info } = {}) {
    return layout('Enter code', `
<p class="lead">If <strong>${escapeHtml(email)}</strong> can sign in, a 6-digit code is on its way. It's valid for 15 minutes.</p>
${notice(error, 'error')}
${notice(info, 'info')}
<form method="post" action="/admin/verify" class="stack">
  <input type="hidden" name="email" value="${escapeHtml(email)}">
  <label for="code">Code</label>
  <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}"
         maxlength="10" required autofocus class="code-input" placeholder="123456">
  <button type="submit">Sign in</button>
</form>
<div class="auth-links">
  <form method="post" action="/admin/login">
    <input type="hidden" name="email" value="${escapeHtml(email)}">
    <input type="hidden" name="resend" value="1">
    <button type="submit" class="link-button">Send a new code</button>
  </form>
  <a href="/admin/login">Use a different email</a>
</div>`);
}

export function notConfiguredPage(missing) {
    return layout('Not configured', `
<p class="lead">The dashboard isn't set up on this server yet.</p>
<p class="notice notice-error">Missing configuration: ${missing.map(escapeHtml).join(', ')}</p>`);
}

