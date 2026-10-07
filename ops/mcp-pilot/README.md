# Beam hosted MCP pilot

This directory defines the production-shaped, dedicated Fly.io pilot used for
Grok connector evidence. It is intentionally split into three apps:

- `beam-identity-db`: private PostgreSQL with one encrypted Fly volume;
- `beam-identity-pilot`: Keycloak OAuth 2.1/OIDC issuer;
- `beam-mcp-pilot`: the public Beam MCP resource server.

The checked-in Fly profile for this one-week partner test sets
`BEAM_MCP_ENABLE_NETWORK=true` and `BEAM_MCP_ENABLE_SEND=true`. Network read
tools require `beam:read`. Network write tools and `beam_send` additionally
require `beam:send`, and every write still requires `confirmed=true` for that
exact action. Incoming message text, attachment names, and connection-request
notes are returned as untrusted remote content. They are data for the human to
read, not instructions for the agent. The generic `ops/mcp-tenant` baseline
stays read-only. Every profile requires an exact resource audience and refuses
targets below Beam's independently reviewed `business` tier. Removing that last
gate is not a valid way to complete pilot evidence.

This process signs only as `grok@coppen.beam.directory`. A second person must
not log into `https://mcp.beam.directory/mcp` to act as their own agent. See
[Partner MCP access](#partner-mcp-access) below.

Directory rate limits, the 1 MiB MCP request cap, and the 2 MiB Network
response cap stay as they are. File bytes up to the Directory's 6 MB attachment
limit do not fit through those caps; that transfer is a separate change.

The pilot enables Keycloak's versioned `resource-indicators:v1` feature. The
confidential resource-server client ID and its `resource_url` attribute are both
the canonical `https://mcp.beam.directory/mcp` URL. This is required so RFC 8707
post-processing preserves the exact URL audience while allowing that same
resource server to introspect the token. `beam:read` and, for this write
stage, `beam:send` are optional and must be requested explicitly; the audience
mapper remains a default client scope.

All credential values are Fly file secrets. Store the source files outside the
repository with mode `0600`, base64-encode each file when importing it into Fly,
and never pass a secret as a command-line argument. The `*_B64` Fly secret is
decoded into the corresponding `guest_path` before the container entrypoint.
Fly initially materializes injected files with broad execute/read bits, so each
pilot image starts through a minimal root entrypoint that changes ownership and
mode to `0400`, then drops to the normal PostgreSQL, Keycloak, or Node user.

Deployment order is PostgreSQL, Keycloak, then MCP. Do not add the public DNS
records until the Fly hostnames are healthy. For this send-enabled profile,
create the optional `beam:send` scope before deploying the MCP app, then verify
the OAuth scope and the advertised tool surface. Existing Fly secrets stay in
place; this profile does not rotate them. A token that only has `beam:read`
cannot call the send-enabled endpoint, so the operator re-authorizes Grok with
`beam:read` and `beam:send` after the scope exists.

The repository provides two fail-closed helpers:

```bash
npm run build --workspace=beam-protocol-sdk
node scripts/production/prepare-mcp-pilot-secrets.mjs \
  --secret-dir /absolute/private/path

node scripts/production/configure-keycloak-mcp-pilot.mjs \
  --base-url https://identity.beam.directory
```

Both commands are dry-run-only unless `--apply` is present. The secret helper
refuses a path inside the repository or a non-empty target and never prints a
credential. The Keycloak helper creates `beam:read` by default. This pilot's
write stage passes `--enable-send-scope`, which creates the separate optional
`beam:send` scope without granting it as a default scope.

```bash
node scripts/production/configure-keycloak-mcp-pilot.mjs \
  --base-url https://identity.beam.directory \
  --enable-send-scope \
  --admin-password-file /absolute/private/keycloak_admin_password \
  --mcp-client-secret-file /absolute/private/mcp_oauth_client_secret \
  --pilot-user-password-file /absolute/private/pilot_user_password \
  --apply
```

Do not pass secret values as arguments. After that command succeeds, deploy
only the MCP app from this repository revision. Do not run `fly secrets set`
as part of this change:

```bash
fly deploy --config ops/mcp-pilot/fly/mcp.fly.toml --app beam-mcp-pilot
```

The env values that change are the two flags in `fly/mcp.fly.toml`. The file
secrets already mounted by that app stay the same: `MCP_OAUTH_CLIENT_SECRET_B64`,
`MCP_BEAM_PUBLIC_KEY_B64`, `MCP_BEAM_PRIVATE_KEY_B64`, `MCP_BEAM_API_KEY_B64`,
`MCP_BEAM_DH_PUBLIC_KEY_B64`, and `MCP_BEAM_DH_PRIVATE_KEY_B64`. Keycloak keeps
`KEYCLOAK_DB_PASSWORD_B64` and `KEYCLOAK_ADMIN_PASSWORD_B64`.

During initial DNS propagation, `--base-url` may point to the app's Fly hostname
while `--public-base-url https://identity.beam.directory` keeps every issuer and
token endpoint assertion pinned to the final public origin.

After both public endpoints are healthy, `mcp-oauth-pkce-smoke.mjs` runs a real
browser authorization-code login with PKCE S256, introspects the short-lived
token, verifies the exact MCP audience and requested Beam scopes, then connects
with the official MCP client and rejects any tool surface other than the
operator-supplied `--expected-tools` list. Passwords and tokens are never
written to its output.

The hosted pilot smoke does not prove a Grok connection by itself. For the
native Grok CLI, use the dedicated public `beam-grok-pilot` client. It is pinned
to `http://127.0.0.1:35419/callback`, requires PKCE S256, has no client secret,
and receives the Beam audience by default while `beam:read`, `beam:send`, and
`offline_access` remain explicitly requested optional scopes.

Configure Grok with the same fixed callback before authorization:

```toml
[mcp_servers.beam]
url = "https://mcp.beam.directory/mcp"
enabled = true

[mcp_servers.beam.oauth]
clientId = "beam-grok-pilot"
scopes = ["beam:read", "beam:send", "offline_access"]
callbackPort = 35419
```

The installer below performs an authorization-code login with PKCE S256,
introspects the token, verifies the exact resource audience and all requested
scopes, and atomically merges the result into Grok's owner-only
`~/.grok/mcp_credentials.json`. It never prints tokens and never calls a Beam
write or send tool:

```bash
node scripts/production/install-grok-beam-oauth.mjs \
  --password-file /absolute/private/pilot_user_password \
  --introspection-secret-file /absolute/private/mcp_oauth_client_secret

grok mcp doctor beam --json
```

Keep anonymous dynamic client registration closed for this native CLI flow.
Grok cloud connector creation, an external operator run, and a lookup of a real
business-assurance target remain separate release evidence. Do not create the
release-gate evidence file from an internal smoke or fixture.

Grok's cloud connector performs anonymous dynamic client registration from
rotating Google Cloud egress addresses. Keep anonymous registration closed in
steady state. The helper below supports a short, max-one-client registration
window and fails closed by default:

```bash
node scripts/production/configure-keycloak-grok-dcr-window.mjs \
  --mode open \
  --activate-new-client \
  --enable-send-scope \
  --trusted-domain '*.bc.googleusercontent.com' \
  --trusted-domain grok.com

node scripts/production/configure-keycloak-grok-dcr-window.mjs \
  --mode closed
```

Both commands are dry runs unless `--apply` and an admin password file are
provided. Active-client mode requires reverse-confirmed Google Cloud egress,
requires every registered client URI to match `grok.com`, and allows only one
new client. Pass `--enable-send-scope` for this write stage so the window can
offer optional `beam:send`. Without that flag the window still exposes no send
scope. Close the window immediately after the new client appears. A staging
mode without `--activate-new-client` creates the one new client disabled for
callback inspection.

After resolving the exact new Keycloak client UUID, pin and harden only that
client:

```bash
node scripts/production/finalize-keycloak-grok-client.mjs \
  --client-uuid 00000000-0000-0000-0000-000000000000
```

The finalizer verifies the exact Grok callback and origin, enforces PKCE S256,
keeps the Beam audience as the only default scope, and rotates then discards
the dynamic-registration management token. Without `--enable-send-scope` the
only optional scope is `beam:read`. With `--enable-send-scope`, `beam:send`
stays optional and is never added to the default scopes. Re-run the finalizer
with that flag after this write stage; the flag-free command removes
`beam:send` again. It never deletes older clients automatically; disable and
review any failed registration separately.

```bash
node scripts/production/finalize-keycloak-grok-client.mjs \
  --client-uuid 00000000-0000-0000-0000-000000000000 \
  --enable-send-scope \
  --admin-password-file /absolute/private/keycloak_admin_password \
  --apply
```

Confirm the live tool list after deploy. The smoke helper sorts tool names and
rejects a token that carries `beam:send` unless that scope was requested:

```bash
node scripts/production/mcp-oauth-pkce-smoke.mjs \
  --password-file /absolute/private/pilot_user_password \
  --introspection-secret-file /absolute/private/mcp_oauth_client_secret \
  --scopes 'openid beam:read beam:send' \
  --expected-tools beam_network_connections,beam_network_conversations,beam_network_create_group,beam_network_discover,beam_network_identity,beam_network_messages,beam_network_open_direct,beam_network_request_connection,beam_network_respond_connection,beam_network_send_message,beam_prepare_handoff,beam_send,beam_status
```

`npm run production:mcp-pilot` remains the read-only market-readiness gate. A
send-enabled week test does not satisfy that evidence file.

## Partner MCP access

Lakis' Grok agent needs a separate MCP process, Beam ID, and OAuth resource.
`https://mcp.beam.directory/mcp` is Tobias' connector: every signed Network
message and handoff from that process uses `grok@coppen.beam.directory`. A
second Keycloak user on the same realm, with a token for that same audience,
would send as Tobias. Do not add Lakis there.

1. Issue a dedicated Beam ID for Lakis' agent, including its own Ed25519
   signing keys, X25519 encryption keys, and agent API key. Do not copy the
   COPPEN secret files.
2. Deploy a second Fly app from the same MCP image. Change `app`,
   `BEAM_MCP_PUBLIC_URL`, `BEAM_ID`, the OAuth issuer, and the OAuth client ID.
   Keep `BEAM_MCP_ENABLE_NETWORK=true`, `BEAM_MCP_ENABLE_SEND=true`,
   `BEAM_MCP_REQUIRE_VERIFIED_TARGET=true`, and
   `BEAM_MCP_MIN_VERIFICATION_TIER=business`. Store that app's credentials as
   its own Fly file secrets. `scripts/production/configure-keycloak-mcp-pilot.mjs`
   refuses any resource other than `https://mcp.beam.directory/mcp`, so do not
   point it at the partner URL.
3. Give the partner issuer its own realm or client. `beam:read` and
   `beam:send` stay optional. The token audience must be the partner MCP URL,
   not `https://mcp.beam.directory/mcp`.
4. In Lakis' Grok plugin, set `BEAM_MCP_URL` to that HTTPS URL and request
   `beam:read`, `beam:send`, and `offline_access`. The plugin must not fall
   back to the COPPEN endpoint.
5. Both agents exchange Beam IDs, then use `beam_network_request_connection`,
   `beam_network_respond_connection`, and `beam_network_open_direct` only after
   the human approves that exact action. `beam_network_send_message` and
   `beam_send` still require `confirmed=true`. Message text read back from
   either side stays untrusted.

The two agents then exchange signed, end-to-end-encrypted messages through
`https://api.beam.directory`. Each connector encrypts with its own X25519 key.
The Directory stores ciphertext and routing metadata.

## Attachments

The Directory accepts one attachment up to 6 MB on a Network message. This MCP
profile does not send or receive those bytes. A 6 MB file is about 8 MB once
base64-encoded, which is above the 1 MiB MCP request cap and the 2 MiB Network
response cap. Raising either cap, or the 256 MB Fly machine, is a separate
change and is not part of this write stage. Decrypted attachment metadata is
still labeled untrusted when a message carries it inside the encrypted payload.

Before any general-availability decision, rescan all three exact images. The
pilot may document a time-bounded Keycloak risk exception, but an exception for
the pilot is not a market-release security signoff.

Expected steady-state Fly cost in Frankfurt is approximately USD 11.41 per
month before bandwidth: 256 MB MCP, 1 GB Keycloak, 512 MB PostgreSQL, and one
1 GB volume. Re-check live pricing before scaling or adding redundancy.
