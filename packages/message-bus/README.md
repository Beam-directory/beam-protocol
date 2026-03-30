# @beam-protocol/message-bus

Persistent Beam relay for queued delivery, retries, audit history, and delivery stats.

## What It Does

- stores messages in SQLite
- enforces stable nonce-based dedupe end to end
- retries retryable delivery failures with bounded backoff plus deterministic jitter
- exposes HTTP endpoints for send, poll, ack, history, stats, and dead-letter inspection
- can run embedded in another Hono app or as a standalone service

## Delivery Model

- The bus uses the canonical Beam lifecycle: `received`, `queued`, `dispatched`, `delivered`, `acked`, `failed`, `dead_letter`.
- `delivered` means the downstream recipient or directory accepted delivery. It does **not** mean the business task is complete yet.
- `acked` means a consumer or operator recorded terminal completion for the bus message.
- Every bus message gets a persisted `nonce`. If the same `nonce` is submitted again with the same sender, recipient, intent, and payload, the bus returns the existing message instead of redelivering it.
- Retryable errors from the directory (`OFFLINE`, `TIMEOUT`, `DELIVERY_FAILED`, `DIRECT_HTTP_FAILED`, `IN_PROGRESS`, `RATE_LIMITED`, transport timeouts, and connection errors) are retried.
- Non-retryable errors (`INVALID_INTENT`, `FORBIDDEN`, `UNAUTHORIZED`, nonce conflicts, and other hard 4xx failures) are dead-lettered immediately.
- Retry delays use the policy `30s, 60s, 120s, 240s, 480s` with deterministic ±15% jitter derived from the nonce. The `max_retries` limit bounds total attempts, after which the message moves to `dead_letter`.
- Dead-lettered messages stay queryable through the API and can be manually requeued while keeping the original nonce.

For async handoffs, the recommended receiver payload is:

```json
{
  "accepted": true,
  "acknowledgement": "accepted",
  "terminal": false
}
```

That makes it explicit that delivery was accepted while terminal completion is still pending elsewhere.

## Install

```bash
npm install @beam-protocol/message-bus
```

## Run with npm

### As a library

```ts
import { createBus } from '@beam-protocol/message-bus'

const bus = createBus({
  directoryUrl: 'http://localhost:3100',
  dbPath: './beam-bus.sqlite',
  port: 8420,
})

await bus.start()
```

### As a standalone server

```bash
npm install
npm run build
node dist/server.js --port 8420 --directory http://localhost:3100 --db ./beam-bus.sqlite
```

Environment variables:

- `PORT` - HTTP port, default `8420`
- `DB_PATH` - SQLite database path
- `DIRECTORY_URL` - Beam directory base URL
- `IDENTITY_PATH` - optional identity bundle for directory delivery helpers
- `BEAM_BUS_API_KEY` - bearer token required for API access
- `BEAM_BUS_STATS_PUBLIC=true` - allow unauthenticated `GET /v1/beam/stats`
- `BEAM_BUS_CLEAN_TEST_DATA=true` - remove demo/test rows on startup

## API

### `POST /v1/beam/send`

```json
{
  "from": "alpha@beam.directory",
  "to": "beta@beam.directory",
  "intent": "task.execute",
  "payload": { "job": "launch-check" },
  "nonce": "optional-stable-id"
}
```

### `GET /v1/beam/poll?agent=<beam-id>`

Poll delivered messages for an agent. `poll` is the normal bridge between `delivered` and terminal consumer action for async flows.

### `POST /v1/beam/ack`

```json
{
  "message_id": "abc123",
  "status": "acked",
  "response": { "ok": true }
}
```

Use `status: "acked"` only when the polled message reached a terminal outcome for the bus consumer. If the receiver merely accepted downstream work, keep the bus message in `delivered` and return an application-level payload such as `{"acknowledgement":"accepted","terminal":false}`.

### `GET /v1/beam/history`

Filter by sender, recipient, intent, status, and time window.

### `GET /v1/beam/stats`

Returns totals plus per-agent send/receive counts, including `dead_letter`.

### `GET /v1/beam/dead-letter`

Lists terminal failures for operators. Supports `sender`, `recipient`, `intent`, and `limit` query parameters.

### `POST /v1/beam/dead-letter/:id/requeue`

Attempts immediate redelivery for a dead-lettered message while preserving the original nonce. If the downstream failure is still retryable, the bus schedules the message again with the standard retry policy.

## Deployment

### Docker

The package ships with [`Dockerfile`](./Dockerfile):

```bash
cd packages/message-bus
npm install
npm run build
docker build -t beam-message-bus .
docker run --rm -p 8420:8420 \
  -e DIRECTORY_URL=https://api.beam.directory \
  -e BEAM_BUS_API_KEY=local-dev-token \
  -v "$PWD/data:/data" \
  beam-message-bus
```

### Fly.io

The repo includes [`fly.toml`](./fly.toml):

```bash
cd packages/message-bus
fly launch --copy-config --no-deploy
fly volumes create beam_bus_data --size 1
fly secrets set BEAM_BUS_API_KEY=your-token
fly deploy
```

### Embedded Hono router

```ts
import { Hono } from 'hono'
import { initDatabase, createBusRouter } from '@beam-protocol/message-bus'

const app = new Hono()
const db = initDatabase('./beam-bus.sqlite')
app.route('/v1/beam', createBusRouter({ db, directoryUrl: 'http://localhost:3100' }))
```

## License

Apache-2.0
