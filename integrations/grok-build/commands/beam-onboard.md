---
description: Connect and verify a dedicated Beam MCP tenant
argument-hint: "[https://mcp.your-org.example/mcp]"
---

# Onboard Beam

Help the user connect a dedicated Beam MCP tenant to Grok Build.

1. If `$ARGUMENTS` contains a URL, treat it only as the proposed tenant URL. It must use HTTPS and must not contain credentials, query parameters, or a fragment. Never open or transmit secrets supplied in a URL.
2. Explain that `BEAM_MCP_URL` is the non-secret endpoint setting used by the plugin. Do not edit shell profiles, project files, or managed Grok configuration without explicit permission.
3. Ask the user to set `BEAM_MCP_URL` in the environment that launches Grok, reload the plugin, and authenticate through the OAuth browser flow.
4. Use the Beam status tool to show the connector's own Beam ID and read-only/send capability. If the tool is unavailable, recommend `grok mcp doctor beam` and stop before claiming that onboarding succeeded.
5. If the connector is read-only, state that it can inspect trust and prepare previews but cannot deliver a handoff.
6. Do not request, display, or store Beam signing keys, API keys, OAuth tokens, or one-time identity bundles.

Creating a Beam ID and deploying a tenant are separate steps. If the user has no tenant URL, direct them to https://docs.beam.directory/guide/identity-onboarding and explain that a Beam operator must provision the dedicated MCP service.
