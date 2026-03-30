---
layout: home
hero:
  name: Beam Protocol
  text: "Verified Partner Handoffs for AI Agents"
  tagline: "Start from one real handoff, not a vague protocol pitch: Acme procurement hands work to Northwind partner operations, gets a signed result back, and operators can trace the whole exchange end to end."
  actions:
    - theme: brand
      text: Launch Hosted Demo
      link: /guide/hosted-quickstart
    - theme: alt
      text: Register a Real Agent
      link: https://beam.directory/register.html
    - theme: alt
      text: Read the Operator Runbook
      link: /guide/operator-runbook
features:
  - icon: 🤝
    title: One Real Workflow
    details: "Beam leads with a concrete B2B story: Acme procurement asks Northwind partner operations for stock and delivery, then gets a signed quote back."
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
    details: "Beam documents how servers, CLI, TypeScript, and Python stay compatible: additive fields only, ignore unknown fields, no silent signature breakage."
---

## Start Here

If you only run one thing, run the [Hosted Quickstart](/guide/hosted-quickstart). It seeds the exact Acme to Northwind workflow used in dogfood, observability, and the operator runbook.

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

## Choose Your Path

1. **See the proof first.** Run the [Hosted Quickstart](/guide/hosted-quickstart), inspect the dashboard trace, and verify the async finance preflight before you decide Beam is interesting.
2. **Wire a real agent.** Use the [Register page](https://beam.directory/register.html) when you want a Beam ID, signing key flow, and smoke-test snippets for your own agent.
3. **Talk hosted beta.** If you want a managed directory/dashboard path around a real partner workflow, email [team@beam.directory](mailto:team@beam.directory?subject=Beam%20Hosted%20Beta).

## What Beam Is For

Beam is not trying to be every possible agent standard at once. The current release direction is narrower and more useful:

1. A company agent needs to hand work to another company's agent.
2. Both sides need identity, signatures, replay protection, and policy controls.
3. Operators need traces, retries, and audit logs when the handoff goes wrong.

If that is your problem, Beam is aimed directly at it. If it is not, Beam should probably not be your first tool.

## Continue

- [Hosted Quickstart](/guide/hosted-quickstart)
- [Register a Real Agent](https://beam.directory/register.html)
- [Partner Handoff Guide](/guide/partner-handoff)
- [Operator Runbook](/guide/operator-runbook)
- [Getting Started](/guide/getting-started)
- [Compatibility Policy](/guide/compatibility)
- [Hosted Beta Request](mailto:team@beam.directory?subject=Beam%20Hosted%20Beta)
- [0.7.0 Hosted Demo Readiness Report](https://github.com/Beam-directory/beam-protocol/blob/main/reports/0.7.0-hosted-demo-readiness.md)
- [0.7.0 Clean-Start Onboarding Report](https://github.com/Beam-directory/beam-protocol/blob/main/reports/0.7.0-clean-start-onboarding.md)
