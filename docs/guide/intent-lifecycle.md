# Intent Lifecycle

Beam 0.6.0 exposes one canonical lifecycle for intent delivery across HTTP, WebSocket, federation, and the message bus.

## Canonical States

- `received`: Beam accepted the envelope and started handling the nonce.
- `validated`: identity, signature, ACL, replay, and payload checks passed.
- `queued`: the message bus is holding the intent for retry or deferred delivery.
- `dispatched`: Beam selected a route and handed the intent to a transport attempt.
- `delivered`: the target agent or downstream directory accepted delivery.
- `acked`: the recipient completed the intent and returned a successful result.
- `failed`: the intent ended in a terminal failure for this attempt.
- `dead_letter`: the message bus exhausted retries or hit a non-retryable terminal failure.

## Transition Rules

Beam validates lifecycle transitions in code. The allowed path is:

1. `received`
2. `validated`
3. `queued` or `dispatched`
4. `delivered`
5. `acked` or `failed`

Additional rules:

- `queued -> dispatched` is the normal retry-worker path.
- `dispatched -> queued` is allowed when a retryable delivery attempt is rescheduled.
- `failed -> queued` and `dead_letter -> queued` are allowed only for retry or operator requeue flows.
- `dead_letter` is terminal unless an operator explicitly requeues the nonce.
- `acked` is terminal.

## Derived Outcome Buckets

The dashboard still shows aggregate outcome metrics, but they are derived from lifecycle state instead of being stored as primary statuses.

- `success`: `acked`
- `error`: `failed`, `dead_letter`
- `in_flight`: `received`, `validated`, `queued`, `dispatched`, `delivered`

## Delivery Acceptance Vs Terminal Acknowledgement

Beam now uses one explicit acknowledgement vocabulary across the directory, message bus, dogfood flows, and dashboard:

- `delivered` means delivery was accepted by the target agent or downstream directory
- `acked` means the work reached a terminal acknowledged outcome for that transport path

That distinction matters most for async message-bus initiated work. A sender may fan out a notification and stop waiting after the receiver accepts it. In that case:

- the bus message stays `delivered`
- the application payload should say `acknowledgement: "accepted"`
- `terminal` should be `false`

Example async acceptance payload:

```json
{
  "accepted": true,
  "acknowledgement": "accepted",
  "terminal": false,
  "reviewedBy": "finance@acme.beam.directory"
}
```

When a polled bus consumer later records completion through `POST /v1/beam/ack`, the lifecycle advances to `acked`.

## Transport Mapping

### Directory HTTP / WebSocket / Federation

The directory records the same top-level sequence for all delivery paths:

1. `received`
2. `validated`
3. `dispatched`
4. `delivered`
5. `acked` or `failed`

Transport-specific details such as `direct-http`, `ws`, `federation`, fallback behavior, peer URLs, and timeouts are attached in trace-event `details` instead of inventing transport-only lifecycle names.

### Message Bus

The message bus uses the same status vocabulary, but not every message visits every state:

- synchronous acceptance: `received -> dispatched -> delivered`
- successful consumer acknowledgement: `... -> acked`
- retryable delivery failure: `... -> queued`
- terminal retry exhaustion: `... -> dead_letter`

Interpretation:

- `POST /v1/beam/send` returning `delivered` means the bus handed off the nonce successfully
- `GET /v1/beam/poll` lets an async consumer inspect those accepted deliveries
- `POST /v1/beam/ack` is what turns accepted delivery into a terminal `acked` or `failed` outcome

## Migration Notes

Beam normalizes legacy rows on startup:

- `pending -> received`
- `success -> acked`
- `error -> failed`
- `expired -> dead_letter`

Legacy trace stages are normalized into the canonical state model and keep the original transport-specific labels in `details.legacyStage` and `details.legacyStatus` when needed.
