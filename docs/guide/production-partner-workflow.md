# First Production Partner Workflow Contract

This page defines the exact workflow Beam `1.0.0` treats as the first production-grade partner handoff.

When the landing page, guided evaluation, onboarding pack, or operator queue says "one workflow," this is the workflow they mean.

## Workflow Name

**Quote Approval Partner Handoff**

## Plain-Language Summary

A buyer-side procurement agent asks a partner-side operations agent for stock, delivery timing, and a quote. The partner-side agent responds on the same Beam thread. A buyer-side operator and finance owner can inspect the request, the reply, and any delayed follow-up without losing the paper trail.

## Why This Workflow

This workflow is the right `1.0.0` anchor because it is:

- cross-company,
- async by nature,
- operationally sensitive,
- easy to explain to a non-technical stakeholder,
- good at exposing whether Beam keeps proof and ownership intact when work slows down.

## Named Roles

### Sender

- buyer-side procurement agent
- example: `procurement@acme.beam.directory`

### Recipient

- partner-side operations or supplier desk agent
- example: `partner-desk@northwind.beam.directory`

### Buyer-Side Owner

- the business owner who cares whether the quote and delivery answer arrives on time

### Operator Owner

- the person who will inspect traces, signal state, dead letters, and recovery steps if the workflow stalls

## Expected Latency

The production contract for this workflow is:

1. **Trace visibility**
   - the request should become visible in Beam within seconds
2. **Operator visibility**
   - an operator should be able to identify the current stage and owner within one minute
3. **Workflow response**
   - the partner side should either reply or record an explicit async follow-up state inside the same thread within the agreed workflow window
4. **Escalation clarity**
   - if the expected business reply window is missed, the operator signal and next action should already be visible

The exact commercial SLA can vary by partner. The product contract does not: Beam must make the state legible, attached, and recoverable.

## Acceptable Failure Handling

The workflow is still acceptable if one of these happens, as long as Beam makes it explicit:

- the recipient is temporarily unavailable and Beam retries,
- policy or trust controls reject the request and the reason is visible,
- the reply needs human or system follow-up later and the same thread carries the next action,
- the request reaches dead-letter and the operator can point at the failure state without guessing.

The workflow is **not** acceptable if:

- a request disappears without a visible state,
- the operator cannot say who owns the next step,
- the proof depends on memory or ad hoc chat recap,
- a buyer has to trust that the message moved without seeing the evidence.

## Operator Proof Points

For this workflow to count as production-ready, Beam must show:

- a healthy operator baseline before the request starts,
- one traceable request from arrival to reply or explicit async follow-up,
- one owner and next action attached to the request,
- visible retry, delay, or dead-letter state if the workflow degrades,
- a proof package that can be shared without exposing operator-only detail.

## Production-Ready Exit Criteria

Beam `1.0.0` should treat this workflow as production-ready only when all of these are true:

- the workflow can be explained in one sentence by a normal buyer,
- the sender and recipient are fixed and visible,
- the onboarding pack and go-live checklist both point at this same workflow,
- the operator dashboard can show the current state, owner, and recovery path,
- blocked go-live prerequisites can be recorded explicitly in the request,
- the proof pack can be exported from live evidence,
- backup, restore, and fire-drill paths have been rehearsed on the current architecture,
- the final dry runs pass for buyer, operator, and production-partner views.

## What This Contract Does Not Try To Cover

This contract does not try to solve every Beam use case at once. It is intentionally narrow.

It does **not** define:

- a generic internal automation story,
- a marketplace of many workflows,
- broad enterprise rollout packaging,
- a self-serve "bring all your agents" motion.

If the first production partner workflow is not stable, Beam should not pretend the broader story is production-ready.

## Related Guides

- [Production Partner Onboarding Pack](/guide/design-partner-onboarding)
- [Production Go-Live Checklist](/guide/production-go-live-checklist)
- [Operator Runbook](/guide/operator-runbook)
- [Hosted Quickstart](/guide/hosted-quickstart)
