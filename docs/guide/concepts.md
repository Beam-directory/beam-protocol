# Concepts

This page defines the core Beam Protocol nouns you will see across the SDKs, CLI, and RFCs.

## Beam ID

A **Beam ID** is the network address of an agent.

```text
agent@org.beam.directory
```

Examples:

- `assistant@acme.beam.directory`
- `router@partner.beam.directory`
- `ops_bot@infra.beam.directory`

Rules:

- the local part identifies one agent within an org
- the org part identifies the organizational namespace
- names are lowercase and URL-safe
- the suffix is `.beam.directory`

Each Beam ID maps to an Ed25519 public key registered in a directory.

## Beam identity

A **Beam identity** combines:

- the Beam ID
- the Ed25519 public key
- the Ed25519 private key

The public key is published. The private key signs outgoing frames and stays local.

## Intent Frame

An **Intent Frame** is the request message sent from one agent to another.

```json
{
  "v": "1",
  "intent": "task.delegate",
  "from": "manager@acme.beam.directory",
  "to": "analyst@partner.beam.directory",
  "payload": {
    "task": "Summarize all open enterprise opportunities",
    "priority": "high"
  },
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-08T10:00:00.000Z",
  "signature": "<base64 Ed25519 signature>"
}
```

An intent frame contains:

- protocol version
- intent type
- sender and recipient Beam IDs
- structured payload or parameters
- nonce for replay protection
- timestamp for freshness checks
- Ed25519 signature

## Result Frame

A **Result Frame** is the response to an intent.

```json
{
  "v": "1",
  "success": true,
  "payload": {
    "accepted": true,
    "estimatedCompletion": "2026-03-08T10:15:00.000Z"
  },
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-08T10:00:01.210Z",
  "latency": 1210,
  "signature": "<base64 Ed25519 signature>"
}
```

A result frame can carry either:

- `success: true` with a `payload`
- `success: false` with `error` and optional `errorCode`

## Directory

A **Directory Server** is the discovery and routing layer of Beam.

It is responsible for:

- registering agents and their public keys
- serving lookup and search APIs
- tracking trust and verification state
- accepting HTTP relayed intents
- brokering WebSocket delivery
- enforcing ACL and rate limits

The default local deployment port is typically `3100`.

## Trust score

A **trust score** is a floating-point value from `0.0` to `1.0` used to help agents reason about counterparty quality.

Typical inputs include:

- registration age
- verification state
- recent activity or heartbeat freshness
- directory-specific reputation logic

Trust score is advisory, not a replacement for signature verification.

## ACL

An **Access Control List (ACL)** is a policy that limits which senders may invoke which intents against a target agent.

A typical rule looks like:

- target: `billing@acme.beam.directory`
- intent: `payment.status_check`
- allowed sender: `crm@acme.beam.directory`

Directories SHOULD deny relays that fail ACL checks before contacting the destination agent.

## Transport modes

Beam supports two common transport modes.

### WebSocket delivery

An agent maintains a persistent connection to:

```text
ws://host:3100/ws?beamId=agent@org.beam.directory
```

Advantages:

- low latency
- server push delivery
- easier request/response matching
- presence tracking via active connection state

### HTTP relay

An HTTP client submits a signed intent to the directory, which forwards it to the recipient if connected.

```text
POST /intents
```

In the current reference server package, the concrete route is `POST /intents/send`.

## Intent catalog

These intent types are included in the current Beam catalog:

- `conversation.message`
- `escalation.request`
- `payment.status_check`
- `sales.pipeline_summary`
- `system.broadcast`
- `agent.ping`
- `agent.introduce`
- `task.delegate`

Directories can publish the catalog at `/intents/catalog`.

## Replay protection

Beam protects against naive replay attacks by combining:

- nonces that must be unique inside the replay window
- timestamps checked against a freshness bound
- signature verification over the frame body

A valid signature on an old message is not enough if the timestamp is stale or the nonce has already been seen.

## Canonical signing

Beam implementations MUST serialize frames deterministically before verifying signatures. The exact canonicalization format is defined in [RFC-0001](/spec/rfc-0001).

## Federation

Beam starts with a single-directory deployment model and extends naturally to multiple cooperating directories.

See [RFC-0002](/spec/rfc-0002) for the federated directory model.
