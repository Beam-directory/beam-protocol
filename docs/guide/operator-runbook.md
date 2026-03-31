# Operator Runbook

This runbook is the shortest path from "something looks wrong" to a concrete Beam operator action.

Use it together with:

- [Hosted Quickstart](/guide/hosted-quickstart) for a local seeded demo stack
- [First Production Partner Workflow Contract](/guide/production-partner-workflow) for the exact `1.0.0` workflow Beam is trying to make boring
- [Production Partner Onboarding Pack](/guide/design-partner-onboarding) for buyer expectations, evaluation prep, and follow-up templates
- [Production Go-Live Checklist](/guide/production-go-live-checklist) for explicit launch blockers and rollout readiness
- [Operator Observability](/guide/operator-observability) for dashboards, exports, and retention controls
- [Intent Lifecycle](/guide/intent-lifecycle) for status semantics

## Operator Inbox First

Start the day in `Inbox` before drilling into traces.

- `new` means nobody has acknowledged the request or alert yet.
- `acknowledged` means an operator has taken ownership or triaged the signal.
- `acted` means the next concrete step or remediation was already recorded.

Use the inbox for two classes of work:

- hosted beta requests that still need assignment, contact, or a next action
- critical alerts that need triage, acknowledgement, and an explicit follow-up

When the signal is a hosted beta request, pair the inbox with the [Production Partner Onboarding Pack](/guide/design-partner-onboarding) and the [Production Go-Live Checklist](/guide/production-go-live-checklist). The pack gives you the shared expectations and reply templates for `new`, `reviewing`, `contacted`, `scheduled`, `active`, and `closed` request states, and the checklist gives you the explicit blockers Beam should keep visible before go-live.

The shortest daily loop is:

1. Open `Inbox`.
2. Filter to `new`.
3. Acknowledge or act on each signal.
4. Record an owner and next action on critical alerts before you leave the inbox.
5. Jump into `Beta Requests`, `Alerts`, or the linked trace from there.

## The Default Investigation Loop

1. Start from `Inbox`, `Alerts`, or the nonce you already have.
2. Open the trace and note the current lifecycle status.
3. Confirm related audit or Shield events.
4. Check `Dead Letters` only if the nonce is terminal or obviously retrying.
5. Export evidence before prune or manual requeue.

## Failure Mode 1: Stuck In `delivered`

Symptoms:

- trace status is `delivered`
- no terminal `acked`
- sender says downstream work never finished

Meaning:

- delivery was accepted
- terminal completion was **not** recorded for that transport path yet

What to do:

1. Open the trace and confirm the latest stage is `delivered`.
2. Check whether this is an async message-bus fan-out that only promised `acknowledgement: "accepted"`.
3. Open `Alerts` for stuck or aged in-flight items.
4. If the same nonce later belongs in queue management, inspect `Dead Letters`.

## Failure Mode 2: `queued` Or Repeated Retries

Symptoms:

- trace or queue status is `queued`
- latency grows without terminal failure
- retry count increases

Likely causes:

- target agent offline
- temporary network or HTTP failure
- rate limiting

What to do:

1. Open the trace and confirm the error is retryable.
2. Check target-agent health and recent `Errors`.
3. Confirm no matching Shield or rate-limit event explains the queueing.
4. Wait for the retry window or fix the target, then re-run only if needed.

## Failure Mode 3: `dead_letter`

Symptoms:

- message bus nonce appears in `Dead Letters`
- retries exhausted or a non-retryable failure happened

What to do:

1. Open the dead-letter row and then the trace link for the same nonce.
2. Open the recipient agent or the linked alert context if Beam already has a critical signal for the same failure pattern.
3. Record or confirm the owner and next action in `Inbox` if the fix is not already obvious.
4. Correct the root cause first.
5. Requeue only after the downstream condition changed.

## Failure Mode 4: `FORBIDDEN` Or ACL Denial

Symptoms:

- trace ends in `failed`
- error code contains `FORBIDDEN` or ACL failure language

What to do:

1. Open the trace and confirm the sender and target Beam IDs.
2. Check audit history for recent ACL or role changes.
3. Reseed the hosted demo with `npm run demo:seed` if you are on the local quickstart stack.
4. For production, fix the exact ACL entry instead of widening access blindly.

## Failure Mode 5: Rate Limit Or Shield Intervention

Symptoms:

- trace fails quickly
- audit or Shield context shows block, throttle, or risk decision
- error code contains `RATE_LIMITED`, `UNAUTHORIZED`, or similar

What to do:

1. Open the trace and inspect the `Shield Context`.
2. Correlate with `Alerts` and `Errors`.
3. Confirm whether the sender is expected and trusted.
4. Adjust policy only after confirming this is valid traffic.

## Clean Demo Expectations

In the seeded hosted demo:

- quote trace ends in `acked`
- async finance preflight may stay in `delivered`
- dead-letter count stays `0`
- alerts stay empty for the clean path
- inbox contains no lingering `new` critical-alert signals after triage
- hosted beta requests should move from `new` to `acknowledged` or `acted` once an owner and next action exist

If those assumptions drift, use this runbook before editing code or SQLite directly.
