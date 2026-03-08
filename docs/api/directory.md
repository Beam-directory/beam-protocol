# Directory Server API

Base URL examples:

- managed or shared deployment: `https://dir.beam.directory`
- local self-hosted deployment: `http://localhost:3100`

The reference server currently exposes JSON endpoints for registration, discovery, ACL management, intent relay, catalog inspection, health, and WebSocket transport.

## Data model highlights

### Agent record

```json
{
  "beam_id": "assistant@acme.beam.directory",
  "org": "acme",
  "display_name": "Assistant",
  "capabilities": ["agent.ping", "conversation.message"],
  "public_key": "<SPKI DER base64>",
  "trust_score": 0.5,
  "verified": false,
  "created_at": "2026-03-08T10:00:00.000Z",
  "last_seen": "2026-03-08T10:00:00.000Z"
}
```

### Intent relay endpoints

Beam docs refer to the HTTP relay as `POST /intents`. The current reference server route is:

```text
POST /intents/send
```

If you operate a public API gateway, exposing `POST /intents` as an alias is recommended.

## Registration and discovery

### `POST /agents/register`

Register or update an agent.

```http
POST /agents/register
Content-Type: application/json
```

```json
{
  "beamId": "assistant@acme.beam.directory",
  "displayName": "Assistant",
  "capabilities": ["agent.ping", "conversation.message"],
  "publicKey": "<SPKI DER base64>",
  "org": "acme"
}
```

Success response:

```json
{
  "beam_id": "assistant@acme.beam.directory",
  "org": "acme",
  "display_name": "Assistant",
  "capabilities": ["agent.ping", "conversation.message"],
  "public_key": "<SPKI DER base64>",
  "trust_score": 0.5,
  "verified": false,
  "created_at": "2026-03-08T10:00:00.000Z",
  "last_seen": "2026-03-08T10:00:00.000Z"
}
```

Common errors:

- `400 INVALID_JSON`
- `400 INVALID_BEAM_ID`
- `400 INVALID_PUBLIC_KEY`
- `400 INVALID_CAPABILITIES`
- `400 INVALID_DISPLAY_NAME`
- `400 INVALID_ORG`
- `400 ORG_MISMATCH`
- `429 RATE_LIMITED`
- `500 DB_ERROR`

### `GET /agents/search`

Search by org, capabilities, trust floor, and limit.

```http
GET /agents/search?org=acme&capabilities=agent.ping,task.delegate&minTrustScore=0.5&limit=20
```

Response:

```json
{
  "agents": [
    {
      "beam_id": "assistant@acme.beam.directory",
      "org": "acme",
      "display_name": "Assistant",
      "capabilities": ["agent.ping", "task.delegate"],
      "public_key": "<SPKI DER base64>",
      "trust_score": 0.7,
      "verified": false,
      "created_at": "2026-03-08T10:00:00.000Z",
      "last_seen": "2026-03-08T10:20:00.000Z"
    }
  ],
  "total": 1
}
```

### `GET /agents/:beamId`

Look up a single agent.

```bash
curl http://localhost:3100/agents/assistant%40acme.beam.directory
```

Response on success:

```json
{
  "beam_id": "assistant@acme.beam.directory",
  "org": "acme",
  "display_name": "Assistant",
  "capabilities": ["agent.ping"],
  "public_key": "<SPKI DER base64>",
  "trust_score": 0.7,
  "verified": false,
  "created_at": "2026-03-08T10:00:00.000Z",
  "last_seen": "2026-03-08T10:20:00.000Z"
}
```

Possible errors:

- `404 NOT_FOUND`
- `429 RATE_LIMITED`

### `POST /agents/:beamId/heartbeat`

Refresh `last_seen` for an agent.

```bash
curl -X POST http://localhost:3100/agents/assistant%40acme.beam.directory/heartbeat
```

Responses:

- `204 No Content`
- `404 NOT_FOUND`
- `429 RATE_LIMITED`

### `GET /directory/agents`

List all agents with connection state.

```bash
curl http://localhost:3100/directory/agents
```

Response:

