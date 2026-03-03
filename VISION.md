# Beam Protocol — Vision

*Das offene Kommunikationsprotokoll für KI-Agenten.*
*The open communication protocol for AI agents.*

---

## Das Problem / The Problem

**DE:** Heute betreiben Unternehmen zunehmend eigene KI-Agenten — für Kundenservice, Buchhaltung, Terminplanung, Vertrieb. Aber diese Agenten leben in Silos. Ein Agent von Firma A kann nicht mit einem Agent von Firma B kommunizieren. Es gibt keinen Standard dafür, wie KI-Agenten sich gegenseitig finden, verifizieren und Nachrichten austauschen.

Das ist der Stand von E-Mail vor SMTP: Jedes System ist eine Insel.

**EN:** Today, organizations increasingly deploy their own AI agents — for customer service, accounting, scheduling, sales. But these agents live in silos. An agent from Company A cannot communicate with an agent from Company B. There is no standard for how AI agents discover, verify, and exchange messages with each other.

This is the state of email before SMTP: every system is an island.

---

## Die Vision / The Vision

**DE:** Beam Protocol ist **SMTP für KI-Agenten**.

Jeder Agent bekommt eine verifizierte Identität (Beam-ID), kann andere Agents über ein zentrales Directory finden, und kommuniziert über ein standardisiertes, kryptographisch signiertes Nachrichtenformat — den Intent Frame.

Ein Intent rein, ein Result raus. Unter 1 KB. Unter 300 ms.

**EN:** Beam Protocol is **SMTP for AI agents**.

Every agent gets a verified identity (Beam ID), can discover other agents through a central Directory, and communicates via a standardized, cryptographically signed message format — the Intent Frame.

One intent in, one result out. Under 1 KB. Under 300 ms.

---

## Warum jetzt? / Why Now?

**DE:**
- 2025-2026 explodiert die Anzahl von KI-Agenten in Unternehmen (10-50 pro Organisation)
- MCP (Model Context Protocol) löst Agent↔Tool, aber **nicht** Agent↔Agent
- Google A2A ist proprietär und an Google Cloud gebunden
- Es gibt keine offene, herstellerunabhängige Lösung für Agent-to-Agent Kommunikation
- Vertrauen ist das Kernproblem: Woher weiß Agent A, dass Agent B wirklich zu Firma X gehört?

**EN:**
- 2025-2026 sees an explosion of AI agents in enterprises (10-50 per organization)
- MCP (Model Context Protocol) solves Agent↔Tool, but **not** Agent↔Agent
- Google A2A is proprietary and tied to Google Cloud
- There is no open, vendor-neutral solution for agent-to-agent communication
- Trust is the core problem: How does Agent A know that Agent B truly belongs to Company X?

---

## Die drei Säulen / The Three Pillars

### 1. Beam-ID — Identität / Identity
Jeder Agent hat eine global eindeutige, kryptographisch gesicherte Identität:
```
fischer@coppen.beam.id
```
Ed25519-Schlüsselpaar, DID-kompatibel, verifizierbar über das Directory.

Every agent has a globally unique, cryptographically secured identity. Ed25519 key pair, DID-compatible, verifiable through the Directory.

### 2. Intent/Result Frames — Sprache / Language
Ein universelles, kompaktes Nachrichtenformat:
```json
{
  "intent": "query.invoice",
  "from": "jarvis@coppen.beam.id",
  "to": "fischer@coppen.beam.id",
  "params": { "invoice_id": "INV-2026-001" }
}
```
Signiert, validiert, unter 1 KB. Kein REST, kein GraphQL — ein Intent, ein Result.

A universal, compact message format. Signed, validated, under 1 KB. No REST, no GraphQL — one intent, one result.

### 3. Directory — Vertrauen / Trust
Ein zentrales (später föderiertes) Register, in dem sich Agents:
- **Registrieren** mit öffentlichem Schlüssel und Capabilities
- **Finden** über Suche nach Organisation oder Fähigkeiten
- **Verifizieren** über Trust Scores (Uptime, Response Rate, Org-Verifizierung)

A central (later federated) registry where agents register, discover, and verify each other through Trust Scores.

---

## Abgrenzung / Differentiation

| | MCP | Google A2A | Beam Protocol |
|---|---|---|---|
| **Fokus** | Agent ↔ Tool | Agent ↔ Agent | Agent ↔ Agent |
| **Identität** | Keine | Google Cloud IAM | Ed25519 + DID |
| **Open Source** | ✅ | ❌ | ✅ (Apache-2.0) |
| **Vendor-Lock** | Nein | Google | Nein |
| **Trust Model** | Keines | IAM Roles | Trust Scores + Org Verification |
| **Transport** | stdio/SSE | HTTP | WebSocket + HTTP |

---

## Roadmap

### Phase 1: Foundation ✅
- RFC 0.1 Spezifikation
- TypeScript SDK (BeamClient, BeamIdentity, BeamDirectory)
- Reference Directory Server (Node.js + SQLite)
- Erste Agent-Registrierungen

### Phase 2: Dogfood (Q2 2026)
- Produktiver Einsatz mit eigenen Agents
- WebSocket Intent Routing
- Trust Score v2 (echte Uptime + Response Rate Messung)
- Python SDK

### Phase 3: Community (Q3 2026)
- GitHub Public Release
- Developer Documentation + Tutorials
- CLI Tool (`beam register`, `beam send`, `beam lookup`)
- npm Package: `@beam-protocol/sdk`

### Phase 4: Federation (Q4 2026)
- Federated Directory Protocol
- Multi-Directory Agent Discovery
- On-Chain Identity Anchoring (optional)
- Beam Protocol Foundation

---

## Wer wir sind / Who We Are

Beam Protocol entstand aus der praktischen Erfahrung, 15+ KI-Agenten in einem Unternehmen zu betreiben. Wir haben das Problem der Agent-Kommunikation nicht theoretisch entdeckt — wir sind darüber gestolpert, als unsere Agents anfingen, miteinander reden zu müssen.

Beam Protocol was born from the practical experience of running 15+ AI agents in a single organization. We didn't discover the agent communication problem theoretically — we stumbled into it when our agents needed to talk to each other.

---

## Mitmachen / Get Involved

- **GitHub:** [beam-protocol/beam](https://github.com/beam-protocol/beam)
- **RFC:** [spec/RFC-0001.md](./spec/RFC-0001.md)
- **Waitlist:** [beam.id](https://beam.id)
- **License:** Apache-2.0

---

*"Beam ist SMTP für KI-Agenten. Nicht mehr, nicht weniger."*
*"Beam is SMTP for AI agents. Nothing more, nothing less."*
