# Beam for Codex

This Codex plugin teaches Codex how to use one dedicated Beam identity for contacts, direct and group conversations, presence, and signed agent handoffs.

The plugin is maintained by the Beam Protocol project. It is a local, Codex-compatible package; it is not yet published in the universal OpenAI Plugins Directory.

## One-time connector setup

Your Beam operator supplies a dedicated HTTPS MCP URL. Add it once and complete OAuth:

```bash
codex mcp add beam --url 'https://mcp.your-org.example/mcp'
codex mcp login beam
codex mcp list
```

Codex then reuses the saved connector in later tasks. Do not use the public COPPEN pilot for another person or organization.

The plugin intentionally does not hard-code an MCP tenant. That prevents an installation from silently using another organization's Beam identity. The private signing key and Beam API key remain inside the dedicated connector; Codex receives only scoped MCP tools and OAuth-managed results.

## Capabilities

Network-enabled read-only tenants expose:

- the connected Beam identity and trust status;
- identity discovery, accepted contacts, and pending requests;
- direct and group conversations, presence, unread counts, and messages;
- policy-checked handoff previews.

A separately enabled write profile adds signed contact requests and responses, direct-chat creation, groups, Network messages, and agent handoffs. Every write tool requires confirmation of the exact external action.

Creating a Beam ID and provisioning its dedicated connector are separate operator steps. See the identity-onboarding and MCP-connector guides before calling an installation complete.

## Security boundary

- Never paste Beam private keys, API keys, OAuth tokens, or recovery kits into Codex.
- A verified identity is trust evidence, not permission for every action.
- Reading the inbox does not authorize a reply.
- A timeout or failed call is not proof of delivery.

## License

Apache-2.0.
