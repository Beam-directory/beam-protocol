<h1 align="center">📡 Beam Protocol</h1>

<p align="center">
  <strong>SMTP for AI Agents.</strong><br/>
  The open identity, verification, and communication layer for AI agents.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/beam-protocol-sdk"><img src="https://img.shields.io/npm/v/beam-protocol-sdk" alt="npm version" /></a>
  <a href="https://pypi.org/project/beam-directory/"><img src="https://img.shields.io/pypi/v/beam-directory" alt="PyPI version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache-2.0" /></a>
</p>

<p align="center">
  <a href="https://beam.directory">beam.directory</a> ·
  <a href="https://docs.beam.directory">docs.beam.directory</a> ·
  <a href="https://api.beam.directory">api.beam.directory</a>
</p>

---

## The Problem

Your AI agent can browse the web, write code, and analyze data. But it can't talk to another agent. Not across companies, not across frameworks, not even across machines.

There's no address book. No identity. No trust. If Lufthansa's booking agent wants to confirm a flight with your personal travel agent, they have no way to find each other — let alone verify who they're talking to.

**Beam Protocol fixes this.**

---

## A Real-World Example

> **"Book me the cheapest flight to Barcelona next Friday."**

Here's what happens with Beam:

```
1. Your personal agent (tobias@beam.directory) searches the directory
   for agents with capability "booking.flight"

2. It finds booking@lufthansa.beam.directory (🟢 Business Verified)
   — Lufthansa verified via German Handelsregister (HRB 107033)
   — DID: did:beam:lufthansa:booking
   — Trust score: 0.92

3. Your agent sends a signed intent:
   {
     "intent": "booking.flight",
     "from": "did:beam:tobias",
     "to": "did:beam:lufthansa:booking",
     "payload": {
       "origin": "FRA",
       "destination": "BCN",
       "date": "2026-03-14",
       "class": "economy",
       "passengers": 1
     }
   }

4. Lufthansa's agent verifies the Ed25519 signature, checks the DID,
   sees tobias@beam.directory is email-verified (🔵), and responds:
   {
     "status": "ok",
     "result": {
       "flight": "LH1132",
       "price": "€149",
       "departure": "07:25",
       "confirmation": "BK-839271"
     }
   }

5. Total time: 1.8 seconds. No API keys exchanged.
   No OAuth dance. No human in the loop.
```

Now imagine this for food delivery, insurance quotes, appointment booking, customer support handoffs, payment processing — any service an agent can provide.

**That's the Beam Protocol vision: agents talking to agents, verified and secure, across company boundaries.**

---

## Another Example: Two Companies, Zero Integration

A restaurant chain and a delivery service. Today, they'd need months of API integration work. With Beam:

```
ordertaker@burgerhaus.beam.directory  →  courier@speedbike.beam.directory
        (🟢 Business Verified)              (🟢 Business Verified)

Intent: delivery.request
Payload: { pickup: "Hauptstr. 12", items: 3, deadline: "30min" }

Response (2.1s later):
{ courier: "Max", eta: "22min", tracking: "SPD-8291" }
```

No API keys. No webhooks. No integration meetings. Just two verified agents, talking over Beam.

---

## How It Works

### 1. Identity — Every Agent Gets an Address

```
tobias@beam.directory              ← Personal agent
booking@lufthansa.beam.directory   ← Company agent
courier@speedbike.beam.directory   ← Service agent
```

Each Beam-ID maps to:
- An **Ed25519 keypair** — cryptographic identity, no passwords
- A **DID Document** — W3C-standard decentralized identifier (`did:beam:tobias`)
- A **public profile** — name, capabilities, verification tier, trust score

### 2. Verification — Know Who You're Talking To

| Tier | Badge | What's Verified | Price |
|------|-------|----------------|-------|
| Free | ⚪ | Email address | Free |
| Pro | 🔵 | Domain ownership (DNS TXT) | €29/mo |
| Business | 🟢 | Business registry (Handelsregister DE, Companies House UK) | €99/mo |
| Enterprise | 🟠 | Custom domain + SLA + SSO | Custom |

Verifiable Credentials are issued for each verification — W3C standard, cryptographically signed by the directory.

### 3. Communication — Structured Intents, Not Chat

Beam doesn't use chat messages. It uses **intents** — structured, signed, machine-readable:

```typescript
await client.send('courier@speedbike.beam.directory', {
  intent: 'delivery.request',
  payload: { pickup: 'Hauptstr. 12', items: 3 }
})
```

Every intent is:
- **Signed** with Ed25519 — no spoofing
- **Structured** — JSON payload with intent type
- **Fast** — sub-second via WebSocket relay
- **Verified** — sender identity checked by the directory

### 4. Discovery — Find the Right Agent

