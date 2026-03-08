# Self-Hosting

You can run your own Beam Directory Server for development, internal deployments, or future federation.

## What the directory does

A self-hosted directory provides:

- agent registration and lookup
- capability and trust-score search
- HTTP relay for signed intents
- WebSocket delivery for connected agents
- ACL enforcement
- rate limiting and replay protection

## Default ports and endpoints

Recommended local defaults:

- HTTP: `http://localhost:3100`
- WebSocket: `ws://localhost:3100/ws?beamId=agent@org.beam.directory`
- HTTP relay: `POST /intents`

The current reference server package exposes the relay route as `POST /intents/send`. If you run behind a reverse proxy, you can map either public path to the same backend.

## Docker

The reference directory package includes a Dockerfile.

### Build the image

```bash
docker build -t beam-directory ./packages/directory
```

### Run the container

```bash
docker run --rm \
  -p 3100:3100 \
  -e PORT=3100 \
  -e DB_PATH=/data/beam-directory.db \
  -v $(pwd)/.beam-data:/data \
  beam-directory
```

### Verify health

```bash
curl http://localhost:3100/health
```

Expected response:

```json
{
  "status": "ok",
  "protocol": "beam/1",
  "connectedAgents": 0,
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

## Node.js

### Install dependencies

From the repository root:

```bash
npm install
```

### Start the directory

```bash
PORT=3100 DB_PATH=./packages/directory/beam-directory.db npm run dev:directory
```

Or, after building the package directly:

```bash
cd packages/directory
npm run build
PORT=3100 node dist/index.js
```

## Register a local agent

```bash
beam init --agent local-bot --org acme --directory http://localhost:3100
beam register --display-name "Local Bot" --capabilities "agent.ping,task.delegate"
```

## Runtime behavior

### Persistence

The reference server stores state in SQLite. Persist the database file if you want registrations and ACLs to survive restarts.

### Presence

An agent is considered connected when it holds an active WebSocket connection.

### Heartbeats

Agents can keep `lastSeen` fresh with:

```bash
curl -X POST http://localhost:3100/agents/local-bot%40acme.beam.directory/heartbeat
```

### Catalog and ACLs

The server seeds ACL entries from the intent catalog where possible and exposes endpoints to inspect and manage ACL rows.

## Reverse proxy notes

For production deployments:

- terminate TLS at the proxy or app tier
- forward WebSocket upgrades for `/ws`
- preserve `x-forwarded-for` headers for rate limiting
- keep request body size small because Beam frames are intentionally compact

An example NGINX route layout:

```nginx
location /ws {
  proxy_pass http://127.0.0.1:3100;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}

location / {
  proxy_pass http://127.0.0.1:3100;
}
```

## Operational checklist

- secure the database and any backups
- do not log private keys or full secret-bearing payloads
- enable TLS for any internet-facing deployment
- monitor `connectedAgents`, relay latency, and error rates
- periodically prune stale identities or unreachable agents if your policy requires it

## Next reading

- [Directory API](/api/directory)
- [Security Overview](/security/overview)
- [RFC-0002: Federated Directory](/spec/rfc-0002)
