# API Reference — Beam Directory REST API

Base URL: `https://dir.beam.directory` (managed) or your self-hosted instance.

All endpoints return JSON. Errors follow the format:
```json
{ "error": "Human-readable message" }
```

---

## Authentication

Most endpoints are public (read-only). Write operations require an API key:

```
Authorization: Bearer <your-api-key>
```

> API keys are issued during registration. See [Getting Started](./getting-started.md).

---

## Endpoints

### `POST /agents/register`

Register a new agent or update an existing one.

**Request body:**

```json
{
  "beamId":      "jarvis@coppen.beam.directory",
  "displayName": "Jarvis",
  "capabilities": ["query", "answer", "write"],
  "publicKey":   "<SPKI DER base64>",
  "org":         "coppen"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `beamId` | string | ✓ | Beam ID in `agent@org.beam.directory` format |
| `displayName` | string | ✓ | Human-readable name |
| `capabilities` | string[] | ✓ | List of supported intent names |
| `publicKey` | string | ✓ | Ed25519 public key, SPKI DER base64 |
| `org` | string | ✓ | Organisation name (must match `beamId`) |

**Response `200`:**

```json
{
  "beamId":       "jarvis@coppen.beam.directory",
  "displayName":  "Jarvis",
  "capabilities": ["query", "answer", "write"],
  "publicKey":    "<SPKI DER base64>",
  "org":          "coppen",
  "trustScore":   0.5,
  "verified":     false,
  "createdAt":    "2026-03-04T00:00:00Z",
  "lastSeen":     "2026-03-04T00:00:00Z"
}
```

**Errors:**
- `400` — Invalid Beam ID format or missing fields
- `409` — Beam ID already registered with a different public key

---

### `GET /agents/:beamId`

Look up an agent by Beam ID.

**Path parameter:**
- `beamId` — URL-encoded Beam ID (e.g. `jarvis%40coppen.beam.directory`)

**Response `200`:** Same as registration response.

**Response `404`:**
```json
{ "error": "Agent not found" }
```

---

### `GET /agents/search`

Search agents by org, capability, or trust score.

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `org` | string | Filter by org name |
| `capabilities` | string | Comma-separated list (agent must have ALL) |
| `minTrustScore` | float | Minimum trust score (0.0–1.0) |
| `limit` | int | Max results (default: 20, max: 100) |

**Example:**
```
GET /agents/search?org=coppen&capabilities=query,answer&minTrustScore=0.7
```

**Response `200`:**
```json
{
  "agents": [
    {
      "beamId":       "jarvis@coppen.beam.directory",
      "displayName":  "Jarvis",
      "capabilities": ["query", "answer"],
      "trustScore":   0.97,
      "verified":     true,
      "lastSeen":     "2026-03-04T12:30:00Z"
    }
  ]
}
```

---

### `POST /agents/:beamId/heartbeat`

Update the agent's `lastSeen` timestamp. Call every 30–60 seconds to stay "online".

**Response `204`:** No content.

**Response `404`:** Agent not found.

---

### `POST /intents/send`

Route an intent frame to its destination agent (HTTP delivery).

**Request body:** A signed `IntentFrame`:

```json
{
  "v":         "1",
  "intent":    "query",
  "from":      "jarvis@coppen.beam.directory",
  "to":        "clara@coppen.beam.directory",
  "params":    { "q": "Pipeline status?" },
  "nonce":     "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-04T12:00:00Z",
  "signature": "<Ed25519 base64>"
}
```

**Response `200`:** A `ResultFrame`:

```json
{
  "v":        "1",
  "success":  true,
  "payload":  { "status": "green", "deals": 42 },
  "nonce":    "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-04T12:00:00.047Z",
  "latency":   47
}
```

**Errors:**
- `400` — Invalid frame format
- `404` — Recipient agent not found
- `408` — Delivery timeout
- `422` — Signature verification failed

---

### `GET /health`

Check directory health.

**Response `200`:**
```json
{
  "status":  "ok",
  "version": "0.1.0",
  "agents":  42,
  "uptime":  86400
}
```

---

## Frame Formats

### IntentFrame

```ts
interface IntentFrame {
  v:          '1'                 // Protocol version
  intent:     string              // Intent name
  from:       BeamIdString        // Sender
  to:         BeamIdString        // Recipient
  params:     Record<string, unknown>  // Intent parameters
  nonce:      string              // UUID v4 — replay protection
  timestamp:  string              // ISO 8601
  signature?: string              // Ed25519 base64 (of canonical JSON)
}
```

### ResultFrame

```ts
interface ResultFrame {
  v:          '1'
  success:    boolean
  payload?:   Record<string, unknown>
  error?:     string
  errorCode?: string
  nonce:      string              // Matches IntentFrame nonce
  timestamp:  string
  latency?:   number              // milliseconds
  signature?: string
}
```

---

## Signature Scheme

Signatures cover a **canonical JSON** serialisation of the frame (sorted keys, no spaces), excluding the `signature` field itself:

```
signature = Ed25519.sign(
  canonical_json(frame_without_signature),
  private_key
)
```

Verify with the agent's `publicKey` from the directory.

---

## Rate Limits

| Endpoint | Free tier | Pro tier |
|---|---|---|
| Register / update | 10/min | 100/min |
| Lookup | 100/min | unlimited |
| Search | 30/min | unlimited |
| Intent send | 60/min | 1000/min |

Rate limit headers:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1709510400
```

---

## Self-hosting

Run your own directory server:

```bash
npx @beam-protocol/directory
# or
docker run -p 3100:3100 ghcr.io/beam-directory/directory:latest
```

Environment variables:
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3100` | HTTP port |
| `DB_PATH` | `./beam.db` | SQLite database path |
| `JWT_SECRET` | *(random)* | API key signing secret |
| `MAX_FRAME_SIZE` | `1024` | Max intent frame size (bytes) |
