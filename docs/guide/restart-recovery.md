# Restart Recovery

Beam persists intent and message state so operators can restart the directory or message bus without silently losing active work.

## Directory recovery

On boot, the directory inspects every non-terminal intent in `intent_log`.

- `received`, `validated`, `queued`, and `dispatched` intents are finalized as `failed` with a retryable recovery error. These requests were interrupted before Beam could prove a delivery outcome.
- `delivered` intents are treated differently. Beam keeps them open if the original result timeout has not expired yet, because the recipient may still reconnect and return a late result for the same `nonce`.
- Recovered `delivered` intents are swept in the background. If the original timeout window expires and no late result arrives, Beam finalizes them as `failed` with `TIMEOUT`.
- If a late result does arrive after restart, Beam reconciles the persisted record instead of creating a second delivery. The original `nonce` stays authoritative.

Operator expectation:

- a restart may turn interrupted dispatches into retryable failures
- already delivered work can still complete successfully after the process comes back
- replaying the same `nonce` after recovery never creates a second trace for a cached success

## Message bus recovery

The message bus replays persisted work on startup.

- `received` and `dispatched` bus messages are requeued immediately on boot
- the original `nonce` is preserved
- queued retry windows remain intact because `next_retry_at` is stored in SQLite
- `delivered`, `acked`, `failed`, and `dead_letter` messages are left unchanged

This means a crash during an outbound delivery attempt does not strand the message in an in-memory state that the retry worker can no longer see.

## Operational notes

- Keep the SQLite database on durable storage. Recovery depends on persisted `intent_log`, `intent_trace_events`, and `beam_messages` rows surviving the restart.
- `RELAY_TIMEOUT_MS` controls the default timeout used when Beam has to recover an orphaned `delivered` intent and no explicit timeout was stored in the trace details.
- `RELAY_RECOVERY_SWEEP_INTERVAL_MS` controls how often the directory checks recovered `delivered` intents for expiry after restart.

## Recommended verification

For release or deployment checks, verify at least these scenarios:

1. restart the directory after a recipient has received an intent but before it has returned a result
2. restart the message bus while a message is in `dispatched`
3. confirm that resending the same `nonce` returns the cached result or cached failure instead of creating a duplicate delivery
