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

All credential values are Fly file secrets. Store the source files outside the
repository with mode `0600`, base64-encode each file when importing it into Fly,
and never pass a secret as a command-line argument. The `*_B64` Fly secret is
decoded into the corresponding `guest_path` before the container entrypoint.

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

Expected steady-state Fly cost in Frankfurt is approximately USD 11.41 per
month before bandwidth: 256 MB MCP, 1 GB Keycloak, 512 MB PostgreSQL, and one
1 GB volume. Re-check live pricing before scaling or adding redundancy.
