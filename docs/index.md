---
layout: home
hero:
  name: Beam Protocol
  text: "Verified Partner Handoffs for AI Agents"
  tagline: "Start with one workflow: procurement@acme hands a request to partner-desk@northwind, gets a signed result back, and operators can trace the whole exchange."
  actions:
    - theme: brand
      text: Start the Partner Handoff
      link: /guide/partner-handoff
    - theme: alt
      text: 5-Minute Setup
      link: /guide/getting-started
    - theme: alt
      text: Compatibility Policy
      link: /guide/compatibility
features:
  - icon: 🤝
    title: One Clear Workflow
    details: "Beam 0.6 leads with a concrete B2B story: Acme procurement asks Northwind partner operations for stock and delivery, then gets a signed quote back."
  - icon: 🆔
    title: Verified Addresses
    details: "Every agent gets a Beam ID, an Ed25519 keypair, and a DID document so both companies know exactly who sent and received the handoff."
  - icon: 🔐
    title: Signed Intents
    details: "Intents and results are signed, nonce-protected, and transportable over WebSocket or HTTP without shared API secrets between companies."
  - icon: 📊
    title: Operator Visibility
    details: "The directory and dashboard expose traces, audit entries, dead letters, alerts, and retention controls for the same handoff."
  - icon: 🔁
    title: Recovery Built In
    details: "The message bus adds dedupe, retry, restart recovery, and dead-letter handling for handoffs that cannot be fire-and-forget."
  - icon: 🧩
    title: beam/1 Compatibility
    details: "Beam 0.6 documents how servers, CLI, TypeScript, and Python stay compatible: additive fields only, ignore unknown fields, no silent signature breakage."
---

## Start Here

If you only read one thing, read [Verified Partner Handoff](/guide/partner-handoff). It is the canonical Beam 0.6 onboarding path and the same workflow used in the dogfood report.

```typescript
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({ agentName: 'procurement', orgName: 'acme' })
const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory',
})

await client.register('Acme Procurement Desk', ['conversation.message', 'quote.request'])

const reply = await client.talk(
  'partner-desk@northwind.beam.directory',
  'Need 240 inverters for Mannheim by Friday. Include delivery window and stock confidence.',
)

console.log(reply.message)
```

## What Beam Is For

Beam is not trying to be every possible agent standard at once. The current release direction is narrower and more useful:

1. A company agent needs to hand work to another company's agent.
2. Both sides need identity, signatures, replay protection, and policy controls.
3. Operators need traces, retries, and audit logs when the handoff goes wrong.

If that is your problem, Beam is aimed directly at it.

## Continue

- [Partner Handoff Guide](/guide/partner-handoff)
- [Getting Started](/guide/getting-started)
- [Hosted Quickstart](/guide/hosted-quickstart)
- [Compatibility Policy](/guide/compatibility)
- [0.6.0 Release Readiness Report](https://github.com/Beam-directory/beam-protocol/blob/main/reports/0.6.0-release-readiness.md)
