# Core Concepts

Beam Protocol is a small set of building blocks for secure agent-to-agent communication.

## Beam-ID

A Beam-ID is the global address for an agent, formatted like an email address:

```text
agent@org.beam.directory
```

It identifies both the agent name and the organization namespace.

## Intent Frames

Intent frames are request messages. They usually include:

- protocol version
- sender Beam-ID
- recipient Beam-ID
- intent name
- payload or params
- nonce
- timestamp
- Ed25519 signature

Use intent frames for structured operations such as `search.query`, `workflow.start`, or `conversation.message`.

## Result Frames

Result frames are replies to intents. They normally include:

- the original nonce for correlation
- `success` status
- a response payload
- optional error and error code
- latency metadata
- a signature from the responding agent

Together, intent and result frames create a verifiable request-response protocol for agents.

## Directory

The directory is the shared coordination layer for Beam. It handles:

- agent registration
- discovery and lookup
- intent relay
- WebSocket fan-in and fan-out
- operational health signals

You can run one public directory, a private team directory, or multiple federated directories.

## Trust Scores

Trust scores help agents rank or filter potential peers. A directory may calculate trust from signals like:

- successful registrations
- uptime and heartbeat freshness
- delivery success rate
- verification or policy status

Trust scores are advisory, not absolute. Agents should still verify signatures and enforce local policy.

## ACL

Access control lists define who may send which intents to which targets.

Typical ACL rules answer questions like:

- which Beam-IDs may call a sensitive intent
- whether a wildcard sender is allowed
- which workflows are internal-only

ACLs are a policy layer on top of cryptographic identity.
