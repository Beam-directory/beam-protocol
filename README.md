<p align="center">
  <h1 align="center">Beam Protocol</h1>
  <p align="center"><strong>The open communication protocol for AI agents.</strong></p>
  <p align="center"><em>Das offene Kommunikationsprotokoll für KI-Agenten.</em></p>
</p>

<p align="center">
  <a href="./LICENSE">Apache-2.0</a> ·
  <a href="./spec/RFC-0001.md">RFC 0001</a> ·
  <a href="./VISION.md">Vision</a> ·
  <a href="#quick-start">Quick Start</a>
</p>

---

## What is Beam?

**Beam Protocol is SMTP for AI agents.** It defines how AI agents discover, authenticate, and exchange structured messages across organizational boundaries.

- **Beam-ID** — A globally unique, cryptographically secured agent identity (`agent@org.beam.id`)
- **Intent/Result Frames** — A compact, signed message format (<1 KB, <300 ms)
- **Directory** — A central registry for agent discovery, verification, and trust scoring

### The Problem

AI agents are everywhere — customer service bots, scheduling assistants, invoice processors, orchestration systems. But they can't talk to each other across organizational boundaries. There's no standard for agent-to-agent communication.

MCP solves Agent ↔ Tool. **Beam solves Agent ↔ Agent.**

---

## Was ist Beam?

**Beam Protocol ist SMTP für KI-Agenten.** Es definiert, wie KI-Agenten sich gegenseitig finden, authentifizieren und strukturierte Nachrichten über Organisationsgrenzen hinweg austauschen.

- **Beam-ID** — Eine global eindeutige, kryptographisch gesicherte Agent-Identität
- **Intent/Result Frames** — Ein kompaktes, signiertes Nachrichtenformat (<1 KB, <300 ms)
- **Directory** — Ein zentrales Register für Agent-Suche, Verifizierung und Trust Scoring

---

## Quick Start

### Install

```bash
npm install @beam-protocol/sdk
```

### Create an Agent Identity

```typescript
import { BeamIdentity } from '@beam-protocol/sdk'

const agent = BeamIdentity.generate({
  agentName: 'my-agent',
  orgName: 'my-company'
})

console.log(agent.beamId)
// → my-agent@my-company.beam.id
```

### Register with the Directory

```typescript
import { BeamDirectory } from '@beam-protocol/sdk'

const directory = new BeamDirectory({
  baseUrl: 'http://localhost:3100'
})

await directory.register({
  beamId: agent.beamId,
  displayName: 'My Agent',
  capabilities: ['scheduling', 'notifications'],
  publicKey: agent.publicKeyBase64,
  org: 'my-company'
})
```

### Send an Intent

```typescript
import { BeamClient } from '@beam-protocol/sdk'

const client = new BeamClient({
  identity: agent.export(),
  directoryUrl: 'http://localhost:3100'
})

await client.connect()

const result = await client.send(
  'other-agent@other-company.beam.id',
  'query.status',
  { detail: 'full' }
)

console.log(result.payload)
```

### Receive Intents

```typescript
client.on('query.status', (frame, respond) => {
  respond({
    success: true,
    payload: {
      status: 'online',
      version: '1.0.0',
      uptime: 99.9
    }
  })
})
```

---

## Architecture

```
┌──────────────┐         ┌──────────────────┐         ┌──────────────┐
│   Agent A    │◄──WSS──►│  Beam Directory   │◄──WSS──►│   Agent B    │
│              │         │                  │         │              │
│ Ed25519 Keys │         │ - Registration   │         │ Ed25519 Keys │
│ Beam SDK     │         │ - Lookup/Search  │         │ Beam SDK     │
│              │         │ - Trust Scores   │         │              │
│  Intent ────►│────────►│ - Intent Routing │────────►│◄──── Intent  │
│  ◄──── Result│◄────────│ - Nonce Dedup    │◄────────│Result ────►  │
└──────────────┘         └──────────────────┘         └──────────────┘
```

### Key Concepts

| Concept | Description |
|---|---|
| **Beam-ID** | `agent@org.beam.id` — Ed25519 key pair, DID-compatible |
| **Intent Frame** | Signed JSON request: intent, from, to, params, nonce, timestamp, signature |
| **Result Frame** | Signed JSON response: success/error, payload, nonce, latency, signature |
| **Directory** | Central registry with agent lookup, search, heartbeat, trust scoring |
| **Trust Score** | 0.0–1.0 based on org verification (0.3), uptime (0.3), response rate (0.2), account age (0.2) |

---

## Packages

| Package | Description | Path |
|---|---|---|
| `@beam-protocol/sdk` | TypeScript SDK — BeamClient, BeamIdentity, BeamDirectory, Frames | `packages/sdk-typescript/` |
| `@beam-protocol/directory` | Reference Directory Server — Hono + SQLite | `packages/directory/` |

---

## Run the Directory Server

```bash
cd packages/directory
npm install
npm start
# → Beam Directory running on http://localhost:3100
```

## Run the Example

```bash
# Start the directory first, then:
npx tsx examples/coppen-registration.ts
```

---

## Specification

The full protocol specification is available at [`spec/RFC-0001.md`](./spec/RFC-0001.md).

It covers:
- Beam Identity (Beam-ID) format and cryptographic operations
- Intent Frame and Result Frame schemas
- Directory Protocol (registration, lookup, search, heartbeat)
- Transport bindings (WebSocket primary, HTTP fallback)
- Security model (Ed25519 signatures, replay prevention, TLS)
- Trust model (organization verification, capability declaration, trust scoring)
- Intent naming conventions and error codes

---

## Comparison

| | MCP | Google A2A | Beam Protocol |
|---|---|---|---|
| **Focus** | Agent ↔ Tool | Agent ↔ Agent | Agent ↔ Agent |
| **Identity** | None | Google Cloud IAM | Ed25519 + DID |
| **Open Source** | ✅ | ❌ | ✅ |
| **Vendor Lock-in** | No | Google | No |
| **Trust Model** | None | IAM Roles | Trust Scores |
| **Transport** | stdio/SSE | HTTP | WebSocket + HTTP |
| **Message Format** | JSON-RPC | Custom | Intent/Result Frames |

---

## Roadmap

- [x] RFC 0.1 Specification
- [x] TypeScript SDK
- [x] Reference Directory Server
- [ ] WebSocket Intent Routing (live)
- [ ] Python SDK
- [ ] CLI Tool (`beam register`, `beam send`, `beam lookup`)
- [ ] npm publish `@beam-protocol/sdk`
- [ ] Federated Directory Protocol
- [ ] Developer Documentation Site

---

## Contributing

Beam Protocol is open source under Apache-2.0. Contributions welcome.

1. Read the [RFC](./spec/RFC-0001.md)
2. Check [open issues](https://github.com/beam-protocol/beam/issues)
3. Submit a PR

---

## License

[Apache-2.0](./LICENSE)

---

<p align="center">
  <em>"Beam is SMTP for AI agents. Nothing more, nothing less."</em>
</p>
