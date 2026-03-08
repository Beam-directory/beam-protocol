# Threat Model

This page summarizes what Beam Protocol is designed to protect against and where the protocol deliberately stops.

## Assets Beam helps protect

- authenticity of the sending agent
- integrity of frames in transit
- freshness of requests within a replay window
- basic policy boundaries between agents
- availability of the directory under moderate abuse

## Threats Beam addresses

### 1. Message tampering

An attacker who changes `to`, `intent`, or `payload` without access to the sender's private key causes signature verification to fail.

### 2. Simple replay attacks

An attacker who replays a previously captured frame can be blocked by nonce reuse detection and timestamp freshness checks.

### 3. Unauthorized sender-to-target combinations

ACL rules let directories reject intents that violate local policy, even if the sender is otherwise valid.

### 4. Unregistered impersonation

A sender cannot successfully masquerade as another Beam ID unless they control the private key associated with that Beam ID's registered public key.

### 5. Opportunistic flooding

Rate limiting and compact frame size limits reduce the blast radius of naive spam and accidental loops.

## Threats Beam only partially addresses

### 1. Malicious but valid agents

A correctly registered agent can still send harmful or misleading content. Signature validity does not imply benevolence.

Mitigations:

- trust thresholds
- capability allowlists
- local business logic validation
- sandboxed tool execution

### 2. Compromised private keys

If an agent's private key is stolen, Beam cannot distinguish the attacker from the legitimate owner until the key is rotated and the directory is updated.

Mitigations:

- secure key storage
- short recovery procedures
- revocation or re-registration policy

### 3. Transport eavesdropping without TLS

Frame signatures protect integrity, but metadata and payload confidentiality still depend on transport security.

Mitigation:

- use HTTPS and WSS for any non-local deployment

### 4. Directory compromise

If a directory is compromised, an attacker may manipulate trust scores, ACLs, relay behavior, or discovery results.

Mitigations:

- isolate the directory
- audit changes
- move toward federation where appropriate
- independently verify critical peer keys out of band when needed

## Threats Beam does not solve

### Prompt injection and model misuse

Beam can authenticate who sent a message. It does not prove that the message content is safe for an LLM or toolchain to execute.

### Application-level authorization

Beam's ACLs are transport-level routing controls, not a complete business authorization system.

### End-to-end confidentiality by itself

Beam does not encrypt payloads at the application layer by default.

### Semantic correctness

An authenticated response can still be wrong, stale, or deceptive.

## Trust boundaries

A Beam deployment typically has these boundaries:

- **local agent process** trusted with its own private key
- **directory** trusted for discovery, relay, and policy enforcement
- **network path** untrusted unless protected by TLS
- **peer agent** authenticated cryptographically but not automatically trusted semantically

## Recommended mitigations beyond the protocol

- use TLS everywhere outside local development
- store keys in a secrets manager or hardware-backed store where possible
- validate payload schemas and intent-specific semantics
- isolate tool execution from direct model output
- maintain audit logs of sender, recipient, intent, timestamp, and outcome
- implement per-intent approval paths for high-impact actions

## Federation-specific considerations

When using multiple directories, additional risks appear:

- trust score translation errors
- stale cross-directory records
- routing loops
- DNS or discovery misconfiguration
- inter-directory authentication failures

These are covered in [RFC-0002](/spec/rfc-0002).
