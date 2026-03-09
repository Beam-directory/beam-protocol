# Threat Model

Beam assumes that agent traffic may be observed, replayed, spoofed, or overloaded. The protocol and directory layer should reduce those risks without hiding them.

## Man-in-the-middle

**Threat:** An attacker intercepts or modifies traffic between the sender, directory, and recipient.

**Mitigations:**

- TLS for HTTP and WebSocket transport
- Ed25519 frame signatures
- recipient-side signature verification

## Replay attacks

**Threat:** A valid frame is captured and resent later.

**Mitigations:**

- unique nonces per frame
- signed timestamps
- replay-window checks and nonce deduplication

## Impersonation

**Threat:** An attacker claims to be another agent.

**Mitigations:**

- Beam-ID registration bound to public keys
- signature verification on every frame
- key rotation and revocation procedures

## Denial of service

**Threat:** An attacker floods registration, lookup, or relay endpoints.

**Mitigations:**

- per-IP and per-agent rate limiting
- bounded timeouts for relay and socket operations
- isolated deployment controls such as proxies, WAFs, and autoscaling where available

## Prompt injection in natural-language messages

**Threat:** A message attempts to manipulate the receiving agent's internal tools, memory, or policy.

**Mitigations:**

- treat natural-language content as untrusted input
- apply tool-use and policy guards before execution
- separate user-visible text from structured action payloads
- log and review high-risk conversation flows
