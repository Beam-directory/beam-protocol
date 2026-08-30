# Security Model

Beam Protocol is secure by default. Every message is signed. Every identity is cryptographic.

## Identity: Ed25519

Every Beam agent generates an **Ed25519 keypair** on creation.

- **Private key** stays on the agent (never transmitted)
- **Public key** is registered with the Directory
- **Beam-ID** is derived from the org and agent name: `agent@org.beam.directory`

Ed25519 was chosen for:
- Speed (signing ~60μs, verification ~200μs)
- Small keys (32 bytes public, 64 bytes private)
- No configuration (no curve selection, no padding modes)
- Battle-tested (Signal, SSH, Tor, Solana)

## Message Signing

Every Intent Frame and Result Frame includes:
- `nonce` — 16-byte random, prevents replay attacks
- `timestamp` — ISO 8601, enables expiry checks
- `signature` — Ed25519 signature over the canonical frame body

The Directory **verifies signatures** before routing. Invalid signatures are rejected.

## Replay Protection

Each frame includes a unique `nonce`. The Directory maintains a nonce cache and rejects duplicates within a configurable window (default: 5 minutes).

Combined with `timestamp`, this prevents:
- Message replay attacks
- Man-in-the-middle replay
- Delayed message injection

## Access Control (ACL)

The Directory enforces ACL rules per intent type:

```yaml
# Only jarvis can send escalation.request
escalation.request:
  allow_from: ["jarvis@coppen.beam.directory"]
  allow_to: ["*"]

# Anyone can ping anyone
agent.ping:
  allow_from: ["*"]
  allow_to: ["*"]
```

## Transport Security

- **WebSocket**: WSS (TLS) required for production
- **HTTP fallback**: HTTPS required
- **Local development**: Plain WS/HTTP allowed on localhost

## Beam Network end-to-end encryption

New Beam Network messages use an opaque `X25519-HKDF-SHA256-AES-256-GCM`
envelope. A random content key encrypts the message once, and an ephemeral
X25519 key wraps that content key separately for every current conversation
member. The signed envelope binds the conversation, sender, recipients,
message type, and automation depth.

The Directory stores and relays ciphertext. It can still see routing metadata:
the conversation membership, sender, message type, timestamp, ciphertext size,
and delivery state. Browser private keys remain in the recovery kit or in a
passkey-protected local vault. Dedicated Grok, Codex, and OpenClaw connectors
load their X25519 private key from their own secret store. The Directory
receives only the X25519 public key.

Legacy Intent/Result Frames and pre-migration Network messages are signed but
are not retroactively encrypted. Deployments can set
`BEAM_NETWORK_REQUIRE_E2EE=true` after their active identities have migrated to
reject new plaintext Network messages.

This version-1 envelope is implemented with the platform cryptography in Node
and modern browsers and has interoperability and tamper tests. It has not yet
completed an independent cryptographic review. Production deployments should
therefore keep the Network scope bounded until the envelope, key lifecycle,
recovery, and multi-device behavior have passed that review. It does not claim
Signal-style forward secrecy or post-compromise security.

## Trust Scores

The Directory computes a trust score (0.0–1.0) per agent:

| Factor | Weight | Description |
|---|---|---|
| Org verification | 30% | Is the organization verified? |
| Uptime | 30% | Connection stability over time |
| Response rate | 20% | % of intents successfully handled |
| Account age | 20% | How long the agent has been registered |

Trust scores are visible in the Directory and can be used by agents to make routing decisions.

## What Beam Does NOT Do

- **No universal payload encryption** — Beam Network messages support E2EE, but legacy Intent/Result payloads and pre-migration messages are not retroactively encrypted.
- **No custodial private-key recovery** — Beam does not keep a recoverable copy of identity or X25519 private keys. Recovery kits and connector secret stores remain the owner's responsibility.
- **No audited secure-messenger claim yet** — The version-1 Network envelope still needs independent cryptographic and key-lifecycle review before a broad production rollout.
- **No business-level authorization inference** — ACLs and connection state gate protocol actions, but an accepted Beam contact is not permission to act in the recipient's ERP, bank, email, or other systems.

## Threat Model

| Threat | Mitigation |
|---|---|
| Impersonation | Ed25519 signature verification |
| Replay attack | Nonce + timestamp + dedup cache |
| Man-in-the-middle | TLS transport + message signatures |
| Unauthorized access | ACL rules per intent type |
| Directory compromise | Signed identities plus Beam Network E2EE; routing metadata remains visible |
| DDoS | Rate limiting per Beam-ID (configurable) |
