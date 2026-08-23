# Beam read-only hosted MCP pilot

This directory defines the production-shaped, dedicated Fly.io pilot used for
Grok connector evidence. It is intentionally split into three apps:

- `beam-identity-db`: private PostgreSQL with one encrypted Fly volume;
- `beam-identity-pilot`: Keycloak OAuth 2.1/OIDC issuer;
- `beam-mcp-pilot`: the public Beam MCP resource server.

The MCP app is hard-coded to `BEAM_MCP_ENABLE_SEND=false`, publishes only the
two read-only tools, requires an exact resource audience, and refuses targets
below Beam's independently reviewed `business` tier. Removing that last gate is
not a valid way to complete pilot evidence.

The pilot enables Keycloak's versioned `resource-indicators:v1` feature. The
confidential resource-server client ID and its `resource_url` attribute are both
the canonical `https://mcp.beam.directory/mcp` URL. This is required so RFC 8707
post-processing preserves the exact URL audience while allowing that same
resource server to introspect the token. `beam:read` is optional and must be
requested explicitly; the audience mapper remains a default client scope.

All credential values are Fly file secrets. Store the source files outside the
repository with mode `0600`, base64-encode each file when importing it into Fly,
and never pass a secret as a command-line argument. The `*_B64` Fly secret is
decoded into the corresponding `guest_path` before the container entrypoint.
Fly initially materializes injected files with broad execute/read bits, so each
pilot image starts through a minimal root entrypoint that changes ownership and
mode to `0400`, then drops to the normal PostgreSQL, Keycloak, or Node user.

Deployment order is PostgreSQL, Keycloak, then MCP. Do not add the public DNS
records until the Fly hostnames are healthy. Keep the pull request in draft and
do not enable `beam_send` during this pilot.

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
credential. The Keycloak helper creates only `beam:read`; it does not create a
send scope.

During initial DNS propagation, `--base-url` may point to the app's Fly hostname
while `--public-base-url https://identity.beam.directory` keeps every issuer and
token endpoint assertion pinned to the final public origin.

After both public endpoints are healthy, `mcp-oauth-pkce-smoke.mjs` runs a real
browser authorization-code login with PKCE S256, introspects the short-lived
token, verifies the exact MCP audience and `beam:read` scope, then connects with
the official MCP client and rejects any tool surface other than the two
read-only tools. Passwords and tokens are never written to its output.

The hosted pilot smoke does not prove a Grok connection by itself. Grok cloud
connector creation, an external operator run, and a lookup of a real
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
  --trusted-domain '*.bc.googleusercontent.com' \
  --trusted-domain grok.com

node scripts/production/configure-keycloak-grok-dcr-window.mjs \
  --mode closed
```

Both commands are dry runs unless `--apply` and an admin password file are
provided. Active-client mode requires reverse-confirmed Google Cloud egress,
requires every registered client URI to match `grok.com`, allows only one new
client, and exposes no send scope. Close the window immediately after the new
client appears. A staging mode without `--activate-new-client` creates the one
new client disabled for callback inspection.

After resolving the exact new Keycloak client UUID, pin and harden only that
client:

```bash
node scripts/production/finalize-keycloak-grok-client.mjs \
  --client-uuid 00000000-0000-0000-0000-000000000000
```

The finalizer verifies the exact Grok callback and origin, enforces PKCE S256,
keeps only the Beam audience plus optional `beam:read`, and rotates then
discards the dynamic-registration management token. It never deletes older
clients automatically; disable and review any failed registration separately.

Before any general-availability decision, rescan all three exact images. The
read-only pilot may document a time-bounded Keycloak risk exception, but an
exception for the pilot is not a market-release security signoff.

Expected steady-state Fly cost in Frankfurt is approximately USD 11.41 per
month before bandwidth: 256 MB MCP, 1 GB Keycloak, 512 MB PostgreSQL, and one
1 GB volume. Re-check live pricing before scaling or adding redundancy.
