---
description: Connect and verify a dedicated Beam MCP tenant
argument-hint: "[https://mcp.your-org.example/mcp]"
---

# Onboard Beam

Help the user connect a dedicated Beam MCP tenant to Grok Build.

1. If `$ARGUMENTS` contains a URL, treat it only as the proposed tenant URL. It must use HTTPS and must not contain credentials, query parameters, or a fragment. Never open or transmit secrets supplied in a URL.
2. Explain that `BEAM_MCP_URL` is the non-secret endpoint setting used by the plugin. Do not edit shell profiles, project files, or managed Grok configuration without explicit permission.
3. Ask the user to set `BEAM_MCP_URL` in the environment that launches Grok, reload the plugin, and authenticate through the OAuth browser flow.
4. Use `beam_status` and `beam_network_identity` to show the connector's own Beam ID, contact counts, and read-only/send capability. If either tool is unavailable, recommend `grok mcp doctor beam` and stop before claiming that Network onboarding succeeded.
5. Use `beam_network_connections` to show accepted contacts and pending requests. Do not create or accept a connection during onboarding unless the user separately approves that exact action.
6. If the connector is read-only, state that it can inspect trust, contacts, and conversations and prepare previews, but cannot change the network or deliver a message.
7. Do not request, display, or store Beam signing keys, API keys, OAuth tokens, or one-time identity bundles.

Creating a Beam ID and deploying a tenant are separate steps. If the user has no tenant URL, direct them to https://docs.beam.directory/guide/identity-onboarding and explain that a Beam operator must provision the dedicated MCP service.
