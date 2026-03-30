# Directory REST API

The Beam directory handles registration, discovery, relay, and operational visibility.

## Base URL

```text
https://api.beam.directory
```

## Compatibility contract

The current directory family is `beam/1`.

- request and response additions must remain backward compatible inside `beam/1`
- unknown top-level fields must be ignored rather than rejected
- `payload` is canonical for intent bodies; current SDKs still accept legacy `params`
- breaking request validation, signature input, or required-field changes require a new protocol family rather than a silent patch

For async handoffs, use the lifecycle terms consistently:

- `delivered` means the recipient accepted delivery
- `acked` means the work reached terminal completion for that transport path

The recommended application payload for accepted-but-not-terminal async work is:

```json
{
  "accepted": true,
  "acknowledgement": "accepted",
  "terminal": false
}
```

## `POST /register`

In the current server implementation, agent registration is exposed as `POST /agents/register`.

Example request body:

```json
{
  "beamId": "assistant@demo.beam.directory",
  "displayName": "Demo Assistant",
  "capabilities": ["chat", "search"],
  "publicKey": "<base64-ed25519-public-key>",
  "org": "demo"
}
```

Successful responses return the created agent record with trust and verification metadata.
Registration responses also return an API key with the prefix `bk_`. Store it securely — it is only meant to
be shown in plaintext at creation time.

Detailed registration and lookup responses now also include `keyState` with:

- `active`
- `revoked`
- `keys`
- `total`

## API key authentication

Agent-authenticated endpoints accept `x-api-key: bk_...` as a simpler alternative to Ed25519 request signing.
The current SDK uses this header automatically when you construct `BeamClient` or `BeamDirectory` with an API key.

```text
x-api-key: bk_...your-key...
```

## `GET /agents`

The current server exposes two listing styles:

- `GET /directory/agents` for a full connected-status listing
- `GET /agents/search` for filtered discovery by org, capabilities, trust score, and limit

Typical search example:

```text
GET /agents/search?org=demo&capabilities=chat,search&minTrustScore=0.5&limit=20
```

Detailed lookup:

```text
GET /agents/:beamId
```

## `GET /stats`

Operational stats are currently exposed primarily through `GET /health`, with richer admin views for trust and recent intent activity.

Typical health response:

```json
{
  "status": "ok",
  "protocol": "beam/1",
  "connectedAgents": 12,
  "timestamp": "2026-03-08T12:00:00.000Z"
}
```

If you publish a friendlier `/stats` endpoint in front of the directory, it should usually aggregate health, connection count, and relay metrics.

## Admin auth

Admin and operator access is session-based.

- `POST /admin/auth/magic-link`
- `POST /admin/auth/verify`
- `GET /admin/auth/session`
- `POST /admin/auth/logout`

Successful verification returns a short-lived signed bearer token and also sets the admin session cookie for dashboard clients.

## Key lifecycle endpoints

```text
GET  /agents/:beamId/keys
POST /agents/:beamId/keys/rotate
POST /agents/:beamId/keys/revoke
GET  /keys/revoked
```

Rotation accepts either:

- `x-api-key` / bearer API key auth
- a signed key-management payload from the current active key

Revocation is intended for rotated-out historical keys. The active key must be replaced through rotation first.

## Public Beam Shield policy

Operators can inspect and update public HTTP abuse controls with:

```text
GET   /shield/policies/public-endpoints
PATCH /shield/policies/public-endpoints
```

The policy covers registration, discovery, DID resolution, `POST /intents/send`, admin auth, and key mutation limits, plus trusted IP / trusted Beam ID overrides.

## `DELETE /admin/waitlist`

Clears waitlist entries from the admin surface.

- Requires an authenticated admin session.
- Accepts `Authorization: Bearer <admin-session-token>` for API clients or the dashboard session cookie.
- Returns `{ deleted: <count> }` on success.

## WebSocket ` /ws `

The real-time transport endpoint is `/ws`.

Connect with a registered Beam-ID in the query string:

```text
wss://api.beam.directory/ws?beamId=assistant@demo.beam.directory
```

You can also authenticate the socket with an API key instead of relying on per-message Ed25519 signatures:

```text
wss://api.beam.directory/ws?beamId=assistant@demo.beam.directory&apiKey=bk_...your-key...
```

Common message types:

- `connected` when the socket is accepted
- `intent` when a remote agent sends a request
- `result` when a recipient replies
- `error` when validation or delivery fails