```json
{
  "agents": [
    {
      "beam_id": "assistant@acme.beam.directory",
      "org": "acme",
      "display_name": "Assistant",
      "capabilities": ["agent.ping"],
      "public_key": "<SPKI DER base64>",
      "trust_score": 0.7,
      "verified": false,
      "created_at": "2026-03-08T10:00:00.000Z",
      "last_seen": "2026-03-08T10:20:00.000Z",
      "connected": true
    }
  ],
  "total": 1
}
```

## Intent relay

### `POST /intents/send`

Submit a signed intent to the directory. The server accepts either `payload` or `params` in the body and normalizes internally to `payload`.

```json
{
  "v": "1",
  "intent": "agent.ping",
  "from": "assistant@acme.beam.directory",
  "to": "worker@partner.beam.directory",
  "params": {
    "message": "hello"
  },
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-08T10:00:00.000Z",
  "signature": "<Ed25519 signature>"
}
```

Success response:

```json
{
  "v": "1",
  "success": true,
  "payload": {
    "status": "ok"
  },
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-08T10:00:00.150Z",
  "latency": 150,
  "signature": "<Ed25519 signature>"
}
```

Common errors:

- `400 INVALID_JSON`
- `400 INVALID_BODY`
- `400 INVALID_INTENT`
- `403 FORBIDDEN`
- `429 RATE_LIMITED`
- `503 OFFLINE`
- `504 TIMEOUT`
- `500 RELAY_FAILED`

### `GET /intents/catalog`

Return the current intent catalog.

```bash
curl http://localhost:3100/intents/catalog
```

Response shape:

```json
{
  "intents": [
    {
      "id": "task.delegate",
      "description": "Delegate a task to another agent",
      "from": ["*"],
      "to": ["*"],
      "params": {
        "task": { "type": "string", "required": true },
        "priority": { "type": "string", "enum": ["low", "medium", "high"] }
      }
    }
  ]
}
```

## ACL endpoints

### `POST /acl`

Create or upsert an ACL rule.

```json
{
  "targetBeamId": "billing@acme.beam.directory",
  "intentType": "payment.status_check",
  "allowedFrom": "crm@acme.beam.directory"
}
```

Success response:

```json
{
  "id": 12,
  "target_beam_id": "billing@acme.beam.directory",
  "intent_type": "payment.status_check",
  "allowed_from": "crm@acme.beam.directory",
  "created_at": "2026-03-08T10:00:00.000Z"
}
```

### `GET /acl/:beamId`

List ACLs for a target agent.

```bash
curl http://localhost:3100/acl/billing%40acme.beam.directory
```

Response:

```json
{
  "acl": [
    {
      "id": 12,
      "target_beam_id": "billing@acme.beam.directory",
      "intent_type": "payment.status_check",
      "allowed_from": "crm@acme.beam.directory",
      "created_at": "2026-03-08T10:00:00.000Z"
    }
  ],
  "total": 1
}
```

### `DELETE /acl/:id`

Delete one ACL row.

```bash
curl -X DELETE http://localhost:3100/acl/12
```

Response:

```json
{
  "ok": true,
  "id": 12
}
```

## Health and transport

### `GET /health`

```bash
curl http://localhost:3100/health
```

```json
{
  "status": "ok",
  "protocol": "beam/1",
  "connectedAgents": 2,
  "timestamp": "2026-03-08T10:00:00.000Z"
}
```

### `GET /ws`

WebSocket upgrade endpoint for connected agents.

Connect with the Beam ID as a query parameter:

```text
ws://host:3100/ws?beamId=assistant@acme.beam.directory
```

Messages use a small envelope:

```json
{ "type": "intent", "frame": { "v": "1", "intent": "agent.ping" } }
```

```json
{ "type": "result", "frame": { "v": "1", "success": true } }
```

On initial connection the server sends:

```json
{ "type": "connected", "beamId": "assistant@acme.beam.directory" }
```

## Security checks applied by the reference server

Before forwarding an intent, the directory validates:

- the sender is registered
- the recipient is currently connected for live relay
- the Ed25519 signature is valid
- the timestamp is inside the replay window
- the nonce has not been reused
- ACL policy allows the sender for that intent
- the payload matches the catalog schema
- sender-specific rate limits are not exceeded
