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

- **No encryption at rest** — Beam signs messages but does not encrypt payloads. Use TLS for transport encryption.
- **No key management** — Agents manage their own keys. Beam does not provide a KMS.
- **No authorization logic** — Beam authenticates (verifies identity) but does not authorize (decide permissions). That's the agent's responsibility.

## Threat Model

| Threat | Mitigation |
|---|---|
| Impersonation | Ed25519 signature verification |
| Replay attack | Nonce + timestamp + dedup cache |
| Man-in-the-middle | TLS transport + message signatures |
| Unauthorized access | ACL rules per intent type |
| Directory compromise | Agents verify peer signatures independently |
| DDoS | Rate limiting per Beam-ID (configurable) |
