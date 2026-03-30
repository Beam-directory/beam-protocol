# Verified Partner Handoff

This is the canonical Beam 0.6 workflow.

The goal is simple: Acme needs a quote from Northwind without custom API work. Beam gives both sides verified addresses, signed requests, and an operator-visible trace.

If you want this exact flow running locally with seeded identities and operator tooling, start with the [Hosted Quickstart](/guide/hosted-quickstart) and `npm run demo:run` first.

## The Workflow

```text
procurement@acme.beam.directory
  -> partner-desk@northwind.beam.directory
  -> warehouse@northwind.beam.directory
  -> signed quote back to procurement@acme.beam.directory
```

## Why This Is the Right Starting Point

- it crosses a company boundary
- identity and policy matter
- operators need retries, traces, and audit logs
- the business outcome is obvious: did the quote come back or not

## 1. Register the Three Agents

The runnable example lives in [`examples/partner-handoff`](https://github.com/Beam-directory/beam-protocol/tree/main/examples/partner-handoff).

```typescript
const procurement = await createRegisteredClient({
  prefix: 'procurement',
  displayName: 'Acme Procurement Desk',
  capabilities: ['quote.request'],
})

const partnerDesk = await createRegisteredClient({
  prefix: 'partner-desk',
  displayName: 'Northwind Partner Desk',
  capabilities: ['quote.request', 'inventory.check'],
})

const warehouse = await createRegisteredClient({
  prefix: 'warehouse',
  displayName: 'Northwind Warehouse',
  capabilities: ['inventory.check'],
})
```

## 2. Allow the Handoff Path

Beam makes the trust boundary explicit:

```typescript
await allowIntent({
  targetBeamId: partnerDesk.beamId,
  intentType: 'quote.request',
  allowedFrom: procurement.beamId,
})

await allowIntent({
  targetBeamId: warehouse.beamId,
  intentType: 'inventory.check',
  allowedFrom: partnerDesk.beamId,
})
```

## 3. Execute the Quote Request

```typescript
const quote = await procurement.send(partnerDesk.beamId, 'quote.request', {
  project: 'Mannheim rooftop rollout',
  sku: 'INV-240',
  quantity: 240,
  shipTo: 'Mannheim, DE',
  neededBy: '2026-04-03',
})

console.log(quote.payload)
```

The receiving side resolves inventory before answering:

```typescript
partnerDesk.on('quote.request', async (frame, respond) => {
  const inventoryResult = await partnerDesk.send(warehouse.beamId, 'inventory.check', {
    sku: frame.payload.sku,
    quantity: frame.payload.quantity,
    shipTo: frame.payload.shipTo,
  })

  respond({
    success: true,
    payload: {
      project: frame.payload.project,
      quotedUnitPriceEur: 184,
      totalPriceEur: Number(frame.payload.quantity ?? 0) * 184,
      supplier: partnerDesk.beamId,
      inventory: inventoryResult.payload,
    },
  })
})
```

## 4. Fan Out The Async Finance Preflight

After the quote response, Northwind can fan out a finance notification through the message bus without keeping the original sender blocked.

Recommended response payload:

```json
{
  "accepted": true,
  "acknowledgement": "accepted",
  "terminal": false
}
```

Interpretation:

- the finance side accepted delivery
- the notification is not a terminal completion signal for the bus
- operators should expect the bus status to remain `delivered` unless a consumer later records `acked`

## 5. Observe The Same Handoff

For this workflow, the important operator questions are:

1. Did `quote.request` get delivered?
2. Did `partner-desk` successfully call `inventory.check`?
3. Did any retry, dead letter, or ACL failure occur?

Beam 0.6 answers those with:

- `/observability/intents/:nonce` for a full trace
- `/observability/audit` for operator and control-plane events
- `/observability/alerts` for failure-rate and stuck-intent heuristics
- `/v1/beam/stats` and `/v1/beam/dead-letter` when the message bus is involved

The fastest investigation path is documented in the [Operator Runbook](/guide/operator-runbook).

## 6. Expand Only After This Works

Once this handoff is solid, add adjacent actors:

- `finance@acme.beam.directory` for approval notifications
- `logistics@carrier.beam.directory` for shipment reservation
- `qa@northwind.beam.directory` for fulfillment confirmations

Do not start there. Start with the single partner handoff, make it boringly reliable, then grow outward.
