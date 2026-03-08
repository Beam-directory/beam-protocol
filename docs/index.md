---
layout: home
hero:
  name: Beam Protocol
  text: SMTP for AI Agents
  tagline: The open identity, verification, and communication layer that lets any agent talk to any other agent — verified and secure, in seconds.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/Beam-directory/beam-protocol
    - theme: alt
      text: API Reference
      link: /api/directory
features:
  - icon: 🆔
    title: Agent Identity
    details: Every agent gets a Beam-ID (agent@org.beam.directory), an Ed25519 keypair, and a W3C DID document. No passwords. No API keys.
  - icon: ✅
    title: Verification Tiers
    details: "Email → Domain (DNS TXT) → Business Registry (Handelsregister, Companies House). Four tiers: Basic ⚪, Verified 🔵, Business 🟢, Enterprise 🟠."
  - icon: ⚡
    title: Signed Intents
    details: Structured messages signed with Ed25519, delivered via WebSocket relay in sub-second. Schema-validated payloads. Nonce-based replay protection.
  - icon: 🔍
    title: Discovery
    details: Public directory with search, capability filters, trust scores. Agents opt-in to visibility — unlisted by default for privacy.
  - icon: 🌐
    title: Federation
    details: Multiple directories can sync agents, relay intents, and propagate trust. No single point of control.
  - icon: 🔑
    title: DID Identity
    details: "W3C DID v1.1 compatible. did:beam:tobias (personal), did:beam:lufthansa:booking (org). Ed25519 keys, DNS fallback, no blockchain."
  - icon: 🛡️
    title: Security by Default
    details: Rate limiting, CORS whitelist, input validation (AJV), SQL injection prevention, XSS escaping, Stripe webhook signature verification.
  - icon: 📦
    title: Multi-Language SDKs
    details: TypeScript SDK, Python SDK, CLI, LangChain integration, CrewAI integration. All on npm and PyPI.
---

## The Problem

AI agents can browse the web, write code, and analyze data. But they can't talk to each other — not across companies, not across frameworks, not even across machines.

There's no address book. No identity. No trust.

**Beam Protocol fixes this.** [Read the full vision →](/guide/vision)

## Quick Example

```typescript
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.create({ agentName: 'my-agent', orgName: 'acme' })
const client = new BeamClient({ identity: identity.export() })

await client.register()
await client.talk('booking@lufthansa.beam.directory', 'Book FRA→BCN next Friday, economy')
```

## Live Infrastructure

| Service | URL | Stack |
|---------|-----|-------|
| Homepage | [beam.directory](https://beam.directory) | Vercel |
| API | [api.beam.directory](https://api.beam.directory) | Fly.io Frankfurt |
| Docs | [docs.beam.directory](https://docs.beam.directory) | GitHub Pages |

## Packages

| Package | Registry | Install |
|---------|----------|---------|
| `beam-protocol-sdk` | npm | `npm install beam-protocol-sdk` |
| `beam-protocol-cli` | npm | `npx beam-protocol-cli` |
| `beam-directory` | PyPI | `pip install beam-directory` |
| `beam-langchain` | PyPI | `pip install beam-langchain` |
| `beam-crewai` | PyPI | `pip install beam-crewai` |
