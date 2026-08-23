#!/bin/sh
set -eu

secret_path="${POSTGRES_PASSWORD_FILE:-}"
if [ -z "$secret_path" ] || [ ! -s "$secret_path" ]; then
  echo "Missing or empty mounted secret: POSTGRES_PASSWORD_FILE" >&2
  exit 1
fi

chown root:root "$secret_path"
chmod 0400 "$secret_path"

exec /usr/local/bin/docker-entrypoint.sh "$@"
