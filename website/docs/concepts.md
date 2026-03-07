# Concepts — Beam Protocol

This page explains the core ideas behind Beam: what problems it solves, why the design choices were made, and how the pieces fit together.

---

## The Problem

As AI agent ecosystems grow, agents need to communicate with each other — across organisations, frameworks, and deployment environments.

Today there's no standard way to:
1. **Address** an agent globally (e.g. "find the sales agent at COPPEN")
2. **Route** a message to it securely
3. **Discover** what an agent can do

MCP gives agents tools. A2A describes a protocol. Neither gives agents a **postal address**.

Beam solves exactly that.

---

## Beam ID

A **Beam ID** is a globally unique, human-readable address for an AI agent:

```
agent@org.beam.directory
```

### Format

| Part | Description | Example |
|---|---|---|
| `agent` | Agent name within the org | `jarvis` |
| `org` | Organisation name | `coppen` |
| `.beam.directory` | Protocol suffix | fixed |

Full example: `jarvis@coppen.beam.directory`

### Why this format?

- **Familiar** — looks like email, humans understand it immediately
- **Org-scoped** — no global namespace collisions per agent name
- **Discoverable** — any directory can resolve `org` → list of agents
- **Portable** — works across directory servers (federation coming in v2)

### Validation rules

- `agent` and `org` must match `[a-z0-9_-]+`
- Case-sensitive (lowercase only)
- Max length: 64 chars each

---

## Keypairs and Identity

Every Beam agent has an **Ed25519 keypair**:

- **Private key** — kept secret by the agent, used to sign frames
- **Public key** — registered in the directory, used to verify frames

### Why Ed25519?

- Fast (~70k signs/sec, ~25k verifies/sec)
- Small key and signature sizes (32 bytes key, 64 bytes signature)
- Battle-tested in TLS, SSH, and cryptocurrency systems
- Deterministic (no random signature generation, easier to audit)

### Key format

Keys are stored as **DER-encoded bytes, base64-encoded**:

| Format | Description |
|---|---|
| Public key | SPKI DER, base64 |
| Private key | PKCS8 DER, base64 |

---

## Intent Frames

An **Intent Frame** is the unit of communication in Beam — a small, signed JSON object that represents a request from one agent to another.

```json
{
  "v":         "1",
  "intent":    "query",
  "from":      "jarvis@coppen.beam.directory",
  "to":        "clara@coppen.beam.directory",
  "params":    { "q": "How many open deals?" },
  "nonce":     "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-04T12:00:00Z",
  "signature": "MEQCIHy...base64...=="
}
```

### Design constraints

| Constraint | Value | Reason |
|---|---|---|
| Max frame size | 1 KB | Fast routing, cheap storage |
| Replay window | 5 minutes | Prevents replay attacks |
| Nonce | UUID v4 | Guarantees uniqueness |

### Signing

The signature covers a **canonical JSON** serialisation (sorted keys, no spaces) of all fields *except* `signature`:

```
sig = Ed25519.sign(JSON.canonicalize(frame), privateKey)
```

This is deterministic — the same frame always produces the same canonical string to sign.

---

## Result Frames

After processing an intent, the receiving agent returns a **Result Frame**:

```json
{
  "v":        "1",
  "success":  true,
  "payload":  { "deals": 42, "status": "green" },
  "nonce":    "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-04T12:00:00.047Z",
  "latency":   47
}
```

The `nonce` matches the original IntentFrame — this links request to response.

### Error results

```json
{
  "v":        "1",
  "success":  false,
  "error":    "Agent not available",
  "errorCode": "AGENT_OFFLINE",
  "nonce":    "...",
  "timestamp": "..."
}
```

---

## The Directory

The **Beam Directory** is a registry of agents. Think of it as a DNS for agents — you look up an agent by Beam ID and get their public key and capabilities.

### What the directory stores

For each agent:
- Beam ID
- Public key
- Display name
- Capabilities (list of intent names)
- Trust score
- Verified flag
- Last heartbeat timestamp

### How routing works

1. Agent A creates and signs an IntentFrame addressed to Agent B
2. A sends the frame to the directory's `/intents/send` endpoint
3. The directory verifies A's signature
4. The directory routes the frame to B (via WebSocket if connected, HTTP otherwise)
5. B processes the frame and returns a ResultFrame
6. The directory forwards the ResultFrame back to A

---

## Trust Scores

Every agent has a **trust score** from 0.0 to 1.0 that reflects its reliability and verifiability.

### How trust is calculated

| Signal | Weight | Description |
|---|---|---|
| Domain verification | 0.3 | Org owns the DNS domain |
| Uptime | 0.3 | Heartbeat regularity over 30 days |
| Signature success | 0.2 | % of verified frames accepted |
| Registration age | 0.2 | Days since first registration |

### Trust levels

| Score | Label | Meaning |
|---|---|---|
| 0.0–0.4 | 🔴 Low | New or unverified agent |
| 0.5–0.7 | 🟡 Medium | Active, unverified org |
| 0.8–1.0 | 🟢 High | Verified org + proven uptime |

### Verification

Org verification uses a **DNS TXT record**:

```
_beam.acme.com  TXT  "beam-verification=<token>"
```

Once verified, the org gets a `verified: true` badge on all its agents. This is similar to how Letsencrypt verifies domain ownership.

---

## Federation (coming in v2)

In v1, all agents are registered in a single directory. In v2, directories will federate:

```
jarvis@coppen.beam.directory      → hosted on dir.beam.directory
clara@partner.company.beam.directory → hosted on partner's own directory
```

The Beam ID suffix identifies which directory to query, similar to email's `@domain`.

---

## Comparison to email

Beam is intentionally designed to feel like email for developers who already understand it:

| Email | Beam |
|---|---|
| user@domain.com | agent@org.beam.directory |
| SMTP server | Beam Directory |
| MIME message | IntentFrame |
| Reply | ResultFrame |
| DKIM signature | Ed25519 signature |
| MX record | Directory lookup |
| SPF | Trust Score |

The key difference: Beam frames are **request-response** by design (not fire-and-forget), frames are tiny (<1KB), and everything is cryptographically signed.

---

## Security model

- **Authentication:** Ed25519 signatures on every frame
- **Integrity:** Canonical JSON signing prevents field tampering
- **Replay prevention:** Nonce + 5-minute timestamp window
- **Transport:** HTTPS/WSS in production
- **Key rotation:** Re-register with a new public key (revocation coming in v2)
