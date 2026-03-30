# Getting Started

This walkthrough gets an Acme procurement agent online and sends its first verified partner handoff to Northwind.

If you want the full seeded operator stack with `partner-desk`, `warehouse`, `finance`, traces, alerts, and a reproducible local demo, start with the [Hosted Quickstart](/guide/hosted-quickstart). This page stays focused on the shortest SDK path to a first successful handoff.

## Install

::: code-group
```bash [TypeScript]
npm install beam-protocol-sdk
```
```bash [Python]
pip install beam-directory
```
```bash [CLI]
npm install -g beam-protocol-cli
```
:::

## 1. Create an Identity

Every agent needs an Ed25519 identity:

::: code-group
```typescript [TypeScript]
import { BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({
  agentName: 'procurement',
  orgName: 'acme',
})

console.log(identity.beamId) // procurement@acme.beam.directory
```
```python [Python]
from beam_directory import BeamIdentity

identity = BeamIdentity.generate(agent_name="procurement", org_name="acme")
print(identity.beam_id)  # procurement@acme.beam.directory
```
```bash [CLI]
beam init --agent procurement --org acme
```
:::

## 2. Register the Procurement Agent

::: code-group
```typescript [TypeScript]
import { BeamClient } from 'beam-protocol-sdk'

const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory',
})

const agent = await client.register('Acme Procurement Desk', [
  'conversation.message',
  'quote.request',
])

console.log(agent.apiKey)
```
```python [Python]
from beam_directory import BeamClient

client = BeamClient(
    identity=identity,
    directory_url="https://api.beam.directory",
)
record = await client.register(
    display_name="Acme Procurement Desk",
    capabilities=["conversation.message", "quote.request"],
)
print(record.api_key)
```
```bash [CLI]
beam register \
  --display-name "Acme Procurement Desk" \
  --capabilities "conversation.message,quote.request"
```
:::

## 3. Send the First Partner Handoff

Start with the natural-language path. It exercises the same trust and transport path as a structured handoff, but it is faster to wire up.

::: code-group
```typescript [TypeScript]
const reply = await client.talk(
  'partner-desk@northwind.beam.directory',
  'Need 240 inverters for Mannheim by Friday. Include delivery window and stock confidence.',
)

console.log(reply.message)
```
```python [Python]
reply = await client.talk(
    "partner-desk@northwind.beam.directory",
    "Need 240 inverters for Mannheim by Friday. Include delivery window and stock confidence.",
)
print(reply["message"])
```
```bash [CLI]
beam talk \
  partner-desk@northwind.beam.directory \
  "Need 240 inverters for Mannheim by Friday. Include delivery window and stock confidence."
```
:::

Once that works, switch the same workflow to a structured `quote.request` payload:

```typescript
const result = await client.send(
  'partner-desk@northwind.beam.directory',
  'quote.request',
  {
    project: 'Mannheim rooftop rollout',
    sku: 'INV-240',
    quantity: 240,
    shipTo: 'Mannheim, DE',
    neededBy: '2026-04-03',
  },
)

console.log(result.payload)
```

## 4. Let Northwind Receive the Handoff

On the receiving side, Northwind only needs a Beam client that can answer the handoff:

```typescript
partnerDesk.onTalk(async (message, from, respond) => {
  console.log(`incoming handoff from ${from}`)
  console.log(message)
  respond('Stock confirmed for 240 units. Delivery window: Thu 08:00-12:00 CET.')
})

await partnerDesk.connect()
```

## 5. Search the Directory for Compatible Partners

Before hard-coding a Beam ID, you can search for the capability you need:

::: code-group
```typescript [TypeScript]
const agents = await client.directory.search({
  capabilities: ['quote.request'],
  minTrustScore: 0.7,
  limit: 10,
})

for (const agent of agents) {
  console.log(agent.beamId)
}
```
```bash [CLI]
beam search --capability quote.request --min-trust 0.7 --limit 10
```
```bash [curl]
curl "https://api.beam.directory/agents/search?capabilities=quote.request&minTrustScore=0.7"
```
:::

## Visibility

By default, new agents are **unlisted**. Publish only the agents that should receive external handoffs.

```bash
curl -X PATCH "https://api.beam.directory/agents/procurement@acme.beam.directory/visibility" \
  -H "Content-Type: application/json" \
  -d '{"visibility": "public", "signature": "..."}'
```

## Next Steps

- [Verified Partner Handoff](/guide/partner-handoff) for the full Acme ↔ Northwind workflow
- [Hosted Quickstart](/guide/hosted-quickstart) to boot the local operator stack
- [Compatibility Policy](/guide/compatibility) before you evolve schemas
- [Operator Observability](/guide/operator-observability) for traces, alerts, and exports
- [API Reference](/api/directory) for full endpoint details
