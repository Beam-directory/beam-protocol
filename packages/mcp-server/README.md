# Beam MCP server

Expose signed Beam handoffs and Beam Network collaboration to Grok, Codex, and other MCP clients in either of two modes:

- local `stdio`, with the Beam signing identity kept on the user's machine;
- dedicated-tenant Streamable HTTP, with OAuth, revocation-aware token introspection, resource binding, scopes, and content-free audit events.

The server offers:

- `beam_status`: read public directory and trust metadata;
- `beam_prepare_handoff`: validate the target and preview a handoff without sending it;
- `beam_network_identity`, `beam_network_discover`, and `beam_network_connections`: inspect the connected identity, find identities, and list contacts or pending requests;
- `beam_network_conversations` and `beam_network_messages`: read the direct/group inbox and a selected conversation;
- `beam_send`: deliver only when the deployment enables send, OAuth grants `beam:send`, the target passes operator policy, and the exact call has `confirmed=true` after human approval;
- `beam_network_request_connection`, `beam_network_respond_connection`, `beam_network_open_direct`, `beam_network_create_group`, and `beam_network_send_message`: signed Network writes available only in the same explicitly enabled send profile and only with exact human confirmation.

Payment status is not identity assurance. The server reports Beam's independent verification and trust data, but does not claim that an unverified target is safe.

## Build and Beam identity

Build the workspace, then provide the dedicated Beam identity through the process environment or a secret manager. Do not put credentials in a committed config file.

```bash
npm run build --workspace=@beam-protocol/mcp-server

export BEAM_ID='grok@your-org.beam.directory'
export BEAM_PUBLIC_KEY_BASE64='...'
export BEAM_PRIVATE_KEY_BASE64='...'
export BEAM_API_KEY='...'
```

Optional Beam policy:

```bash
export BEAM_DIRECTORY_URL='https://api.beam.directory'
export BEAM_MCP_ALLOWED_INTENTS='conversation.message'
export BEAM_MCP_REQUIRE_VERIFIED_TARGET='true'
export BEAM_MCP_MIN_VERIFICATION_TIER='verified'
export BEAM_MCP_MIN_TRUST_SCORE='0.5'
```

Only `conversation.message` is enabled by default. Verified targets, the `verified` assurance tier, and a minimum trust score of `0.5` are also required by default. Set `BEAM_MCP_MIN_VERIFICATION_TIER=business` for a KYB-reviewed cross-company workflow or `enterprise` for the highest governed tier. These settings are operator policy, not tool inputs, so a prompt cannot waive them. Tool output exposes the coarse assurance tier and status, never the underlying identity documents.

Assurance imported from a federated directory is shown as a remote assertion
but is treated as `basic`/`unverified` by policy. A peer cannot make itself
eligible for delivery by claiming `verified`, `business`, or `enterprise` in
its agent document.

## Local Grok CLI

The default transport is `stdio`. After building, register the local server with the absolute path to `dist/index.js`:

```bash
grok mcp add beam -- node /absolute/path/to/beam-protocol/packages/mcp-server/dist/index.js
```

Configure the four Beam identity secrets in the Grok MCP environment. First call `beam_status`, then `beam_prepare_handoff`, show the preview to the human, and call `beam_send` only after approval.

## Codex

For a dedicated remote tenant, configure the Streamable HTTP connector once and complete OAuth:

```bash
codex mcp add beam --url 'https://mcp.your-org.example/mcp'
codex mcp login beam
codex mcp list
```

The Codex-compatible Beam plugin package is under `integrations/codex/beam`. It intentionally does not hard-code a tenant URL, so installing the workflow can never select another organization's signing identity.

## Dedicated-tenant remote connector

Remote mode is an OAuth resource server, not an authorization server. Deploy an external OAuth 2.1 authorization server that:

