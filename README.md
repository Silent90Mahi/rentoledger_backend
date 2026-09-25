# RentOLedger API

Node.js REST API for RentOLedger: properties, units, tenants, agreements, rent entries, payments, expenses,
reports, notifications and the tenant portal. It is a standalone service. The Flutter app talks to it over HTTP
only, so it can be deployed on its own.

**Stack:** Node.js ≥ 20.12 · TypeScript · Express 5 · MongoDB 6+ (official driver, replica-set transactions) · Zod validation ·
JWT + rotating refresh tokens · pino logging · Vitest + Supertest.

## Run locally

```bash
npm install
npm run dev
```

`npm run dev` needs no database install:

1. Loads `.env` if present (optional; see [.env.example](.env.example)).
2. Uses `MONGODB_URI` if set. Otherwise it starts a **local single-node MongoDB replica set** in `./.data/mongo` on port 27027
   (via the `mongodb-memory-server` dev dependency; the first run downloads the official `mongod` binary once and caches it).
3. Creates the indexes, and loads demo data if the database is empty.
4. Starts the API on **http://localhost:4000/api/v1** with auto-restart on file changes and the background scheduler.

In development the OTP code is always **123456** and is also returned by `/auth/otp/request` (`devCode`).
Demo sign-ins: owner **98765 43210**, partner **98765 43211**, tenants **98123 45673** (Ayushi) and **98123 45674** (Neha).

Check it: `curl http://localhost:4000/ready`

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local API + embedded database + demo data, with watch mode |
| `npm test` | Test suite (starts its own throwaway in-memory MongoDB replica set, separate from dev data) |
| `npm run typecheck` | TypeScript check of `src`, `scripts` and `tests` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server (`node dist/src/server.js`) |
| `npm run db:migrate` | Create collections and indexes (idempotent; the server also does this on start) |
| `npm run db:seed` | Load demo data into an empty database |
| `npm run db:reset` | Drop the database, recreate indexes and load fresh demo data (refused in production) |
| `npm run jobs:run` | Run the scheduled jobs once (rent generation, reminders, cleanup) and print a report |
| `npm run migrate:prod` | Create indexes with the compiled build (production) |

The `db:*` and `jobs:run` scripts use `MONGODB_URI` when set, otherwise the local development database
(reusing it if `npm run dev` is already running).

## Configuration

All settings are environment variables, validated at startup ([src/config/env.ts](src/config/env.ts)).
[.env.example](.env.example) documents each one. In production the server refuses to start without:

- `MONGODB_URI` pointing at a **replica set** (MongoDB Atlas, or `mongod --replSet`): transactions need one
- `JWT_ACCESS_SECRET` (≥ 32 chars) and `OTP_SECRET` (≥ 16 chars). Generate them with `openssl rand -hex 32`.
- A real SMS provider (`SMS_PROVIDER=twilio` + `TWILIO_*`), unless you explicitly set `ALLOW_CONSOLE_SMS_IN_PRODUCTION=true`.

It also refuses a `DEV_OTP_CODE`. Set `CORS_ORIGINS` to the web app's origin(s) and `TRUST_PROXY=1` behind a load balancer.

## Project layout

```
src/
  server.ts            process entry: waits for the DB, ensures indexes, HTTP server, scheduler, graceful shutdown
  app.ts               Express app: request IDs + logging, helmet, CORS, JSON body limit, health/ready, API router, errors
  routes.ts            mounts module routers with auth/role guards
  config/              env validation, logger
  db/                  MongoDB client + transaction helper, indexes (uniqueness rules), CLI, demo seed
  jobs/                scheduler (lease-locked), reminder/cleanup tasks, one-off runner
  lib/                 dates (pure YYYY-MM-DD maths), money, phone normalisation, validation helpers, errors, HTTP envelope
  middleware/          authentication/roles, rate limits, error handler
  modules/<feature>/   *.routes.ts (HTTP + Zod schemas) and *.service.ts (business logic + queries)
    rents/billing.ts         pure billing engine (periods, proration, escalation, GST)
    rents/generation.service idempotent rent-entry generation
    payments/allocation      applies payments to entries (target first, then oldest), advance credit
    rents/charge-query       aggregation stages deriving paid/balance/status of rent entries
    finance/finance.queries  shared balance/collection aggregations used by dashboard, reports and tenants
scripts/               dev launcher, local MongoDB helper, dev DB wrapper for CLI scripts
tests/                 API, engine and concurrency tests against a real MongoDB replica set
docs/API.md            API reference
```

