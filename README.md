# core-api

A tiny, hyperscalable API starter. The minimal core every service starts
from — nothing you'll have to rip out later.

**Stack:** [Bun](https://bun.sh) · [Hono](https://hono.dev) ·
[Drizzle](https://orm.drizzle.team) + Postgres · [Zod](https://zod.dev).
Stateless and horizontally scalable: run one container or a hundred behind a
load balancer.

## What's in the box

- **Auth** — email + password (argon2id), JWT access tokens, rotating refresh
  tokens, optional **2FA / TOTP** with recovery codes.
- **API keys** — scoped, machine-to-machine, hashed at rest, shown once.
- **Multi-tenant** — organizations with members and roles; every resource is
  org-scoped.
- **Realtime** — authenticated WebSocket gateway with rooms (the foundation for
  multiplayer / live features).
- **Webhooks** — subscribe endpoints to events, signed (HMAC) deliveries with
  retries and backoff.
- **Idempotency** — `Idempotency-Key` on writes, replayed safely.
- **OpenAPI** — generated from the routes, served at `/openapi.json` with
  interactive docs at `/docs`.
- **Ops** — zod-validated env, structured logs, request ids, rate limiting,
  CORS, secure headers, liveness/readiness probes, graceful shutdown, CI.

## Quickstart

```bash
# 1. Everything (api + postgres) with Docker
docker compose up --build
# → http://localhost:3000  ·  docs at /docs

# — or — run the app on the host against your own Postgres:
cp .env.example .env          # set DATABASE_URL + JWT_SECRET
bun install
bun run db:migrate
bun run dev
```

Then:

```bash
# Register (creates a user + a default org + a session)
curl -sX POST localhost:3000/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"password123"}'
```

## Add your own API

The `items` resource is a working template. To add a `widgets` API:

1. Add a `widgets` table in `src/db/schema.ts`, then
   `bun run db:generate && bun run db:migrate`.
2. Copy `src/routes/items.ts` → `src/routes/widgets.ts`, swap the table.
3. Mount it in `src/app.ts`: `app.route("/v1/widgets", widgetsRoute())`.

You get auth, org-scoping, pagination, idempotency, validation, OpenAPI and
webhook events for free.

## Auth model

Send a `Bearer` token on every `/v1/*` request:

- **User token** (JWT from login) → also send `X-Org-Id` to pick the active org.
- **API key** (`sk_…`) → bound to its org, no `X-Org-Id` needed.

```
Authorization: Bearer <jwt | sk_...>
X-Org-Id: org_...        # user tokens only
Idempotency-Key: <uuid>  # optional, on POST
```

## Realtime

```js
const ws = new WebSocket(`wss://host/rt?token=${accessToken}`);
ws.send(JSON.stringify({ type: "join", room: "game-42" }));
ws.send(JSON.stringify({ type: "broadcast", room: "game-42", data: { move: "e4" } }));
```

## Scripts

| command | what |
| --- | --- |
| `bun run dev` | watch-mode dev server |
| `bun run db:generate` | generate a migration from the schema |
| `bun run db:migrate` | apply migrations |
| `bun test` | run the test suite |
| `bun run typecheck` | `tsc --noEmit` |

## Deploy

Stateless container — see [ARCHITECTURE.md](./ARCHITECTURE.md#deploy). Build the
image, point `DATABASE_URL` at a managed Postgres, set a real `JWT_SECRET`, and
run as many replicas as you need. `CMD` runs migrations then starts the server.

## License

MIT.
