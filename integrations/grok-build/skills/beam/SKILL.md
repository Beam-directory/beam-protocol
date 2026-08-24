---
name: beam
description: Use Beam to verify Beam IDs, inspect agent trust metadata, and prepare or send approval-gated agent handoffs through a dedicated Beam MCP connector. Trigger for Beam, Beam Protocol, Beam IDs, trusted agent collaboration, or cross-agent handoffs.
license: Apache-2.0
metadata:
  author: Beam Protocol Contributors
  short-description: Trusted agent identity and handoffs
---

# Beam Protocol

Use the Beam MCP tools for identity-aware collaboration between agents.

## Connector boundary

Beam's hosted MCP is a dedicated-tenant connector. The connector identity, OAuth tenant, and Beam ID are related but distinct. Never assume that signing into Grok creates a Beam ID or that a Beam ID means the MCP tenant has been deployed.

The normal tool names are namespaced by Grok as `beam__beam_status`, `beam__beam_prepare_handoff`, and, only on an explicitly send-enabled tenant, `beam__beam_send`. Use the available tool whose final segment matches the operation; do not invent a missing tool.

## Start every workflow with status

Call `beam_status` before preparing a handoff. With no target, it reports the connector's own Beam identity and capabilities. With a target Beam ID, it returns public directory and trust metadata.

Report verification state as evidence, not as a guarantee of safety. A paid plan is not identity assurance. A verified organization does not authorize every action by every agent.

## Prepare a handoff

For a proposed handoff:

1. Confirm the destination is the exact Beam ID the user intends.
2. Call `beam_status` for that destination.
3. If target policy fails or the connector returns warnings, show them without weakening or bypassing them.
4. Call `beam_prepare_handoff` with the exact destination, message, intent, and only the minimum non-secret context required.
5. Present the returned preview, warnings, and digest. Say clearly: **prepared, not sent**.

Never include credentials, access tokens, signing keys, private identity bundles, or unrelated personal data in the message or context.

## Sending, when available

Most hosted tenants expose no send tool. If `beam_send` is absent, stop after the preview and do not claim delivery.

If `beam_send` is available:

1. Show the user the exact destination, intent, and final message after the preview.
2. Obtain explicit human approval for that exact delivery.
3. Call `beam_send` only after approval and set `confirmed=true` only for the approved payload.
4. Report the returned delivery or Result Frame accurately. If the call times out or fails, do not infer delivery.

Approval for a draft, a different destination, or an earlier version is not approval to send.

## Onboarding failures

If Beam tools are missing or the connector cannot authenticate:

- check that `BEAM_MCP_URL` is set to the operator-supplied HTTPS tenant endpoint;
- recommend `grok mcp doctor beam`;
- complete the OAuth browser flow on first use;
- do not ask the user to paste OAuth tokens, Beam API keys, or signing keys into chat;
- do not substitute the COPPEN pilot or any other organization's endpoint.

If the user has a Beam ID but no MCP URL, explain that dedicated tenant provisioning is still required. Use the Beam onboarding guide at https://docs.beam.directory/guide/identity-onboarding.
