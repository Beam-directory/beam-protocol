#!/bin/sh
set -eu

read_required_secret() {
  secret_path="$1"
  secret_name="$2"

  if [ -z "$secret_path" ] || [ ! -r "$secret_path" ]; then
    echo "Missing or unreadable mounted secret: $secret_name" >&2
    exit 1
  fi

  secret_value="$(tr -d '\r\n' < "$secret_path")"
  if [ -z "$secret_value" ]; then
    echo "Mounted secret is empty: $secret_name" >&2
    exit 1
  fi

  printf '%s' "$secret_value"
}

export KC_DB_PASSWORD="$(read_required_secret "${KC_DB_PASSWORD_FILE:-}" KC_DB_PASSWORD_FILE)"
export KC_BOOTSTRAP_ADMIN_PASSWORD="$(read_required_secret "${KC_BOOTSTRAP_ADMIN_PASSWORD_FILE:-}" KC_BOOTSTRAP_ADMIN_PASSWORD_FILE)"

exec /opt/keycloak/bin/kc.sh "$@"
