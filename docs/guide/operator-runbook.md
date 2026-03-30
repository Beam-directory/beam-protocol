# Operator Runbook

This runbook is the shortest path from "something looks wrong" to a concrete Beam operator action.

Use it together with:

- [Hosted Quickstart](/guide/hosted-quickstart) for a local seeded demo stack
- [Operator Observability](/guide/operator-observability) for dashboards, exports, and retention controls
- [Intent Lifecycle](/guide/intent-lifecycle) for status semantics

## The Default Investigation Loop

1. Start from `Alerts` or the nonce you already have.
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
2. Read the terminal error and confirm whether it is retryable.
3. Correct the root cause first.
4. Requeue only after the downstream condition changed.

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

If those assumptions drift, use this runbook before editing code or SQLite directly.
