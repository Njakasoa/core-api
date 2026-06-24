# Deploy — VPS + Docker + Caddy

Same shape as `ai.njakasoa.xyz`: one VPS, Docker Compose for the app + Postgres,
Caddy in front for TLS on a subdomain. Single replica → the in-memory rate
limiter, WebSocket rooms and webhook dispatcher all work as-is.

## 1. DNS

Add an A record `api.njakasoa.xyz → <VPS_IP>` (DNS-only / grey cloud, so Caddy
can issue the certificate over HTTP-01).

## 2. First deploy (on the VPS)

```bash
git clone https://github.com/Njakasoa/core-api.git /opt/stacks/core-api
cd /opt/stacks/core-api

# Secrets — generate a strong JWT secret and a DB password.
cat > .env <<EOF
JWT_SECRET=$(openssl rand -base64 48)
POSTGRES_PASSWORD=$(openssl rand -base64 24)
CORS_ORIGINS=https://njakasoa.xyz
EOF

docker compose -f deploy/docker-compose.prod.yml up -d --build
docker compose -f deploy/docker-compose.prod.yml logs -f api   # watch boot
```

The container runs migrations on start (`bun run db:migrate`) then serves on
`127.0.0.1:3000`.

## 3. Caddy

Append `deploy/Caddyfile.example` to your Caddyfile and reload:

```bash
cat deploy/Caddyfile.example >> /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

Verify: `curl https://api.njakasoa.xyz/healthz` → `{"status":"ok"}`,
docs at `https://api.njakasoa.xyz/docs`.

## 4. Updating

```bash
cd /opt/stacks/core-api && git pull
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

(Or wire a one-line cron like the ai-server stack does for auto-pull + rebuild.)

## Notes

- **Postgres**: this runs Postgres in a container with a named volume. For
  production durability you may prefer a managed Postgres — just point
  `DATABASE_URL` at it and drop the `db` service.
- **Scaling past one box**: add Redis for a global rate limit + cross-instance
  WebSocket fan-out, and run the webhook dispatcher as a single worker. See
  `ARCHITECTURE.md`.
- **Backups**: `docker compose -f deploy/docker-compose.prod.yml exec db \
  pg_dump -U core core_api > backup.sql`.
