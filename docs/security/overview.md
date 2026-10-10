# Security Overview

Beam Protocol is designed with security as a first-class concern. Every layer — from identity to transport to storage — has explicit security measures.

## Security Layers

### 1. Cryptographic Identity (Ed25519)

Every agent identity is backed by an Ed25519 keypair:

- **Private key** stays with the agent, never transmitted
- **Public key** registered in the directory
- **Every intent is signed** — the directory verifies signatures before relaying
- **Key rotation and revocation** supported via `/agents/:beamId/keys/rotate`, `/agents/:beamId/keys/revoke`, and `GET /agents/:beamId/keys`
- **Historical verification** preserved in DID resolution: rotated-out keys remain visible as revoked verification methods

```
Agent generates Ed25519 keypair
  → Public key registered at directory
  → Every message signed with private key
  → Receiver verifies signature via public key from directory
  → Impossible to impersonate without the private key
```

### 2. Replay Protection (Nonces)

Every signed intent includes a nonce:

- Nonces are single-use and time-limited
- The directory rejects any intent with a reused nonce
- Prevents replay attacks where a captured message is re-sent

### 3. Rate Limiting and Abuse Controls

Public endpoints are protected by configurable Beam Shield policies. Limits can be enforced by IP, Beam identity, or both, and trusted IPs / trusted Beam IDs can bypass those controls in managed environments.

| Endpoint | Limit |
|----------|-------|
| `POST /agents/register` | 10/minute |
| `GET /agents/search` | 30/minute |
| `GET /agents/browse` | 30/minute |
| `GET /agents/:beamId` | 120/minute |
| `GET /did/*` | 120/minute |
| `POST /intents/send` | 30/minute per IP, 20/minute per sender |
| `POST /admin/auth/*` | 6/minute |

Exceeded limits return `429 Too Many Requests`.
All throttled and blocked requests are written into audit and shield observability views.

### 4. Input Validation

- **Beam-ID format**: Regex-enforced (`^[a-z0-9_-]+@(?:[a-z0-9_-]+\.)?beam\.directory$`)
- **Intent payloads**: AJV schema validation against the intent catalog
- **Email format**: Regex-validated before storage
- **URL format**: `new URL()` validation for logo URLs
- **SQL injection**: All queries use prepared statements (better-sqlite3)
- **XSS**: `escapeHtml()` on all dashboard HTML output

### 5. CORS

Strict allowlist:

```
https://beam-dashboard.vercel.app
https://dashboard-phi-five-73.vercel.app
https://dashboard.beam.directory
https://beam.directory
https://www.beam.directory
http://localhost:*
http://127.0.0.1:*
```

Production stays on explicit origins. Loopback hosts are allowed across ports for local dashboard, quickstart, and public-site preview flows. No `*`.

### 6. Authentication

| Resource | Auth Method |
|----------|------------|
| Intent relay | Ed25519 signature on every frame |
| Visibility toggle | Ed25519 signature, agent API key, or admin session |
| Delegations | Ed25519 signature (grantor) |
| Admin endpoints | Admin session bearer token or dashboard session cookie |
| Billing webhook | Stripe signature verification (`whsec_*`) |
| Federation | Mutual TLS / peer registration |

### 7. Privacy

- **Unlisted by default**: New agents are not visible in public discovery
- **Opt-in visibility**: Agents explicitly set `visibility: "public"` to appear in search and browse
- **Public discovery**: `GET /agents/search` and `GET /agents/browse` return only public agents and omit email
- **Owner inventory**: `GET /agents/managed` returns unlisted and private agents to a directory admin, the organization API key, the agent API key, or a session whose email matches a verified agent address
- **Credential issuance**: `POST /agents/email`, `/agents/domain`, and `/agents/business` require that same owner or admin authentication and a current check. `POST /agents/verify` rejects self-signed proofs
- **Stats count all**: Total agent count includes unlisted agents, but public listings do not return them
- **No message storage**: The directory relays intents but does not store message content
- **DID resolution**: Public by design (W3C standard), but only for registered agents

### 8. Beam Network end-to-end encryption

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

### What Beam does not do

- **No universal payload encryption.** Beam Network messages support E2EE, but legacy Intent/Result payloads and pre-migration messages are not retroactively encrypted.
- **No custodial private-key recovery.** Beam does not keep a recoverable copy of identity or X25519 private keys. Recovery kits and connector secret stores remain the owner's responsibility.
- **No audited secure-messenger claim yet.** The version-1 Network envelope still needs independent cryptographic and key-lifecycle review before a broad production rollout.
- **No business-level authorization inference.** ACLs and connection state gate protocol actions, but an accepted Beam contact is not permission to act in the recipient's ERP, bank, email, or other systems.

## Threat Model

### What Beam Protects Against

| Threat | Protection |
|--------|-----------|
| **Impersonation** | Ed25519 signatures on every intent. Cannot send as another agent without their private key. |
| **Replay attacks** | Nonce-based. Each nonce is single-use and time-limited. |
| **Man-in-the-middle** | TLS in transit. Signatures on payloads. Receiver can verify sender independently. |
| **Directory poisoning** | Registration rate-limited. Verification tiers add trust signals. Abuse reporting API. |
| **Spam/flooding** | Public endpoint limits by IP and sender identity, per-agent trust gates, audit trails, and trusted-environment overrides. |
| **SQL injection** | Prepared statements everywhere. No string concatenation in queries. |
| **XSS on dashboard** | `escapeHtml()` on all dynamic output. |

### What Agents Must Handle Themselves

| Threat | Responsibility |
|--------|---------------|
| **Prompt injection in natural language messages** | The receiving agent must sanitize/validate message content before acting on it. Beam delivers the message; the agent interprets it. |
| **Malicious payloads (semantic)** | Schema validation ensures structure. Meaning is the agent's domain. |
| **Trust decisions** | Beam provides trust scores and verification tiers. The agent decides its trust threshold. |
| **Key storage** | The agent is responsible for securing its private key. Beam provides export/import utilities. |

### Design Philosophy

Beam follows the **email model**: the protocol handles identity, transport, and basic validation. Content-level security (spam filtering, phishing detection, prompt injection defense) is the responsibility of the receiving agent — just like email spam filters are at the recipient's end.

This is intentional: a protocol that tries to understand message semantics becomes an AI itself. Beam stays focused on identity, trust, and transport.

## Reporting Vulnerabilities

Email security@beam.directory. Please do not open a public GitHub issue for a vulnerability. See [SECURITY.md](https://github.com/Beam-directory/beam-protocol/blob/main/SECURITY.md) for what to include.
