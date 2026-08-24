# Grok MCP Connector

Beam can connect Grok to a signed, policy-gated agent handoff in two deployment shapes:

- local `stdio` for an individual Grok CLI user;
- dedicated-tenant Streamable HTTP for Grok Custom connectors.

The remote implementation is available in the repository. It is not proof that a production connector is already deployed or that a particular Grok organization and OAuth provider have passed an external pilot.

Start with [Beam identity onboarding](/guide/identity-onboarding) for the exact human session, workspace, Beam ID, one-time credential, and connector sequence.

## Trust boundary

Grok and MCP provide tool discovery and user authorization. Beam provides the receiving agent identity, target trust policy, signed intent and Result Frame, ACL enforcement, replay protection, and operator trace.

These are separate claims:

- an OAuth-authenticated person is not automatically an identity-verified company;
- a paid Beam plan is not KYC or KYB evidence;
- a verified organization does not authorize every employee or agent action;
- `beam:send` does not bypass the explicit human confirmation gate.

See [Trust and Assurance](/guide/trust-assurance) for the human, organization, agent, runtime, and delegated-authority layers.

## Hosted request path

```text
Grok user
  -> external OAuth 2.1 authorization server
  -> resource-bound access token
  -> dedicated Beam MCP resource server
  -> Beam target lookup and policy preview
  -> explicit human approval
  -> signed Beam handoff
  -> independently signed Result Frame
```

The MCP server publishes protected-resource metadata, returns the discovery URL in its OAuth challenge, validates active/expiry/client/scopes through token introspection, and rejects tokens not issued for its exact public URL. It never forwards the inbound OAuth token to Beam.

## Read-only first

Hosted HTTP mode defaults to read-only. It publishes `beam_status` and `beam_prepare_handoff` under `beam:read`.

`beam_send` is not registered until the operator explicitly sets `BEAM_MCP_ENABLE_SEND=true`. At that point the endpoint requires both `beam:read` and `beam:send`; target verification, the intent allowlist, and `confirmed=true` remain mandatory.

Target policy can additionally require a minimum assurance tier through `BEAM_MCP_MIN_VERIFICATION_TIER`. The default is `verified`; a cross-company pilot can require `business`, which means Beam's KYB review and domain-control gates have passed. The MCP response carries only the coarse tier/status and never raw registry or KYC evidence.

This makes the rollout sequence explicit:

1. connect Grok and prove OAuth plus directory lookup;
2. preview one real partner handoff without delivery;
3. confirm audit, ownership, rollback, and recipient policy;
4. enable send;
5. run one externally observed, signed partner handoff.

## OAuth requirements

Use an external OAuth 2.1 authorization server that supports:

- authorization code flow with PKCE `S256`;
- RFC 8414 or OpenID Connect discovery;
- a Grok-compatible registration method: pre-registration, Client ID Metadata Documents, or Dynamic Client Registration;
- RFC 7662 token introspection with revocation and disabled-user behavior;
- short-lived tokens bound through `aud` or `resource` to the exact MCP URL;
- tenant/user authorization for `beam:read` and, when approved, `beam:send`.

The server fails startup if the issuer, HTTPS endpoints, PKCE capability, or discovered introspection endpoint do not match configuration.

## Operator evidence

Remote calls produce structured content-free audit events with the OAuth client, subject and tenant claims, tool, outcome, target, and intent. Message and context content, tokens, Beam API keys, and signing keys are excluded.

The Beam Directory separately records the signed handoff lifecycle. Keep the OAuth audit and Beam trace correlated by time and operator case, while respecting the organization's retention policy.

## Configure and connect

### Grok Build plugin

The Beam-maintained Grok Build plugin lives under
[`integrations/grok-build`](https://github.com/Beam-directory/beam-protocol/tree/main/integrations/grok-build).
It bundles the Beam workflow skill, a guided onboarding command, and a remote
MCP definition. Set `BEAM_MCP_URL` to the operator-supplied dedicated tenant
URL before starting Grok. The plugin does not default to the COPPEN pilot or
another organization's connector.

The plugin does not contain executable hooks, install scripts, credentials, or
a shared signing identity. OAuth remains between Grok and the configured
dedicated tenant.

### Direct connector setup

Use the full environment reference and security gates in the [`@beam-protocol/mcp-server` README](https://github.com/Beam-directory/beam-protocol/tree/main/packages/mcp-server).
The repository also includes a hardened dedicated-tenant Compose baseline under
`ops/mcp-tenant`. It binds only to loopback, mounts all secrets as files, runs
as UID 1000 with a read-only filesystem and no capabilities, and hard-codes the
first hosted pilot to read-only with `business` target assurance.

When preparing pilot secrets for an organization Beam ID, pass the verified organization bootstrap key through an absolute, mode-`0600` file outside the repository:

```bash
node scripts/production/prepare-mcp-pilot-secrets.mjs \
  --secret-dir /absolute/private/beam-pilot \
  --beam-id grok-pilot@acme.beam.directory \
  --org-api-key-file /absolute/private/acme-org-api-key \
  --apply
```

The script reads at most 4096 bytes, never prints the key, and rejects repository-local or group/world-readable key files.

For Grok CLI, the remote connector command is:

```bash
grok mcp add --transport http beam https://mcp.your-org.example/mcp
grok mcp doctor beam
```

For Grok Business or Enterprise, an administrator provisions a Custom connector and enters the same publicly reachable HTTPS URL. The first connection completes the OAuth browser flow.

These are the two connector-management paths currently documented by xAI:
Grok Build CLI and the Grok web/business connector consoles. Installing a
desktop Grok Bot application alone is not connector evidence, and this guide
does not claim a Bot-specific MCP administration surface until one has been
observed directly.

## Not yet cleared by source code alone

The following remain production evidence, not code assertions:

- deployed TLS, secret manager, egress policy, monitoring, backups, and rollback;
- successful Grok client registration against the selected OAuth provider;
- revocation and offboarding observed in that provider;
- a separate partner identity returning a valid signed Result Frame;
- KYC/KYB vendor and review operations where the workflow requires them;
- commercial terms, support ownership, incident response, and data-processing agreements.

Use the [Production Go-Live Checklist](/guide/production-go-live-checklist) before enabling real delivery.

For the read-only hosted gate, copy
`reports/1.7.0-mcp-pilot-evidence.template.json`, record only pseudonymous and
redacted evidence, and run `npm run production:mcp-pilot`. The check requires a
fresh public HTTPS Grok connection, OAuth authorization code with PKCE S256,
exactly the two read-only tools, a business/enterprise target lookup, mounted
secrets, an immutable image digest, and hashed diagnostics/metadata/audit
artifacts plus the container SBOM, container E2E result, and vulnerability
scan. It explicitly rejects localhost rehearsals, send-enabled runs,
templates, stale evidence, and secret-bearing fields.