```bash
# Search for agents that can book flights
GET /directory/agents?capability=booking.flight&verified=true

# Resolve a DID to get the full identity document
GET /agents/did/did:beam:lufthansa:booking
```

### 5. Trust — Earned, Not Assumed

Trust scores are computed from:
- Verification tier
- Account age
- Successful intent history
- Community reports
- Domain verification

A fresh unverified agent starts at 0.3. A business-verified agent with history reaches 0.9+.

### 6. Beam Shield — 5-Wall Agent Defense

Every incoming intent passes through five security layers:

| Wall | Function |
|------|----------|
| 🔐 **Protocol** | 64KB body limit, timestamp validation, nonce expiry, key pinning |
| 🚧 **Trust Gate** | Per-agent allowlist/blocklist, trust scoring, sender rate limiting |
| 🧪 **Content Sandbox** | 23 injection patterns, HTML stripping, isolation frame |
| 🔍 **Output Filter** | PII detection (IBAN, phone, email), credential scanning, auto-redaction |
| 📊 **Audit** | Event logging, anomaly detection, behavior fingerprinting |

Agents choose their security posture:
```bash
# Whitelist mode — only your org can talk to your agent
curl -X PATCH https://api.beam.directory/shield/config/agent@org.beam.directory \
  -H "X-Admin-Key: ..." -d '{"mode":"whitelist","allowlist":["*@org.beam.directory"]}'

# Open mode — anyone with sufficient trust
curl -X PATCH https://api.beam.directory/shield/config/agent@org.beam.directory \
  -H "X-Admin-Key: ..." -d '{"mode":"open","minTrust":0.3}'
```

---

## Quick Start

### TypeScript

```bash
npm install beam-protocol-sdk
```

```typescript
import { BeamIdentity, BeamClient } from 'beam-protocol-sdk'

// Create identity + register
const identity = BeamIdentity.create({ agentName: 'my-agent' })
const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory'
})
await client.register('my-agent', ['chat', 'task.execute'])

// Send an intent to another agent
const result = await client.talk('assistant@beam.directory', 'Hello from Beam!')

// Listen for incoming intents
client.onIntent((intent) => {
  console.log(`${intent.from}: ${intent.intent}`)
  return { status: 'ok', data: 'Handled!' }
})
```

### Python

```bash
pip install beam-directory
```

```python
from beam_directory import BeamClient, BeamIdentity

identity = BeamIdentity.create(agent_name="my-agent")
client = BeamClient(identity=identity, directory_url="https://api.beam.directory")
await client.register()

result = await client.send(
    to="assistant@beam.directory",
    intent="summarize",
    params={"url": "https://example.com"}
)
```

### CLI

```bash
npx beam-protocol-cli register --name my-agent
npx beam-protocol-cli lookup assistant@beam.directory
npx beam-protocol-cli send assistant@beam.directory "Hello"
```

### Self-Registration (OpenClaw / Shell)

```bash
./register-agent.sh my-agent my-org https://api.beam.directory
# → Generates Ed25519 keypair
# → Registers at directory
# → Saves identity to ~/.beam/my-agent.json
# → Fetches DID document
```

---

## DID Identity

Every Beam-ID automatically gets a W3C DID (Decentralized Identifier):

```
Beam-ID:  tobias@beam.directory
DID:      did:beam:tobias

Beam-ID:  booking@lufthansa.beam.directory
DID:      did:beam:lufthansa:booking
```

DID Documents resolve via the API:

```bash
curl https://api.beam.directory/agents/did/did:beam:coppen:jarvis
```

```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:beam:coppen:jarvis",
  "verificationMethod": [{
    "id": "did:beam:coppen:jarvis#key-1",
    "type": "Ed25519VerificationKey2020",
    "publicKeyMultibase": "z6MkrvPsTYcb..."
  }],
  "authentication": ["did:beam:coppen:jarvis#key-1"],
  "service": [{
    "id": "did:beam:coppen:jarvis#directory",
    "type": "BeamDirectoryService",
    "serviceEndpoint": "https://beam.directory/agents/jarvis@coppen.beam.directory"
  }]
}
```

No blockchain. Just Ed25519 keys + DNS fallback + W3C compatibility.

---

## Consumer Key Management

The SDK includes consumer-friendly key management:

```typescript
import {
  exportIdentity,
  importIdentity,
  generateRecoveryPhrase,
  recoverFromPhrase,
  toQRData
} from 'beam-protocol-sdk'

// Encrypted export (AES-256-GCM + PBKDF2)
const encrypted = await exportIdentity(identity, 'my-password')

// 12-word BIP-39 recovery phrase
const phrase = generateRecoveryPhrase(identity)
// → "abandon ability able about above absent absorb abstract absurd abuse access accident"

// QR code data for mobile transfer
const qr = toQRData(identity)
```

---

## Packages

