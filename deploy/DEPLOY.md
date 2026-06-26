# Deploy — VPS + Docker + Caddy

Same shape as `ai.njakasoa.xyz`: one VPS, Docker Compose for the app + Postgres,
and the central Caddy container in front for TLS. Caddy and the API communicate
over the external Docker network named `proxy`.

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
POSTGRES_PASSWORD=$(openssl rand -hex 32)
CORS_ORIGINS=https://njakasoa.xyz,https://warzone.njakasoa.xyz,https://quiz.njakasoa.xyz
EOF

docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f api
```

The container runs migrations on start (`bun run db:migrate`) then serves on
port 3000 of the shared `proxy` network. The port is not published on the host.

## 3. Caddy

Append `deploy/Caddyfile.example` to `/opt/stacks/proxy/Caddyfile`, validate,
and reload the central Caddy container:

```bash
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

Verify: `curl https://api.njakasoa.xyz/healthz` → `{"status":"ok"}`,
docs at `https://api.njakasoa.xyz/docs`.

## 4. Updating

### Automatic deployment

Install the systemd service and timer once:

```bash
cd /opt/stacks/core-api
sudo install -m 0644 deploy/systemd/core-api-update.service \
  /etc/systemd/system/core-api-update.service
sudo install -m 0644 deploy/systemd/core-api-update.timer \
  /etc/systemd/system/core-api-update.timer
sudo systemctl daemon-reload
sudo systemctl enable --now core-api-update.timer
```

Every minute, the timer fetches `origin/main`. When the revision changes, it:

1. refuses to deploy over tracked local changes;
2. fast-forwards the checkout to `origin/main`;
3. validates Compose and rebuilds the API image;
4. recreates the services without deleting the PostgreSQL volume;
5. waits for `https://api.njakasoa.xyz/readyz`;
6. records the deployed commit in `.deploy/current-rev`;
7. records the result in the systemd journal.

The deployed commit marker is intentional. It lets the timer repair a partially
manual update: if the checkout is already at `origin/main` but the Docker image
was not rebuilt/recreated, the next timer run still redeploys and refreshes the
marker only after the readiness check passes.

Useful commands:

```bash
systemctl status core-api-update.timer core-api-update.service
journalctl -u core-api-update.service -n 100 --no-pager
systemctl start core-api-update.service
```

### Manual update

```bash
cd /opt/stacks/core-api
git pull --ff-only origin main
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build
```

## Notes

- **Adding a browser front-end**: any new origin that calls this API from a
  browser (e.g. `https://warzone.njakasoa.xyz`) must be added to `CORS_ORIGINS`
  in the live `.env`, then recreate the API: `docker compose --env-file .env
  -f deploy/docker-compose.prod.yml up -d`. A missing origin shows up in the
  browser as `No 'Access-Control-Allow-Origin' header is present`.
- **WebRTC TURN** (for the game on mobile data / CGNAT): create a TURN app in
  the Cloudflare dashboard (Realtime → TURN), then add its Token ID + API token
  to the live `.env` and recreate the API:
  ```
  CF_TURN_KEY_ID=<turn token id>
  CF_TURN_API_TOKEN=<turn api token>
  ```
  `POST /v1/turn/credentials` (Bearer token required — the game's guest token
  works) then returns short-lived ICE servers. Without these vars it returns
  STUN-only and players behind symmetric NAT fall back to the WS relay.
- **Postgres**: this runs Postgres in a container with a named volume. For
  production durability you may prefer a managed Postgres — just point
  `DATABASE_URL` at it and drop the `db` service.
- **Scaling past one box**: add Redis for a global rate limit + cross-instance
  WebSocket fan-out, and run the webhook dispatcher as a single worker. See
  `ARCHITECTURE.md`.
- **Backups**: `docker compose --env-file .env \
  -f deploy/docker-compose.prod.yml exec db pg_dump -U core core_api > backup.sql`.
