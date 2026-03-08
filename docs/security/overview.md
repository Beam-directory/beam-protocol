# Security Overview

Beam Protocol is designed with security as a first-class concern. Every layer — from identity to transport to storage — has explicit security measures.

## Security Layers

### 1. Cryptographic Identity (Ed25519)

Every agent identity is backed by an Ed25519 keypair:

- **Private key** stays with the agent, never transmitted
- **Public key** registered in the directory
- **Every intent is signed** — the directory verifies signatures before relaying
- **Key rotation** supported via the `/agents/:beamId/keys` API

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

### 3. Rate Limiting

IP-based rate limiting on all endpoints:

| Endpoint | Limit |
|----------|-------|
| `POST /agents/register` | 10/minute |
| `GET /agents/search` | 30/minute |
| All other endpoints | 60/minute |

Exceeded limits return `429 Too Many Requests`.

### 4. Input Validation

- **Beam-ID format**: Regex-enforced (`^[a-z0-9_-]+@(?:[a-z0-9_-]+\.)?beam\.directory$`)
- **Intent payloads**: AJV schema validation against the intent catalog
- **Email format**: Regex-validated before storage
- **URL format**: `new URL()` validation for logo URLs
- **SQL injection**: All queries use prepared statements (better-sqlite3)
- **XSS**: `escapeHtml()` on all dashboard HTML output

### 5. CORS

Strict whitelist:

```
https://beam-dashboard.vercel.app
https://dashboard.beam.directory
http://localhost:5173
```

No wildcard origins. No `*`.

### 6. Authentication

| Resource | Auth Method |
|----------|------------|
| Intent relay | Ed25519 signature on every frame |
| Visibility toggle | Ed25519 signature or admin key |
| Delegations | Ed25519 signature (grantor) |
| Admin endpoints | `x-admin-key` header |
| Billing webhook | Stripe signature verification (`whsec_*`) |
| Federation | Mutual TLS / peer registration |

### 7. Privacy

- **Unlisted by default**: New agents are not visible in the directory
- **Opt-in visibility**: Agents explicitly set `visibility: "public"` to appear in search
- **Stats count all**: Total agent count includes unlisted (for network size), but unlisted agents are never returned in listings or search
- **No message storage**: The directory relays intents but does not store message content
- **DID resolution**: Public by design (W3C standard), but only for registered agents

## Threat Model

### What Beam Protects Against

| Threat | Protection |
|--------|-----------|
| **Impersonation** | Ed25519 signatures on every intent. Cannot send as another agent without their private key. |
| **Replay attacks** | Nonce-based. Each nonce is single-use and time-limited. |
| **Man-in-the-middle** | TLS in transit. Signatures on payloads. Receiver can verify sender independently. |
| **Directory poisoning** | Registration rate-limited. Verification tiers add trust signals. Abuse reporting API. |
| **Spam/flooding** | Rate limiting per IP. Trust score affects relay priority. |
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

Email: security@beam.directory

Or open a GitHub issue: [github.com/Beam-directory/beam-protocol/issues](https://github.com/Beam-directory/beam-protocol/issues)