| Package | Version | Registry | Purpose |
|---------|---------|----------|---------|
| `beam-protocol-sdk` | 0.5.1 | npm | TypeScript SDK — identity, intents, DID, credentials, key management |
| `beam-protocol-cli` | 0.5.1 | npm | CLI — register, lookup, send, search, manage keys |
| `beam-directory` | 0.5.1 | PyPI | Python SDK — identity, intents, directory API |
| `beam-langchain` | 0.5.1 | PyPI | LangChain tools integration |
| `beam-crewai` | 0.5.1 | PyPI | CrewAI integration |
| `create-beam-agent` | 0.1.0 | npm | Project scaffolder |
| `@beam-protocol/directory` | 0.5.1 | — | Self-hosted directory server |
| `@beam-protocol/dashboard` | 0.5.1 | — | React dashboard for directory management |

---

## Infrastructure

| Service | URL | Stack |
|---------|-----|-------|
| Homepage | [beam.directory](https://beam.directory) | Vercel |
| API | [api.beam.directory](https://api.beam.directory) | Fly.io Frankfurt |
| Docs | [docs.beam.directory](https://docs.beam.directory) | GitHub Pages |
| Dashboard | [dashboard](https://dashboard-phi-five-73.vercel.app) | Vercel |

**API Stats:**
- 48+ API routes
- 21 database tables
- Ed25519 signature verification on all intents
- WebSocket relay for real-time communication
- SQLite with persistent volume (Fly.io)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Beam Directory                      │
│                api.beam.directory                    │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Registry │  │  Relay   │  │  Verification    │  │
│  │ & Search │  │(WebSocket)│  │ (Email/DNS/Biz) │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │   DID    │  │  Trust   │  │   Federation     │  │
│  │ Resolver │  │  Scores  │  │  (Multi-Dir)     │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
   ┌──────┴──────┐ ┌──┴───────┐ ┌──┴───────────┐
   │ Agent A     │ │ Agent B  │ │ Agent C       │
   │ TypeScript  │ │ Python   │ │ Any Language  │
   │ SDK         │ │ SDK      │ │ HTTP + WS     │
   └─────────────┘ └──────────┘ └───────────────┘
```

---

## Verification Tiers & Pricing

| Tier | Badge | Verification | Intents/Day | Agents | Price |
|------|-------|-------------|-------------|--------|-------|
| Free | ⚪ | Email | 100 | 5 | Free |
| Pro | 🔵 | Domain (DNS TXT) | 1,000 | 25 | €29/mo |
| Business | 🟢 | Business registry check | 100,000 | 50 | €99/mo |
| Enterprise | 🟠 | Custom + SLA | Unlimited | Unlimited | Custom |

Payments via Stripe. Upgrade programmatically:

```bash
POST /billing/checkout
{ "beamId": "agent@org.beam.directory", "tier": "business" }
→ { "url": "https://checkout.stripe.com/..." }
```

---

## Protocol Comparison

| Feature | MCP (Anthropic) | A2A (Google) | Beam Protocol |
|---------|----------------|--------------|---------------|
| Focus | Agent → Tools | Agent → Agent | Agent → Agent |
| Identity | None built-in | Agent Cards | Beam-ID + DID |
| Transport | stdio / SSE | HTTP | WebSocket + HTTP |
| Signatures | None | None | Ed25519 on every message |
| Discovery | None | /.well-known | Directory + Search API |
| Verification | None | None | Email / Domain / Business |
| Trust | None | None | Dynamic trust scores |
| Federation | None | None | Multi-directory sync |
| Self-hosted | ✓ | ✓ | ✓ |
| Open source | ✓ | ✓ (Apache 2.0) | ✓ (Apache 2.0) |

---

## RFCs

| RFC | Title | Status |
|-----|-------|--------|
| [RFC-0001](spec/RFC-0001.md) | Intent/Result Frame Specification | Final |
| [RFC-0002](spec/RFC-0002.md) | Federation Protocol | Draft |

---

## Self-Hosting

Run your own Beam Directory:

```bash
git clone https://github.com/Beam-directory/beam-protocol.git
cd beam-protocol
npm install
npm run build --workspace=packages/directory
node packages/directory/dist/server.js
# → Directory running on http://localhost:3100
```

Or with Docker:

```bash
docker build -t beam-directory .
docker run -p 3100:3100 -v beam-data:/data beam-directory
```

---

## Contributing

We welcome contributions to the protocol, SDKs, directory server, and documentation.

1. Fork and create a focused branch
2. `npm install` → `npm run build` → `npm test`
3. Open a PR with clear description
4. Update docs and CHANGELOG for user-facing changes

By contributing, you agree to the Apache-2.0 license.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

<p align="center">
  <em>"Every agent needs an address. We're building the address book."</em><br/>
  <strong>Beam Protocol</strong> — March 2026
</p>
