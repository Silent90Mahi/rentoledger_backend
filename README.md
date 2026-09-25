# RentOLedger API

Node.js REST API for RentOLedger: properties, units, tenants, agreements, rent entries, payments, expenses,
reports, notifications and the tenant portal. It is a standalone service. The Flutter app talks to it over HTTP
only, so it can be deployed on its own.

**Stack:** Node.js ≥ 20.12 · TypeScript · Express 5 · PostgreSQL (Knex + pg) · Zod validation · JWT + rotating refresh tokens ·
pino logging · Vitest + Supertest.

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` needs no database install:

1. Loads `.env` if present (optional; see [.env.example](.env.example)).
2. Uses `DATABASE_URL` if set. Otherwise it starts an **embedded PostgreSQL** in `./.data/postgres` on port 54329.
   The first run downloads nothing extra (the binaries come with the `embedded-postgres` dev dependency) and initialises the cluster.
3. Applies migrations, and loads demo data if the database is empty.
4. Starts the API on **http://localhost:4000/api/v1** with auto-restart on file changes and the background scheduler.

In development the OTP code is always **123456** and is also returned by `/auth/otp/request` (`devCode`).
Demo sign-ins: owner **98765 43210**, partner **98765 43211**, tenants **98123 45673** (Ayushi) and **98123 45674** (Neha).

Check it: `curl http://localhost:4000/ready`

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local API + embedded database + demo data, with watch mode |
| `npm test` | Test suite (starts its own embedded PostgreSQL on port 54330, separate from dev data) |
| `npm run typecheck` | TypeScript check of `src`, `scripts` and `tests` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server (`node dist/src/server.js`) |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:rollback` | Undo the last migration batch |
| `npm run db:seed` | Load demo data into an empty database |
| `npm run db:reset` | Drop everything, migrate and load fresh demo data (refused in production) |
| `npm run jobs:run` | Run the scheduled jobs once (rent generation, reminders, cleanup) and print a report |
| `npm run migrate:prod` | Apply migrations with the compiled build (production) |

The `db:*` and `jobs:run` scripts use `DATABASE_URL` when set, otherwise the embedded development database
(reusing it if `npm run dev` is already running).

## Configuration

All settings are environment variables, validated at startup ([src/config/env.ts](src/config/env.ts)).
[.env.example](.env.example) documents each one. In production the server refuses to start without:

- `DATABASE_URL`
- `JWT_ACCESS_SECRET` (≥ 32 chars) and `OTP_SECRET` (≥ 16 chars). Generate them with `openssl rand -hex 32`.
- A real SMS provider (`SMS_PROVIDER=twilio` + `TWILIO_*`), unless you explicitly set `ALLOW_CONSOLE_SMS_IN_PRODUCTION=true`.

It also refuses a `DEV_OTP_CODE`. Set `CORS_ORIGINS` to the web app's origin(s) and `TRUST_PROXY=1` behind a load balancer.

## Project layout

```
src/
  server.ts            process entry: waits for the DB, optional auto-migrate, HTTP server, scheduler, graceful shutdown
  app.ts               Express app: request IDs + logging, helmet, CORS, JSON body limit, health/ready, API router, errors
  routes.ts            mounts module routers with auth/role guards
  config/              env validation, logger
  db/                  Knex pool, migration runner + migrations, CLI, demo seed
  jobs/                scheduler (advisory-locked), reminder/cleanup tasks, one-off runner
  lib/                 dates (pure YYYY-MM-DD maths), money, phone normalisation, validation helpers, errors, HTTP envelope
  middleware/          authentication/roles, rate limits, error handler
  modules/<feature>/   *.routes.ts (HTTP + Zod schemas) and *.service.ts (business logic + SQL)
    rents/billing.ts         pure billing engine (periods, proration, escalation, GST)
    rents/generation.service idempotent rent-entry generation
    payments/allocation      applies payments to entries (target first, then oldest), advance credit
    finance/finance.queries  shared balance/collection SQL used by dashboard, reports and tenants
scripts/               dev launcher, embedded PostgreSQL helper, dev DB wrapper for CLI scripts
tests/                 API and engine tests against a real PostgreSQL
docs/API.md            API reference
```

## Deploying

The API is a stateless container or Node process plus PostgreSQL 13 or newer.

**Docker**

```bash
docker build -t rentoledger-api .
docker run -p 4000:4000 --env-file .env.production rentoledger-api
```

The image is multi-stage, runs as a non-root user and has a `HEALTHCHECK` on `/health`.
Migrations run either as a release step (`node dist/src/db/cli.js migrate`) or on boot with `DB_AUTO_MIGRATE=true`.
Knex's migration lock makes that safe when several instances start together.

**docker compose** (API + PostgreSQL, production mode):

```bash
export JWT_ACCESS_SECRET=$(openssl rand -hex 32) OTP_SECRET=$(openssl rand -hex 32)
docker compose up --build -d
docker compose exec api node dist/src/db/cli.js seed --force   # optional: demo data on an empty database
```

**Without Docker** (any Node host or PaaS):

```bash
npm ci && npm run build && npm prune --omit=dev
NODE_ENV=production DATABASE_URL=... JWT_ACCESS_SECRET=... OTP_SECRET=... npm run migrate:prod
NODE_ENV=production ... npm start
```

Operational notes:

- **Health:** `/health` (liveness) and `/ready` (checks the database) are unauthenticated and outside the API prefix.
- **Scaling out:** scheduled jobs take a Postgres advisory lock, so only one instance runs them per cycle.
  Set `JOBS_ENABLED=false` on instances that should only serve HTTP.
- **Managed Postgres:** set `DATABASE_SSL=true` (and `DATABASE_SSL_REJECT_UNAUTHORIZED=false` only if the provider uses a self-signed CA).
- **Logs** are JSON on stdout (pino). Tokens, OTP codes and authorization headers are redacted. Every request has an `X-Request-Id`.
- **Shutdown:** on SIGTERM it stops the scheduler, drains HTTP connections and closes the pool (15 s limit).

## API

See [docs/API.md](docs/API.md) for every endpoint, the response envelope, error codes and business rules.
