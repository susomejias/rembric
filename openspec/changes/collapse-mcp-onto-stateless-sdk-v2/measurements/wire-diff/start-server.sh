#!/bin/sh
# Usage: start-server.sh <repo-dir> <port> <data-dir>
# Runs `next dev` from <repo-dir>/apps/web in the foreground; extra env (e.g. MAX_BODY_BYTES) is inherited.
# Binds localhost, not 127.0.0.1: middleware rewrites target http://localhost:<port>, and any other origin turns the
# /dashboard/login rewrite into a proxied request that the middleware redirects back to the login page.
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <repo-dir> <port> <data-dir>" >&2
  exit 2
fi

repo=$(cd "$1" && pwd -P)
port=$2
data=$(cd "$3" && pwd -P)

case "$data" in
  "$repo" | "$repo"/*)
    echo "refusing: data dir $data is inside the repository $repo; use mktemp -d" >&2
    exit 2
    ;;
  */data-dev | */data-dev/*)
    echo "refusing: data dir $data is a data-dev directory; use mktemp -d" >&2
    exit 2
    ;;
esac

if [ -n "$(ls -A "$data")" ]; then
  echo "refusing: data dir $data is not empty; every run starts from a fresh mktemp -d" >&2
  exit 2
fi

if [ "${WIRE_SKIP_BUILD:-0}" != "1" ]; then
  pnpm --dir "$repo" --filter '@rembric/web^...' run build >&2
fi

mkdir "$data/db" "$data/no-model"
origin="http://localhost:$port"

export REMBRIC_DATA_DIR="$data/db"
export REMBRIC_ADMIN_TOKEN="${WIRE_ADMIN_TOKEN:-wire-diff-admin-token-0123456789abcdef}"
export REMBRIC_SESSION_SECRET="wire-diff-session-secret-0123456789abcdef"
export REMBRIC_PUBLIC_URL="$origin"
export REMBRIC_MCP_ALLOWED_HOSTS="${REMBRIC_MCP_ALLOWED_HOSTS:-localhost:$port}"
export REMBRIC_MCP_ALLOWED_ORIGINS="${REMBRIC_MCP_ALLOWED_ORIGINS:-$origin}"
export REMBRIC_UPDATE_CHECK=off
export REMBRIC_MODEL_CACHE="$data/no-model"
export NEXT_TELEMETRY_DISABLED=1

cd "$repo/apps/web"
exec pnpm exec next dev --port "$port" --hostname localhost
