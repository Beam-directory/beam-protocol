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
  "timestamp": "2026-03-08T12:00:00.000Z",
  "version": "0.9.0",
  "gitSha": "abcdef1234567890abcdef1234567890abcdef12",
  "deployedAt": "2026-03-30T19:00:00.000Z",
  "release": {
    "version": "0.9.0",
    "gitSha": "abcdef1234567890abcdef1234567890abcdef12",
    "gitShaShort": "abcdef1",
    "deployedAt": "2026-03-30T19:00:00.000Z"
  }
}
```

If you publish a friendlier `/stats` endpoint in front of the directory, it should usually aggregate health, connection count, and relay metrics.
The current built-in `/stats` endpoint now exposes the same release metadata, so `health` and `stats` can be compared for deploy-truth drift.

## `GET /release`

For a small operator-facing release-truth check, the directory also exposes:

```text
GET /release
```

It returns the current protocol family plus the live release metadata (`version`, `gitSha`, `gitShaShort`, `deployedAt`).

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

## Hosted beta intake

Public hosted beta intake stays on the compatibility-safe `POST /waitlist` path.

Example request:

```json
{
  "email": "ops@northwind.systems",
  "source": "hosted-beta-page",
  "company": "Northwind Systems",
  "agentCount": 6,
  "workflowType": "hosted-beta-partner-handoff",
  "workflowSummary": "Procurement asks partner operations for stock, then finance approves the async quote."
}
```

Successful responses return:

- `status`: `registered` or `already_registered`
- `request`: the canonical hosted beta request record
- `nextStep`: human-readable operator follow-up guidance

The canonical request payload now includes:

- `id`
- `email`
- `source`
- `company`
- `agentCount`
- `workflowType`
- `workflowSummary`
- `requestStatus`
- `stage`
- `owner`
- `operatorNotes`
- `nextAction`
- `lastContactAt`
- `stale`
- `staleReason`
- `attentionFlags`
- `notificationId`
- `notificationStatus`
- `createdAt`
- `updatedAt`

Stable request statuses are:

- `new`
- `reviewing`
- `contacted`
- `scheduled`
- `active`
- `closed`

## Admin hosted beta workflow

Operators can work the hosted beta queue through:

```text
GET   /admin/beta-requests
GET   /admin/beta-requests/:id
PATCH /admin/beta-requests/:id
GET   /admin/beta-requests/export?format=json|csv
```

List filtering currently supports:

- `q`
- `status`
- `owner`
- `source`
- `workflowType`
- `attention` (`unowned` or `stale`)
- `sort` (`attention`, `updated_desc`, `created_desc`, `stage`, `owner`, `last_contact_desc`)
- `limit`

`PATCH /admin/beta-requests/:id` accepts:

```json
{
  "status": "reviewing",
  "owner": "operator@beam.directory",
  "operatorNotes": "Intro email sent, follow-up call pending.",
  "nextAction": "Prepare a 30 minute buyer walkthrough.",
  "lastContactAt": "2026-03-31T09:30:00.000Z",
  "proofIntentNonce": "pilot-proof-123456"
}
```

The response request record carries the same pipeline fields plus notification state and an optional `proofIntentNonce`, so operators can tell whether a request is still `new`, already `acknowledged`, or fully `acted` on.

`GET /admin/beta-requests/:id` also returns:

- `activity`: the operator and follow-up timeline
- `proofSummary`: a buyer-friendly artifact generated from the linked `proofIntentNonce`, including identity proof, delivery proof, operator visibility, and a recommended next step

Hosted beta export includes:

- `next_action`
- `last_contact_at`
- `notification_status`
- `stale`
- `attention_flags`

## Operator notifications

Operator-visible intake and incident signals are exposed through:

```text
GET   /admin/operator-notifications
PATCH /admin/operator-notifications/:id
```

`GET /admin/operator-notifications` supports:

- `q`
- `status` (`new`, `acknowledged`, `acted`)
- `source` (`beta_request`, `critical_alert`)
- `limit`
- `hours` to control the critical-alert window that is synced before listing

Example patch:

```json
{
  "status": "acknowledged",
  "owner": "ops@beam.directory",
  "nextAction": "Open the latest failing trace, confirm the downstream condition, then update the runbook ticket."
}
```

Notification payloads now include:

- `owner`
- `nextAction`

Critical alerts from observability reuse the same notification path. The `notificationStatus`, `notificationId`, `notificationOwner`, and `notificationNextAction` fields also appear on critical alert payloads from `GET /observability/overview` and `GET /observability/alerts`.

## First-party funnel analytics

The public Beam surfaces send privacy-conscious, first-party funnel events through:

```text
POST /analytics/events
GET  /admin/funnel?days=30
```

Accepted public event categories are:

- `page_view`
- `cta_click`
- `request`
- `demo_milestone`

Example ingest payload:

```json
{
  "sessionId": "9f0f6f4f0f2f4c2da55f2f2d9f9b1e44",
  "pageKey": "landing",
  "eventCategory": "cta_click",
  "ctaKey": "landing_guided_eval_hero",
  "targetPage": "guided_evaluation"
}
```

Request events use the same path, but require a compatible `workflowType`. Demo milestones require a compatible `milestoneKey`.

`GET /admin/funnel` returns:

- milestone progression across landing, guided evaluation, hosted beta, request, and demo proof
- partner motion metrics across hosted beta request, qualified, scheduled, pilot-complete, and next-step readiness
- stage aging, overdue follow-up counts, and a current stall list for weekly operator review
- entry pages
- CTA click summaries
- request workflow breakdown
- recent anonymous events for instrumentation validation

All hosted beta admin endpoints require an authenticated admin session and accept either:

- `Authorization: Bearer <admin-session-token>`
- the dashboard admin session cookie

## `DELETE /admin/waitlist`

Clears waitlist and hosted beta intake entries from the legacy admin surface.

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
