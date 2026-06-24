# Architecture

core-api is a single stateless HTTP+WebSocket process backed by Postgres.
Everything that would block horizontal scaling is kept out of process memory
(except two clearly-marked, swappable caches).

```
                 ┌────────────────────────────────────────┐
   client  ─────▶│  load balancer / Caddy (TLS)           │
   ws      ─────▶│                                        │
                 └───────────────┬────────────────────────┘
                                 │  (N identical replicas)
                 ┌───────────────▼────────────────────────┐
                 │  Bun + Hono                            │
                 │   middleware → routes → drizzle        │
                 │   /rt  WebSocket gateway (rooms)       │
                 │   webhook dispatcher (background)      │
                 └───────────────┬────────────────────────┘
                                 │
                          ┌──────▼──────┐
                          │  Postgres   │
                          └─────────────┘
```

## Request lifecycle

`requestId → logger → secureHeaders → cors → bodyLimit → rateLimit`
(`/v1/*`) → **route** → `requireAuth → requireOrg → [requireRole/requireScope]
→ [idempotency] → handler`. Errors thrown anywhere land in the global handler
(`middleware/error-handler.ts`) and become a consistent envelope:

```json
{ "error": { "code": "forbidden", "message": "…", "details": null } }
```

## Layout

```
src/
  index.ts            Bun.serve (fetch + websocket) + graceful shutdown
  app.ts              Hono assembly, middleware, route mounting, OpenAPI/docs
  env.ts              zod-validated, typed environment
  types.ts            Hono context variables (auth, org)
  db/
    schema.ts         all tables (Drizzle pg-core)
    index.ts          connection pool + drizzle client
    migrate.ts        apply migrations on deploy
  lib/                errors, ids, crypto, jwt, pagination, totp, webhooks, validate
  middleware/         auth, org-scope, rate-limit, idempotency, logger, error-handler
  routes/             health, auth, orgs, api-keys, items (sample), webhooks
  realtime/ws.ts      authenticated WebSocket rooms
  workers/            in-process webhook dispatcher
```

## Identity & tenancy

Two principal kinds (`src/types.ts`):

- **user** — a JWT names a user; the active org comes from `X-Org-Id` and
  membership is verified per request.
- **apiKey** — `sk_…` is hashed and looked up; it is permanently bound to one
  org and carries scopes.

`requireOrg` normalizes both into `c.var.org = { id, role }` so handlers never
care which kind authenticated. Tenant isolation is enforced by always filtering
queries on `org_id`.

## Tokens

- Access: short-lived HS256 JWT (`ACCESS_TTL`).
- Refresh: opaque random token, only its SHA-256 is stored; **rotated** on every
  use (old one revoked) so token theft is detectable and bounded.
- API keys / webhook secrets: shown once, stored hashed.

## What lives in process memory (and how to scale past it)

Two caches are in-memory for simplicity; both have a comment and a clear swap:

- **Rate limiter** (`middleware/rate-limit.ts`) — per-instance fixed window.
  For a global limit across replicas, back it with Redis (`INCR` + `EXPIRE`).
- **WebSocket rooms** (`realtime/ws.ts`) — a process only knows its own
  sockets. To broadcast across replicas, fan messages out via Redis pub/sub or
  a Durable Object keyed by room; the `broadcast()` API stays the same.

The **webhook dispatcher** runs in-process on a timer. With multiple replicas,
run it as a single dedicated worker (or move to a real queue) to avoid double
sends — delivery rows already carry `attempts`/`nextAttemptAt` for backoff.

## Deploy

The image is stateless. `CMD` runs `db:migrate` then starts the server.

1. Build & push the image (`docker build -t core-api .`).
2. Point `DATABASE_URL` at managed Postgres; set a real 32+ char `JWT_SECRET`.
3. Run N replicas behind a TLS terminator (Caddy/your LB). `/healthz` is
   liveness, `/readyz` checks the database.
4. Scale by adding replicas. Add Redis when you need a global rate limit or
   cross-instance realtime fan-out (see above).
