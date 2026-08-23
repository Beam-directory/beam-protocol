#!/bin/sh
set -eu

secure_secret_file() {
  secret_path="$1"
  secret_name="$2"

  if [ -z "$secret_path" ] || [ ! -s "$secret_path" ]; then
    echo "Missing or empty mounted secret: $secret_name" >&2
    exit 1
  fi

  chown node:node "$secret_path"
  chmod 0400 "$secret_path"
}

if [ "$(id -u)" = "0" ]; then
  secure_secret_file "${BEAM_MCP_OAUTH_CLIENT_SECRET_FILE:-}" BEAM_MCP_OAUTH_CLIENT_SECRET_FILE
  secure_secret_file "${BEAM_PUBLIC_KEY_BASE64_FILE:-}" BEAM_PUBLIC_KEY_BASE64_FILE
  secure_secret_file "${BEAM_PRIVATE_KEY_BASE64_FILE:-}" BEAM_PRIVATE_KEY_BASE64_FILE
  secure_secret_file "${BEAM_API_KEY_FILE:-}" BEAM_API_KEY_FILE

  exec su-exec node:node "$@"
fi

exec "$@"
