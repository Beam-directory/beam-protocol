# Dedicated read-only Beam MCP tenant

This Compose package is the production-shaped baseline for one organization.
It deliberately exposes only a loopback port and hard-codes the remote MCP
server to read-only mode. Put a public HTTPS reverse proxy or load balancer in
front of it; do not publish port `3333` directly to the internet.

## Invariants

- one Beam identity and OAuth resource-server client per tenant;
- immutable container image digest;
- secrets mounted as files, never placed in Compose environment values;
- non-root UID/GID `1000`, read-only root filesystem, no Linux capabilities;
- `beam_send` absent and minimum target assurance fixed to `business`;
- public HTTPS URL, OAuth PKCE S256 metadata, exact token audience, Host and
  Origin validation;
- reverse-proxy request limits, rate limits, TLS policy, and access logging.

## Prepare without starting anything

1. Build and scan the image, then push it to a private registry and record its
   immutable digest.
2. Provision a dedicated Beam identity and OAuth introspection client.
3. Put each of the four secret values in a separate mode-`0600` host file
   outside the repository.
4. Copy `.env.example` to a host-local `.env` and replace every placeholder.
5. Validate interpolation without starting a container:

```bash
docker compose --env-file ops/mcp-tenant/.env \
  -f ops/mcp-tenant/compose.yaml config --quiet
```

Review the rendered configuration with `docker compose config`; it must contain
only `/run/secrets/...` paths, never the values themselves. A production host
also needs outbound HTTPS access only to the configured Beam Directory and
OAuth endpoints.

Docker Compose file-backed secrets are mounted read-only but do not honor the
Compose `uid`, `gid`, or `mode` fields. The single-process non-root container
can read them, but deployments that require an in-container `0400` guarantee
must use an orchestrator or secret-store CSI driver that enforces ownership and
mode. Do not claim the host file's `0600` mode is preserved inside Compose.

## Start only after production GO

```bash
docker compose --env-file ops/mcp-tenant/.env \
  -f ops/mcp-tenant/compose.yaml up -d
```

Then verify the public `/health` response, RFC 9728 protected-resource
metadata, an unauthenticated `401` challenge, OAuth login from Grok, and that
the tool list contains exactly `beam_status` and `beam_prepare_handoff`.
`beam_send` must not be advertised in this pilot profile.

Do not turn on delivery by editing this Compose file in place. Create a
separately reviewed send-enabled profile only after the read-only external
pilot has produced accepted evidence.
