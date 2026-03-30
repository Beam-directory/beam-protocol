---
layout: home
hero:
  name: Beam Protocol
  text: "Safe AI Work Between Companies"
  tagline: "Beam helps one company's AI ask another company to do work without losing who asked, who answered, or where it got stuck. Start with one real handoff and a visible paper trail."
  actions:
    - theme: brand
      text: Launch Hosted Demo
      link: /guide/hosted-quickstart
    - theme: alt
      text: Request Hosted Beta
      link: https://beam.directory/hosted-beta.html
    - theme: alt
      text: Register a Real Agent
      link: https://beam.directory/register.html
features:
  - icon: 🤝
    title: One Real Workflow
    details: "Beam starts with one concrete job: one company asks another company to do work and both sides can still see the same trail."
  - icon: 🆔
    title: Known Senders And Receivers
    details: "Beam keeps company and agent identity explicit, so both sides know who asked for the work and who answered it."
  - icon: 🔐
    title: Visible Paper Trail
    details: "Requests and replies stay attached to one trace, so operators can see what happened instead of guessing."
  - icon: 📊
    title: Operator Visibility
    details: "The dashboard exposes traces, alerts, dead letters, audit history, and recovery context for the same handoff."
  - icon: 🔁
    title: Recovery Built In
    details: "Retries, restart recovery, and dead-letter handling are part of the product surface, not hidden glue code."
  - icon: 🧩
    title: Demo First, Depth Second
    details: "Start with the hosted demo and only go deeper into SDKs, compatibility, and rollout details once the use case is real."
---

## Start Here

If you only do one thing, run the [Hosted Quickstart](/guide/hosted-quickstart). It shows the exact Acme to Northwind workflow used in dogfood, observability, and the operator runbook.

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

1. **See the proof first.** Run the [Hosted Quickstart](/guide/hosted-quickstart), inspect the dashboard trace, and verify the async finance preflight before you decide Beam is worth more time.
2. **Wire a real agent.** Use the [Register page](https://beam.directory/register.html) when the demo already landed and you want a Beam ID, keys, and smoke-test snippets for your own setup.
3. **Request hosted beta.** If you want a guided rollout around one real partner workflow, use the [Hosted Beta page](https://beam.directory/hosted-beta.html).

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
- [Hosted Beta Request](https://beam.directory/hosted-beta.html)
- [0.7.0 Hosted Demo Readiness Report](https://github.com/Beam-directory/beam-protocol/blob/main/reports/0.7.0-hosted-demo-readiness.md)
- [0.7.0 Clean-Start Onboarding Report](https://github.com/Beam-directory/beam-protocol/blob/main/reports/0.7.0-clean-start-onboarding.md)
