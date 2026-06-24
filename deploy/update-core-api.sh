#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/stacks/core-api}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"
LOCK_FILE="${LOCK_FILE:-/run/lock/core-api-update.lock}"
HEALTH_URL="${HEALTH_URL:-https://api.njakasoa.xyz/readyz}"
HEALTH_RESOLVE="${HEALTH_RESOLVE:-api.njakasoa.xyz:443:127.0.0.1}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
DRY_RUN="${DRY_RUN:-0}"

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "core-api update already running"
  exit 0
}

cd "$APP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing environment file: $APP_DIR/$ENV_FILE" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "tracked working tree changes detected; refusing automatic deployment" >&2
  exit 1
fi

git fetch --quiet origin "$BRANCH"
REMOTE_REV="$(git rev-parse "origin/$BRANCH")"
LOCAL_REV="$(git rev-parse HEAD)"

# This allows the timer to be installed before the PR containing this script is
# merged. It starts deploying only once the deployment code exists on main.
if ! git cat-file -e "origin/$BRANCH:deploy/update-core-api.sh" 2>/dev/null; then
  echo "origin/$BRANCH does not contain auto-deployment yet; nothing to do"
  exit 0
fi

if [ "$LOCAL_REV" = "$REMOTE_REV" ]; then
  echo "core-api already up to date at $LOCAL_REV"
  exit 0
fi

echo "core-api update available: $LOCAL_REV -> $REMOTE_REV"

if [ "$DRY_RUN" = "1" ]; then
  echo "dry run: deployment skipped"
  exit 0
fi

git checkout -B "$BRANCH" "origin/$BRANCH"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build api
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans

deadline=$((SECONDS + HEALTH_TIMEOUT))
until curl --fail --silent --show-error --max-time 5 \
  --resolve "$HEALTH_RESOLVE" "$HEALTH_URL" >/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "core-api deployment failed readiness check after ${HEALTH_TIMEOUT}s" >&2
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps >&2
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs \
      --no-color --tail=100 api >&2
    exit 1
  fi
  sleep 3
done

docker image prune -f >/dev/null
echo "core-api deployed successfully at $REMOTE_REV"
