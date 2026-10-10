# beam-protocol-sdk changelog

npm has 1.6.0. 1.7.0 was tagged but never published to npm. This file lists the SDK changes since 1.6.0, taken from `git log v1.6.0.. -- packages/sdk-typescript`.

## 1.9.0 (2026-10-10)

Not tagged and not on npm yet. This is the SDK on main after tag `v1.8.0`.

- add `verifyAgent(address)`. It fetches `GET /agents/:beamId/trust-assertion` and verifies the Ed25519 signature against the pinned directory key. It sends no API key.
- add the subpath export `beam-protocol-sdk/trust-assertion` with the browser-safe check helpers (`evaluateTrustCheck`, `canonicalizeJson`, `assertionSigningText`, `parseBeamAddress`, `summaryLine` and others)
- export `DIRECTORY_SIGNING_PUBLIC_KEY`, `DEFAULT_DIRECTORY_URL`, `spkiKeyId`, `verifyEd25519Spki` and the `AgentCheck` types
- `BeamClient.send()` staples the agent's own signed trust assertion next to the frame (`stapledTrust`). The client caches it and renews it before it expires. Lifetime is 24 hours by default (`trust.assertionTtlMs`). Turn it off with `trust: { staple: false }`. Frame bytes and signatures are unchanged.
- received intents carry `frame.trust = { verified, org, person, may, reason, display, expiresAt, source }`. It is checked offline against the pinned directory key, with no call to Beam. `trust.onlineFallback` adds a `verifyAgent()` lookup when nothing was stapled.
- add `verifyStapledAssertion(message, assertion)`, `checkStapledAssertion(address, assertion)`, `verifyAgentTrust(address)`, `TrustAssertionStapler` and `intentSigningText`

## 1.8.0 (tag v1.8.0, 2026-10-08)

### Breaking
- `BeamClient.send()` now returns `IntentSendResult`, which is `ResultFrame | ApprovalRequired`. When the directory answers HTTP 202 `APPROVAL_REQUIRED`, `send()` returns `{ executed: false, approvalId, errorCode: 'APPROVAL_REQUIRED' }` instead of a result frame. Check `'executed' in result` before reading `success`.
- `BeamClient.talk()` throws when the intent is held for approval. It no longer reports a held message as delivered.

### Fixed
- `BeamCredentialsClient` posts to `/agents/email`, `/agents/domain` and `/agents/business`. Earlier versions posted to `/credentials/*`, which directory 1.5.0 and 1.6.0 did not serve.

### Changed
- `BeamCredentialsClient` sends the agent API key as `x-api-key`. `BeamClient` passes its API key and updates it after `register()`.
- new exported types: `IntentSendResult`, `ApprovalRequired`

## 1.7.0 (tag v1.7.0, 2026-10-02, not on npm)

### Breaking
- `connect()` requires the agent API key. It asks the directory for a single-use WebSocket ticket (`POST /agents/:beamId/ws-ticket`) and no longer puts the API key in the WebSocket URL.
- `connect()` and `on()` require an Ed25519 identity, because result frames must be signed.
- `send()` without an identity no longer opens a WebSocket by itself.
- `CredentialVerifier.verify(vc, trustedIssuerPublicKeyMultibase)` needs the directory issuer key. Without it, or when the credential is not `verified: true`, it returns `false`. The key inside the credential is no longer trusted.

### Changed
- `register()` keeps the one-time agent API key it gets back and uses it for later calls. The `apiKey` getter returns it.
- a WebSocket that closes before Beam authenticates the session rejects `connect()`
- `AgentRecord` now carries `verificationTier`, `verificationStatus`, `assuranceScope`, `assuranceIssuer`, `remoteAssurance` and `domain` (they moved from `AgentProfile`)
- `browse({ tier })` sends `verification_tier`; `pageSize` also reads `limit`
- new exported types: `AssuranceScope`, `RemoteAssuranceAssertion`, `WebSocketTicket`
- optional dependency `ws` raised to `^8.21.0`

### Directory compatibility
- WebSocket tickets need directory 1.7.0 or newer.
- `verifyAgent()` needs `GET /agents/:beamId/trust-assertion`, which the directory serves from 1.8.0.
