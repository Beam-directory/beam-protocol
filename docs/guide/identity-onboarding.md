# Beam identity onboarding

Beam onboarding separates the human account, workspace, agent identity, and Grok connector. They are related, but they are not the same credential.

## The four objects

1. **Human session** — a magic-link session identifies the operator and grants a workspace role.
2. **Workspace** — the tenant boundary for members, policies, identities, partner channels, and audit history.
3. **Beam ID** — the agent identity, signing key, API key, DID, and verification state.
4. **MCP connector** — the dedicated service Grok reaches over HTTPS and authorizes through OAuth.

Personal identities use `agent@beam.directory`. Organization identities use `agent@org.beam.directory` and require the organization's one-time API credential as namespace proof.

## Managed Grok onboarding

The dashboard route `/register` implements the managed path:

1. Sign in and select a workspace you own.
2. Choose the agent name, display name, type, and capabilities.
3. For an organization workspace, provide its organization API key. The value is checked for that request and is not stored in the workspace or audit log.
4. Beam atomically reserves the Beam ID, creates an Ed25519 keypair and agent API key, and binds the identity to the workspace.
5. Download the one-time `beam-local-identity/v1` bundle. The response is `Cache-Control: no-store`; secret material is not written to browser storage or rendered as text.
6. Provision one dedicated read-only MCP tenant from the bundle. Put the private key, agent API key, and OAuth client secret in the tenant secret store.
7. In Grok, add the tenant's public HTTPS MCP URL and complete OAuth.

The initial connector exposes only `beam_status` and `beam_prepare_handoff`. `beam_send` remains absent until a separately reviewed send-enabled profile is approved.

## Credential bundle

The one-time bundle includes SDK-compatible key names:

```json
{
  "format": "beam-local-identity/v1",
  "beamId": "grok@acme.beam.directory",
  "did": "did:beam:acme:grok",
  "workspaceSlug": "acme-grok",
  "directoryUrl": "https://api.beam.directory",
  "publicKeyBase64": "...",
  "privateKeyBase64": "...",
  "apiKey": "bk_..."
}
```

The API stores the public key and hashes the API key. It does not retain a recoverable copy of the private key or plaintext agent API key. Losing the bundle requires an authenticated credential reissue, which rotates and revokes the prior signing key.

## Ownership rules

- Public registration can create an unclaimed personal Beam ID once.
- Reposting an existing Beam ID returns `409 BEAM_ID_ALREADY_REGISTERED`; registration is never an update or rotation endpoint.
- Organization Beam IDs require a registered organization plus its API key.
- Merely attaching an existing agent to a workspace does not give that workspace key-rotation authority.
- Only identities provisioned by the workspace are marked `credentialManaged` and can be reissued by a workspace owner.
- New managed identities start unlisted and cannot initiate external handoffs.

## Current deployment boundary

The control plane and dedicated-tenant package implement the safe onboarding contract. Automatic tenant creation and secret-vault provisioning are still an infrastructure operation, so a completed Beam-ID step does not by itself mean the Grok connector is live. Production proof requires the public MCP URL, OAuth flow, read-only tool list, revocation, monitoring, and an external operator run.
