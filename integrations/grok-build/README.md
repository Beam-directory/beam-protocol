# Beam for Grok Build

The Beam plugin lets Grok verify Beam IDs, inspect public trust metadata, and prepare policy-checked agent handoffs through a dedicated Beam MCP tenant.

This plugin is maintained by the Beam Protocol project. It is a third-party plugin submitted to the xAI marketplace; it is not authored, verified, or endorsed by xAI.

## What it adds

- the `beam` skill for Beam ID lookup and approval-gated handoff workflows;
- the `/beam-onboard` command for connector setup and verification;
- a remote HTTP MCP definition named `beam`.

The default hosted tenant profile is read-only. It exposes `beam_status` and `beam_prepare_handoff`. A preview is never a delivery. A separately reviewed tenant may expose `beam_send`, but the plugin requires explicit approval of the exact destination and content before any send call.

## Requirements

You need:

1. Grok Build;
2. a dedicated, publicly reachable HTTPS Beam MCP tenant URL;
3. access to that tenant through its OAuth provider.

Beam MCP is intentionally deployed per tenant. Do not point this plugin at another organization's connector. The public COPPEN pilot is not a shared Beam service.

## Configure

Set the non-secret tenant URL before starting Grok Build:

```bash
export BEAM_MCP_URL='https://mcp.your-org.example/mcp'
grok
```

Install and trust the plugin from the marketplace, then reload the Plugins tab or start a new session. On first use, Grok opens the tenant's OAuth flow.

Verify the connection:

```bash
grok mcp doctor beam
```

Then ask Grok to show the connected Beam identity or run `/beam-onboard`.

If your organization does not yet have a tenant, start with the [Beam Grok connector guide](https://docs.beam.directory/guide/grok-mcp-connector) and [identity onboarding](https://docs.beam.directory/guide/identity-onboarding). Tenant provisioning remains an operator-controlled infrastructure step; creating a Beam ID alone does not deploy a connector.

## Security and data flow

The plugin contains no executable hooks, helper binaries, install scripts, telemetry, or static credentials. It does not read project files, `.env` files, SSH keys, or token stores.

Grok connects only to the HTTPS URL the operator explicitly places in `BEAM_MCP_URL`. OAuth tokens are managed by Grok and sent to that MCP resource. The plugin itself does not read or forward them. The remote tenant may call the Beam Directory at `https://api.beam.directory` to look up public identity and trust data and, only in a separately enabled delivery profile, submit a signed Beam handoff.

Never put a token, API key, signing key, or private business content in `BEAM_MCP_URL` or in a Beam tool argument. The URL must not contain credentials, query parameters, or fragments.

For the server-side trust boundary and deployment controls, see the [`@beam-protocol/mcp-server` documentation](https://github.com/Beam-directory/beam-protocol/tree/main/packages/mcp-server).

## License

Apache-2.0. See the [Beam Protocol license](https://github.com/Beam-directory/beam-protocol/blob/main/LICENSE).
