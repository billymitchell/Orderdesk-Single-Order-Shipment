# Heroku deployment

The normal deployment requires three commands after Heroku Postgres is provisioned:

```sh
heroku login
npm run heroku:configure -- --app YOUR_APP_NAME
npm run heroku:verify -- --app YOUR_APP_NAME
```

Run the verification command after deploying the repository.

## Before configuring

1. Install the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli).
2. Provision Heroku Postgres from the app's **Resources** page. Heroku creates `DATABASE_URL` automatically; never edit it.
3. Use a non-sleeping web dyno plan. Eco sleeping pauses the queue worker.
4. Keep exactly one web dyno until the process-local Order Desk rate limiter is replaced with a shared limiter.
5. Put the real Order Desk credentials in the ignored local `.env` file:

```env
STORE_21633=real-order-desk-api-key
STORE_40348=real-order-desk-api-key
```

Only add stores this deployment accepts. Do not put secrets in `.env.example`.

## Configure the app

Run:

```sh
npm run heroku:configure -- --app YOUR_APP_NAME
```

The command:

- Checks the Heroku CLI login, target app, and Postgres attachment.
- Lists the number of `STORE_<id>` credentials without displaying their values.
- Refuses empty or placeholder store credentials.
- Makes you type the target app name before changing it.
- Generates missing 64-character inbound and administrator keys.
- Saves generated keys to the ignored local `.env` file with owner-only permissions.
- Uploads only authentication, database TLS, runtime, and `STORE_<id>` variables.
- Never uploads the local `DATABASE_URL` or `PORT`.
- Never prints secret values.

For non-interactive use after independently confirming the target app:

```sh
npm run heroku:configure -- --app YOUR_APP_NAME --yes
```

Heroku runtime detection also supplies safe defaults if the explicit runtime/TLS variables are later removed: production mode, inbound authentication, PostgreSQL SSL, and the documented Node.js certificate behavior.

## Deploy

Run the local checks:

```sh
npm ci
npm test
npm audit --omit=dev --audit-level=high
```

Commit and push the changes:

```sh
git add .
git commit -m "Add durable shipment queue and Heroku deployment"
git push origin main
```

Deploy `main` from the Heroku **Deploy** page, or enable automatic deployments for the GitHub repository.

The `Procfile` runs:

```text
release: npm run migrate
web: npm start
```

The release phase applies migrations before the new release receives traffic. A failed migration prevents promotion. One `web` dyno runs both the HTTP API and durable worker; do not add a separate worker dyno.

## Verify

After the deployment finishes, run:

```sh
npm run heroku:verify -- --app YOUR_APP_NAME
```

It checks:

- The target app and Heroku login
- Heroku Postgres attachment and availability
- `DATABASE_URL`, the inbound key, and at least one store key without printing values
- Release history
- A running web dyno
- The public `/health/ready` response, database check, and worker state

Every line must report `PASS`. If a check fails, review **Heroku → Activity → View build log** and the application logs:

```sh
heroku logs --tail --app YOUR_APP_NAME
```

## Production cutover

1. Verify the new Heroku deployment before sending it traffic.
2. Stop new submissions to the legacy deployment.
3. Let the legacy in-memory queue drain completely.
4. Route incoming traffic to Heroku.
5. Submit one controlled shipment with a unique `Idempotency-Key` and the generated `INBOUND_API_KEY` from local `.env`.
6. Poll its `status_url` until it reaches `completed` or `completed_with_errors`.
7. Confirm the expected shipment in Order Desk.
8. During a second controlled batch, restart the dyno and verify the jobs resume:

```sh
heroku ps:restart web --app YOUR_APP_NAME
```

The initial `202 Accepted` means Postgres committed the jobs. It does not mean Order Desk accepted every shipment.

## Operations and rollback

Monitor `/health/ready`, oldest queued-job age, retries, failed jobs, database storage, and release failures. Define a retention policy before the terminal-job history fills the selected database plan. Never delete `queued`, `processing`, or `retrying` jobs.

For rollback, stop incoming traffic and keep a durable version running until all committed jobs are terminal. Roll back only to a release that understands the PostgreSQL queue schema. Never send new traffic to the old in-memory version while Postgres contains active jobs.

## Heroku references

- [Provisioning Heroku Postgres](https://devcenter.heroku.com/articles/provisioning-heroku-postgres)
- [Node.js runtime support](https://devcenter.heroku.com/articles/nodejs-support)
- [Release phase](https://devcenter.heroku.com/articles/release-phase)
- [Connecting to Heroku Postgres](https://devcenter.heroku.com/articles/connecting-heroku-postgres)
- [Eco dyno sleeping behavior](https://devcenter.heroku.com/articles/eco-dyno-hours)
