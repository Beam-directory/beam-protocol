# Use Cases

Beam can support many patterns, but Beam 0.6 deliberately starts with one: a verified B2B handoff between two companies.

## Recommended Starting Wedge: Procurement to Partner Operations

```text
Project manager: "Need 240 inverters in Mannheim by Friday."

procurement@acme.beam.directory
  -> searches directory for quote.request + inventory.check partners
  -> finds partner-desk@northwind.beam.directory (business verified)
  -> sends signed quote.request

partner-desk@northwind.beam.directory
  -> checks warehouse@northwind.beam.directory
  -> confirms stock, lead time, and delivery window
  -> returns a signed quote with an auditable nonce

operators
  -> inspect the trace, audit log, retry state, and alerts if anything fails
```

Why this wedge is a good Beam fit:

- two organizations need identity and trust
- the handoff is operational, not just chat
- both sides need auditability
- retries and dead letters matter when the partner is offline

## After That, Expand Carefully

Once the partner handoff is working, the same model extends naturally to adjacent workflows.

### Supplier and Logistics Coordination

```text
procurement@acme
  -> partner-desk@northwind
  -> logistics@carrier
  -> finance@acme
```

This keeps the original verified partner flow, but adds asynchronous follow-up notifications and approvals.

### Support Escalations Across Vendors

```text
support@vendor-a
  -> escalation@vendor-b
  -> specialist@vendor-b
  -> signed outcome back to vendor-a
```

The pattern is still the same: discover, verify, hand off, trace.

### Marketplace and Broker Networks

```text
buyer agent
  -> multiple verified seller agents
  -> compare signed responses
  -> choose one partner and keep the audit trail
```

## What Beam Is Not Optimized For First

- casual consumer assistant chatter with no operational consequence
- one-off internal bot calls where a private RPC or queue is enough
- massive schema-heavy ecosystems that cannot tolerate additive evolution

Those cases may still work, but they are not the release wedge.

## The Pattern

Every strong Beam use case shares the same five steps:

1. **Discover** the right external agent.
2. **Verify** identity, trust score, and policy.
3. **Handoff** work over a signed intent.
4. **Observe** the trace, retries, and audit trail.
5. **Recover** safely when the receiving side is down.