- publishes RFC 8414 or OpenID Connect discovery metadata;
- supports authorization code flow and PKCE `S256`;
- supports a Grok-compatible client registration path: pre-registration, Client ID Metadata Documents, or Dynamic Client Registration;
- publishes the exact configured RFC 7662 introspection endpoint;
- issues short-lived tokens with `active`, numeric `exp`, `client_id`, scopes, and an `aud` or `resource` claim equal to the exact MCP URL;
- grants users and tenants only the Beam scopes allowed by organization policy.

Configure the resource server. `BEAM_MCP_OAUTH_CLIENT_ID` and
`BEAM_MCP_OAUTH_CLIENT_SECRET` are the MCP resource server's confidential
introspection credentials, not Grok's client credentials. Every secret also
accepts a mutually exclusive `_FILE` variant; mounted files are the production
default.

```bash
export BEAM_MCP_TRANSPORT='http'
export BEAM_MCP_PUBLIC_URL='https://mcp.your-org.example/mcp'
export BEAM_MCP_HTTP_HOST='127.0.0.1'
export BEAM_MCP_HTTP_PORT='3333'

export BEAM_MCP_OAUTH_ISSUER='https://identity.your-org.example'
export BEAM_MCP_OAUTH_METADATA_URL='https://identity.your-org.example/.well-known/oauth-authorization-server'
export BEAM_MCP_OAUTH_INTROSPECTION_URL='https://identity.your-org.example/oauth/introspect'
export BEAM_MCP_OAUTH_CLIENT_ID='beam-mcp-resource-server'
export BEAM_MCP_OAUTH_CLIENT_SECRET_FILE='/run/secrets/oauth_client_secret'

export BEAM_PUBLIC_KEY_BASE64_FILE='/run/secrets/beam_public_key'
export BEAM_PRIVATE_KEY_BASE64_FILE='/run/secrets/beam_private_key'
export BEAM_API_KEY_FILE='/run/secrets/beam_api_key'

# Baseline remote deployments expose no Network tools and no writes.
export BEAM_MCP_ENABLE_NETWORK='false'
export BEAM_MCP_ENABLE_SEND='false'

node packages/mcp-server/dist/index.js
```

For a reproducible non-root container build from the repository root:

```bash
npm run container:build --workspace=@beam-protocol/mcp-server
npm run container:scan --workspace=@beam-protocol/mcp-server
npm run container:sbom --workspace=@beam-protocol/mcp-server > beam-mcp.cdx.json
```

Hash the scan report, SBOM, and container E2E output before copying their
digests into the external pilot evidence file. Do not commit a report that
contains credentials, tokens, private registry URLs, or internal hostnames.

Use `.env.remote.example` only as a name/reference checklist. In production,
mount secret files from the platform secret manager. Do not set a secret's
direct environment variable and `_FILE` variant together. A ready-to-render
dedicated read-only tenant is available under
[`ops/mcp-tenant`](../../ops/mcp-tenant/README.md).

A lower-level hardened local runtime shape is:

```bash
docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --env-file /secure/path/beam-mcp.env \
  --publish 127.0.0.1:3333:3333 \
  beam-mcp:local
```

Keep the published port loopback-only and place the public HTTPS reverse proxy in front of it. The image runs as the unprivileged `node` user and includes a Host-aware `/health` probe.
The minimal Alpine runtime base is pinned by digest and excludes npm, npx, Corepack, Yarn, and
their global dependency trees; package managers exist only in the builder
stage.

Terminate TLS at a hardened reverse proxy or load balancer and forward only to the configured loopback listener. Production URLs and OAuth endpoints must use HTTPS. The insecure loopback override exists only for automated local integration tests.

Optional comma-separated `BEAM_MCP_ALLOWED_HOSTS` and `BEAM_MCP_ALLOWED_ORIGIN_HOSTS` extend the exact public hostname allowlists. They should normally remain unset.

### Enable remote delivery deliberately

The remote server does not publish Network tools by default. To add the read-only contact list and inbox first:

```bash
export BEAM_MCP_ENABLE_NETWORK='true'
```

This does not enable any write. To expose Network write tools and `beam_send` in a separately reviewed profile:

```bash
export BEAM_MCP_ENABLE_SEND='true'
```

The protected endpoint then requires both `beam:read` and `beam:send`. This is in addition to the target-verification policy and `confirmed=true`; it does not replace human approval.

Network send also requires a dedicated X25519 keypair mounted as
`BEAM_DH_PUBLIC_KEY_BASE64_FILE` and `BEAM_DH_PRIVATE_KEY_BASE64_FILE`, with the
public half registered on the connector's Beam identity. The connector
decrypts inbox content and encrypts outgoing Network messages locally; the
Directory receives only the signed opaque envelope.

### Connect Grok

Grok CLI supports remote HTTP MCP with an automatic OAuth browser flow:

```bash
grok mcp add --transport http beam https://mcp.your-org.example/mcp
grok mcp doctor beam
```

For Grok Business or Enterprise, an administrator provisions a Custom connector in the Grok connector console, enters the same public MCP URL, and completes the OAuth flow. Grok's servers must be able to reach the endpoint over the public internet. Temporary tunnels are suitable only for controlled evaluation, not production.

## Security boundary

- OAuth access tokens are introspected for every request, must be active and unexpired, and must be bound to the exact MCP resource URL.
- The inbound OAuth token is never forwarded to Beam or another downstream service.
- Remote send is absent unless explicitly enabled; read and send scopes remain distinct.
- The signing key and Beam API key stay in the service secret store and never appear in tool output or audit events.
- The Network X25519 private key stays in the same tenant secret store and is never sent to the Directory or MCP client.
- Message size is capped at 4 KiB, structured context at 16 KiB, and HTTP MCP requests at 1 MiB.
- Destination Beam IDs must exist, the intent allowlist is enforced, and target verification/trust policy cannot be changed by a prompt.
- The send tool is non-read-only, non-idempotent, open-world, and requires exact human confirmation.
- Host and Origin validation are fail-closed.
- Remote tool audit records contain timestamp, OAuth client/subject/tenant, tool, outcome, target, and intent. They contain no access token, private key, message, or context.

Remote mode is intentionally a dedicated-tenant deployment with one Beam signing identity. Do not place credentials for multiple organizations behind one shared instance. A future multi-tenant service needs vault-backed key isolation, tenant-bound routing, per-tenant authorization, retention controls, and a separate threat review.

## Production gates

Before connecting a real Grok organization:

1. verify the authorization server's client registration path with Grok;
2. verify exact resource audience, scopes, expiry, revocation, and disabled-user behavior;
3. store both Beam and introspection credentials in a managed secret store with rotation;
4. ship structured stderr audit events to the organization's protected log sink;
5. restrict service egress to the OAuth and Beam endpoints;
6. run read-only first, then enable send only after the operator and rollback path are named;
7. complete an external end-to-end pilot with a separate partner Beam identity.

The hosted release gate additionally requires a fresh external read-only Grok
pilot evidence file. Copy
`reports/1.7.0-mcp-pilot-evidence.template.json`, replace every placeholder,
set `template=false`, hash the redacted artifacts, and run:

```bash
npm run production:mcp-pilot
```

## End-to-end proof

From the repository root, run the local path through MCP policy, the Directory HTTP relay, WebSocket ticket authentication, ACL enforcement, and a signed partner Result Frame:

```bash
npm run test:mcp-e2e
```

Remote OAuth integration must additionally be tested against the selected authorization server and Grok tenant; the repository cannot prove that external configuration by itself.

When Docker host networking is available, the production-shaped local
container path can also be exercised with the official MCP client, mounted
secret files, a real HTTP listener, OAuth metadata/introspection, and a mock
Directory over TCP:

```bash
npm run test:mcp-container-e2e
```
