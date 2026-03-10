# @beam-protocol/message-bus

Persistent message bus for the [Beam Protocol](https://beam.directory) — reliable agent-to-agent communication with retry, audit trail, and guaranteed delivery.

## Features

- **Persistent Queue** — Messages survive restarts (SQLite)
- **Guaranteed Delivery** — Exponential backoff retry (30s → 480s, configurable)
- **Audit Trail** — Full message history with timestamps, status, and responses
- **Rate Limiting** — Per-agent rate limits to prevent flooding
- **Ed25519 Signed** — Messages are cryptographically signed
- **Zero Config** — Works out of the box with Beam Directory

## Quick Start

```bash
npm install @beam-protocol/message-bus
```

### Standalone Server

```typescript
import { createBus } from '@beam-protocol/message-bus'

const bus = createBus({
  dbPath: './beam-bus.sqlite',
  directoryUrl: 'http://localhost:3100',
  identityPath: './beam-identity.json',
  port: 8420,
})

await bus.start()
```

### As Express/Hono Middleware

```typescript
import { createBusRouter } from '@beam-protocol/message-bus'

const router = createBusRouter({
  dbPath: './beam-bus.sqlite',
  directoryUrl: 'http://localhost:3100',
})

app.route('/v1/beam', router)
```

### CLI

```bash
npx @beam-protocol/message-bus --port 8420 --directory http://localhost:3100
```

## API

### `POST /v1/beam/send`

Send a message through the bus.

```json
{
  "from": "my-agent@org.beam.directory",
  "to": "other-agent@org.beam.directory",
  "intent": "task.delegate",
  "payload": { "task": "Process order #123" }
}
```

### `GET /v1/beam/poll?agent=<beam-id>`

Poll for messages addressed to your agent.

### `POST /v1/beam/ack`

Acknowledge receipt/completion of a message.

```json
{
  "message_id": "abc123",
  "status": "acked",
  "response": { "result": "Order processed" }
}
```

### `GET /v1/beam/history`

Query message history with filters (sender, recipient, intent, status, date range).

### `GET /v1/beam/stats`

Monitoring statistics: total messages, pending, delivered, acked, failed, per-agent breakdown.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `dbPath` | `./beam-bus.sqlite` | SQLite database path |
| `directoryUrl` | `http://localhost:3100` | Beam Directory URL |
| `identityPath` | `./beam-identity.json` | Path to Beam identity file |
| `retryInterval` | `30000` | Retry worker interval (ms) |
| `maxRetries` | `5` | Max delivery attempts |
| `rateLimit` | `10` | Messages per minute per sender |
| `port` | `8420` | Server port (standalone mode) |

## Architecture

```
Your Agent ──→ POST /v1/beam/send ──→ Message Bus ──→ Beam Directory ──→ Recipient
                                          │
                                    SQLite Queue
                                    (persistent)
                                          │
                                    Retry Worker
                                    (30s interval)
```

## License

AGPL-3.0-or-later — see [LICENSE](../../LICENSE)