## Deploying

The API is a stateless container or Node process plus MongoDB 6.0 or newer running as a replica set (MongoDB Atlas works out of the box).

**Docker**

```bash
docker build -t rentoledger-api .
docker run -p 4000:4000 --env-file .env.production rentoledger-api
```

The image is multi-stage, runs as a non-root user and has a `HEALTHCHECK` on `/health`.
Indexes (which also carry the uniqueness rules) are created on boot; creating an existing index is a no-op, so several
instances can start together. `node dist/src/db/cli.js migrate` does the same as a separate release step.

**docker compose** (API + MongoDB single-node replica set, production mode):

```bash
export JWT_ACCESS_SECRET=$(openssl rand -hex 32) OTP_SECRET=$(openssl rand -hex 32)
docker compose up --build -d
docker compose exec api node dist/src/db/cli.js seed --force   # optional: demo data on an empty database
```

**Without Docker** (any Node host or PaaS):

```bash
npm ci && npm run build && npm prune --omit=dev
NODE_ENV=production MONGODB_URI=... JWT_ACCESS_SECRET=... OTP_SECRET=... npm run migrate:prod
NODE_ENV=production ... npm start
```

**Koyeb** (Docker build from GitHub + MongoDB Atlas):

1. MongoDB Atlas → Network Access → add `0.0.0.0/0` (Koyeb has no fixed outbound IPs); Database Access → a user with
   *readWrite* on the `rentoledger` database.
2. Koyeb → Create Web Service → GitHub → this repository. Builder: **Dockerfile** (repository root). Instance: any.
3. Port: `8000`, protocol HTTP, public path `/`. Health check: HTTP `GET /health` on port 8000.
4. Environment variables (store the ones marked 🔒 as Koyeb **secrets**):

   | Variable | Value |
   |---|---|
   | `MONGODB_URI` 🔒 | `mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority` |
   | `MONGODB_DB` | `rentoledger` |
   | `JWT_ACCESS_SECRET` 🔒 | output of `openssl rand -hex 32` |
   | `OTP_SECRET` 🔒 | output of `openssl rand -hex 32` |
   | `PORT` | `8000` |
   | `TRUST_PROXY` | `1` |
   | `CORS_ORIGINS` | your web app's origin, e.g. `https://app.example.com` |
   | `SMS_PROVIDER` + `TWILIO_*` 🔒 | real SMS; or temporarily `SMS_PROVIDER=console` with `ALLOW_CONSOLE_SMS_IN_PRODUCTION=true` (codes appear in Koyeb logs) |

5. Deploy. Indexes are created on start-up; check `https://<app>.koyeb.app/ready`.
   Optional demo data on an empty database: Koyeb → Service → Console → `node dist/src/db/cli.js seed --force`.
6. Build the Flutter app with `--dart-define=API_BASE_URL=https://<app>.koyeb.app/api/v1`.

Operational notes:

- **Health:** `/health` (liveness) and `/ready` (checks the database) are unauthenticated and outside the API prefix.
- **Scaling out:** scheduled jobs take a lease document in the `locks` collection, so only one instance runs them per cycle.
  Set `JOBS_ENABLED=false` on instances that should only serve HTTP.
- **MongoDB Atlas:** use the `mongodb+srv://` connection string it gives you (TLS and credentials are in the URI) and allow the server's IP in Network Access.
- **Backups:** use Atlas backups, or `mongodump --uri "$MONGODB_URI" --archive=backup.gz --gzip` on a schedule.
- **Logs** are JSON on stdout (pino). Tokens, OTP codes and authorization headers are redacted. Every request has an `X-Request-Id`.
- **Shutdown:** on SIGTERM it stops the scheduler, drains HTTP connections and closes the pool (15 s limit).

## API

See [docs/API.md](docs/API.md) for every endpoint, the response envelope, error codes and business rules.
