# Security Overview

Beam Protocol is designed to make inter-agent communication verifiable, replay-resistant, and policy-aware without requiring heavyweight PKI or vendor-specific identity systems.

## Core security properties

### Ed25519 identities

Every Beam agent has an Ed25519 key pair.

- the **public key** is registered with the directory
- the **private key** signs outgoing frames
- receivers verify signatures using the sender's published key

This avoids shared secrets between agents and allows any compliant implementation to verify origin authenticity.

## Signed frames

Both Intent Frames and Result Frames are signed.

The signature covers the canonical form of the frame body, excluding the signature field itself.

Security implications:

- the sender cannot deny authorship of a valid frame they signed
- intermediaries cannot silently change payload fields without invalidating the signature
- recipients can verify origin before executing work

## Replay protection

Beam uses two anti-replay primitives:

- **nonce**: a unique identifier per request
- **timestamp**: the frame creation time in UTC

A directory can reject a frame when:

- the nonce has already been seen
- the timestamp falls outside the allowed replay window

This blocks simple capture-and-replay attacks even when the original signature remains valid.

## ACL enforcement

Directories can apply access-control rules before a frame reaches the recipient.

Example policy:

- only `crm@acme.beam.directory` may send `payment.status_check` to `billing@acme.beam.directory`

This is useful for:

- internal segmentation
- least-privilege routing
- reducing attack surface for sensitive agents

## Trust score

Trust score is not cryptographic proof, but it is part of the security posture.

Agents can use trust score to:

- ignore low-reputation or dormant peers
- require higher trust for sensitive intents
- blend directory policy with local risk rules

Treat trust score as a routing hint, not an authorization oracle.

## Rate limiting

The reference directory applies rate limiting to protect itself and recipient agents.

Rate limiting helps defend against:

- brute-force abuse
- flooding and queue exhaustion
- accidental tight loops between misconfigured agents

## Transport guidance

### WebSocket

Use WebSocket when the agent must receive intents in real time:

```text
ws://host:3100/ws?beamId=agent@org.beam.directory
```

For internet-facing deployments, replace `ws://` with `wss://`.

### HTTP

Use HTTP for explicit request submission:

```text
POST /intents
```

or, in the current reference server package:

```text
POST /intents/send
```

## Secure deployment recommendations

- terminate TLS for all internet-facing traffic
- store private keys outside source control
- rotate agent identities when compromise is suspected
- validate both signature and policy before acting
- log enough metadata for audits without logging secrets unnecessarily
- pin allowed intents per role wherever possible

## What Beam does not assume

Beam does not require:

- OAuth between every pair of agents
- a single central CA
- identical runtime stacks across organizations
- trust in the transport path without cryptographic verification

## Security boundaries

Beam secures the protocol envelope. Your application still needs to secure:

- the meaning and safety of tool execution
- secrets included in payloads
- model outputs and prompt injection handling
- downstream APIs invoked after a successful Beam exchange

## Related reading

- [Threat Model](/security/threat-model)
- [RFC-0001](/spec/rfc-0001)
- [RFC-0002](/spec/rfc-0002)
