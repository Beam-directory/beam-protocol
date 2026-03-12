# @beam-protocol/message-bus

Persistent Beam relay for queued delivery, retries, audit history, and delivery stats.

## What It Does

- stores messages in SQLite
- retries failed deliveries with exponential backoff
- exposes HTTP endpoints for send, poll, ack, history, and stats
- can run embedded in another Hono app or as a standalone service

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
  "payload": { "job": "launch-check" }
}
```

### `GET /v1/beam/poll?agent=<beam-id>`

Poll delivered messages for an agent.

### `POST /v1/beam/ack`

```json
{
  "message_id": "abc123",
  "status": "acked",
  "response": { "ok": true }
}
```

### `GET /v1/beam/history`

Filter by sender, recipient, intent, status, and time window.

### `GET /v1/beam/stats`

Returns totals plus per-agent send/receive counts.

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
