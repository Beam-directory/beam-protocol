# Production Go-Live Checklist

Use this checklist when a hosted pilot is about to become a real production partner workflow.

This page is operator-facing. Buyers should read the [Production Partner Onboarding Pack](/guide/design-partner-onboarding). Operators should use this checklist to decide whether the workflow is ready to go live or explicitly blocked.

The workflow contract lives here:

- [First Production Partner Workflow Contract](/guide/production-partner-workflow)

## Hard Rule

If any required item is still missing, record it as a blocked prerequisite on the partner request. Do not hide missing prerequisites inside free-form notes.

## The Six Go-Live Prerequisites

These are the exact checklist items Beam operators should track in the dashboard:

1. **Workflow owner confirmed**
   - the buyer-side business owner is named
   - the partner-side owner is known
2. **Sender and receiver confirmed**
   - the first sender and first receiving system are fixed
   - both sides agree this is the first production shape
3. **Success metric confirmed**
   - both sides agree what a "good" first production week means
4. **Security review confirmed**
   - compliance, trust, routing, and policy expectations are agreed
5. **Go-live window confirmed**
   - the initial rollout window has an owner, date, and rollback path
6. **Proof recipients confirmed**
   - both sides know who receives the recap and proof export

## Before Go-Live

- confirm the workflow still matches the [First Production Partner Workflow Contract](/guide/production-partner-workflow)
- confirm the request has a visible owner and next action
- confirm the latest walkthrough proof is attached to the same request
- confirm the operator knows where to inspect trace, signal, alerts, and dead letters
- confirm the partner thread has the correct reminder and next-meeting state

## Day-Of Go-Live

- confirm Beam overview is healthy
- confirm no unrelated critical alert pressure is already open
- confirm the correct sender and recipient identities are active
- confirm policy and trust settings match the agreed workflow
- confirm the operator signal path is clear before the first live request starts

## First 24 Hours

- check the first live requests in the trace view
- confirm owner and next action stay attached if follow-up becomes async
- check alerts and dead letters before declaring the rollout healthy
- send the proof recap to the named recipients
- record whether the workflow should expand, narrow, or pause

## Rollback And Recovery

If the first live window breaks:

1. open the trace for the failing request
2. open the linked operator signal
3. check dead letters or retries only after the trace confirms that path
4. record the owner and next recovery step on the same partner request
5. do not declare the rollout healthy again until the reason for failure is explicit

## Exit Condition

The go-live checklist is complete only when:

- no required prerequisite is blocked,
- the first live requests are visible and legible,
- the operator can explain the current state without ad hoc chat context,
- the proof recap was sent to the named recipients,
- the next commercial or operational decision is explicit.
