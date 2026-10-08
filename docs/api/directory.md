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

## Organization namespace onboarding

Organization namespaces are claimed before an organization Beam ID can be issued:

```http
POST /orgs
Content-Type: application/json

{
  "name": "acme",
  "displayName": "Acme GmbH",
  "domain": "acme.com"
}
```

`domain` is required. Beam canonicalizes it to the registrable domain (`www.coppen.de` and `https://coppen.de/impressum` both become `coppen.de`). The organization identity is that full domain, so `coppen.de` and `coppen.at` are different organizations and cannot share a row.

The Beam namespace (`name`) is still the label used in existing addresses such as `agent@coppen.beam.directory`. A claim must ask for either the registrable label (`coppen`) or the collision-free form that joins the label and public suffix with `--` (`coppen--de`, `coppen--co-uk`). `coppen.co.uk` and `coppen-co.uk` therefore claim `coppen--co-uk` and `coppen-co--uk`. Until domain verification succeeds, the row is stored under that `--` name so an unverified `coppen.com` cannot occupy `coppen`. Verification grants the requested label when it is still free; otherwise the organization keeps the `--` name. A name that matches neither form returns `403 ORG_NAMESPACE_DOMAIN_MISMATCH`. The `201` body includes `name` (the name to use until verification) and `requestedName`. Store both the API key and `name` from that body. `name` can be `coppen--de` while the request asked for `coppen`.

The `201` response is `Cache-Control: no-store` and returns the organization API key exactly once, together with `verification.txtName`, `verification.txtValue`, `verification.wellKnownUrl`, `verification.wellKnownBody`, and `claimExpiresAt`. An unverified claim expires after 72 hours. Store the key outside source control, publish one of the two proofs, then call:

```http
POST /orgs/acme/verify
x-api-key: beam_org_...
Content-Type: application/json

{ "method": "dns" }
```

`method` is `dns` (the default when the body is omitted) or `well-known`. DNS checks `_beam-verification.<domain>` for `beam-verification=<token>`. The well-known check fetches `https://<domain>/.well-known/beam-verification` over HTTPS, refuses redirects, and refuses hosts that resolve to a private or loopback address. The file must contain the same `beam-verification=<token>` line. A match sets `verified` and `domainVerifiedVia` once for the organization. It does not verify individual agents.

Until verification succeeds, organization agent issuance, registry submission, and organization workspace creation return `403 ORG_VERIFICATION_REQUIRED`. Organization claim, verification, and issuance endpoints share the public registration rate limit.

### Registry filing

After the domain is verified, submit one Handelsregister or LEI filing for the organization. This does not call a registry API and does not approve the filing.

```http
POST /orgs/coppen/registry
x-api-key: beam_org_...

{
  "kind": "handelsregister",
  "country": "DE",
  "registrationNumber": "HRB 68658",
  "registerCourt": "Amtsgericht Ludwigshafen",
  "legalName": "COPPEN GmbH",
  "applicantName": "Tobias Kub",
  "applicantRole": "geschaeftsfuehrer"
}
```

`kind` is `handelsregister` (DE, `HRB` or `HRA`, plus `registerCourt`) or `lei` (20-character LEI with a valid checksum). `applicantRole` is `geschaeftsfuehrer`, `vorstand`, `prokurist`, `inhaber`, `director`, or `authorized_signatory`. The response status is `pending`.

An operator reviews the representation claim:

```http
POST /admin/orgs/coppen/registry/1/review
Authorization: Bearer <operator-session>

{ "decision": "approved", "note": "Register excerpt names the applicant as Geschäftsführer." }
```

`decision` is `approved` or `rejected`. The note is stored with the reviewer and timestamp, and both submission and review are written to the audit log. A second review returns `409 REGISTRY_ALREADY_REVIEWED`.

`GET /orgs/:name/registry` lists filings for the organization API key.

### People, invitations, and KYC

People belong to one organization. The organization API key creates the account holder directly, or invites an employee. Private keys stay on the client. `publicKey` is an Ed25519 SPKI key.

```http
POST /orgs/coppen/people
x-api-key: beam_org_...

{
  "email": "clara@coppen.de",
  "displayName": "Clara Sommer",
  "role": "Vertrieb",
  "publicKey": "<ed25519-spki>",
  "supervisorPersonId": null,
  "rights": {
    "actions": ["read", "schedule.commit", "order"],
    "order": { "maxAmount": "5000.00", "currency": "EUR" }
  }
}
```

`rights.actions` is a subset of `read`, `schedule.commit`, `file.send`, and `order`. An `order` limit requires the `order` action. A supervisor must be an active person in the same organization, and the chain cannot cycle.

```http
POST /orgs/coppen/people/invitations
POST /people/invitations/accept
```

The invitation response returns `token` once. Accept sends `token`, `displayName`, and `publicKey`. The person inherits the invited role, supervisor, and rights. KYC starts at `unverified`.

```http
POST /orgs/coppen/people/:id/kyc
{ "provider": "manual" }
```

The only adapter is `manual`. It records `pending` and a reference. It does not contact a vendor and it does not mark anyone verified. An operator sets the status:

```http
POST /admin/people/:id/kyc
Authorization: Bearer <operator-session>

{ "status": "verified", "note": "Identity checked outside the directory." }
```

`status` is `verified` or `rejected`. The note is stored in the audit log.

```http
POST /orgs/coppen/people/import
{ "source": "personio", "people": [ { "externalId": "p-1", "email": "a@coppen.de", "displayName": "A", "role": "Einkauf", "supervisorExternalId": "p-2", "status": "active" } ] }
```

`source` is `personio` or `entra`. The directory stores the snapshot. It does not call Personio or Microsoft Graph. A row matches an existing person by `externalId` or, if that id is new, by email, and then updates role, rights, and supervisor. A supervisor must already be an active person in the same organization, including people earlier in the same snapshot. `status: "offboarded"` locks that person immediately and sets `suspended_at` on every agent whose `responsiblePersonId` is that person. An offboarded person is not reactivated by a later `active` row. A supervisor cycle, an inactive supervisor, or two identities claiming one email rolls the import back.

```http
PATCH /orgs/coppen/people/:id
{ "publicKey": "<ed25519-spki>", "rights": { "actions": ["read"] } }
```

The organization API key can replace the public key or the rights of an active person. A different public key returns KYC to `pending`, clears the previous provider reference, and revokes that person's active mandates. Offboarded people return `409 PERSON_OFFBOARDED`.

```http
POST /orgs/coppen/people/:id/offboard
```

Offboarding is immediate and idempotent. New organization agents accept `responsiblePersonId`. The responsible person's signature can rotate that agent's signing key while the person is active. After offboarding, that signature no longer authorizes a key change, every agent they own is suspended, and every active mandate they signed is revoked. Delegations where those agents are grantor or grantee are revoked too. Shrinking `rights` revokes mandates that no longer fit inside them. A suspended agent, or an agent whose responsible person is not active, cannot open a network connection, accept a websocket, or send through a delegation.

```http
PUT /orgs/coppen/agents/buyer/responsible-person
{ "responsiblePersonId": "<person id>" }
```

Replacing the responsible person revokes that agent's active mandates and its delegations.

### Organization agents

`POST /orgs/:name/agents` requires `publicKey`, a client-generated Ed25519 SPKI key, and may set `responsiblePersonId`. The directory does not generate or return a private key. Omitting the public key returns `400 PUBLIC_KEY_REQUIRED`.

### Mandates

A mandate is signed by the agent's responsible person. The signed object is canonical JSON (sorted keys) of:

```json
{
  "type": "mandate",
  "jti": "8-80 url-safe characters",
  "version": 1,
  "personId": "<responsible person id>",
  "agentBeamId": "agent@coppen.beam.directory",
  "org": "coppen",
  "scopes": { "actions": ["read", "order"], "order": { "maxAmount": "100.00", "currency": "EUR" } },
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "escalationPersonId": null
}
```

`scopes` must be within the person's `rights`. `escalationPersonId` must be that person's supervisor, or `null` when they have none. `expiresAt` is at most 366 days ahead. The person must have `kycStatus: "verified"` and the organization domain must be verified. Otherwise the route returns `400 KYC_REQUIRED` or `400 ORG_VERIFICATION_REQUIRED`.

```http
POST /agents/agent@coppen.beam.directory/mandates
{ "jti": "...", "scopes": {}, "expiresAt": "...", "escalationPersonId": null, "signature": "<person signature>" }
```

Scopes wider than the person's rights return `400 MANDATE_EXCEEDS_RIGHTS`. Replaying the same signed payload, including after revoke or offboarding, returns `409 MANDATE_REPLAY` and does not insert a row.

```http
POST /agents/agent@coppen.beam.directory/mandates/:jti/revoke
{ "signature": "<signature over {type:'mandate-revoke', jti, personId}>" }
```

The same payload can be signed by the person or by their active supervisor. The organization API key can revoke without a signature. The audit actor records which of the three authorized it.

Delegations keep the previous signed payload. A client may add `nonce` (8–128 url-safe characters) inside that signed object. After revoke, the same signed payload, or the same grantor, grantee, scope, and expiry, returns `409 DELEGATION_REPLAY`.

### Trust assertion and acceptance

```http
GET /agents/agent@coppen.beam.directory/trust-assertion
```

The directory signs `{v, beamId, org, person, mandate, suspended, issuedAt, expiresAt}` with the stable issuer key. `person.ref` and `mandate.escalationPersonRef` are SHA-256 hex of the person id, not the id itself. `suspended` is true when the agent is suspended or the responsible person is offboarded. The response adds `signature` and `publicKey`. The assertion expires after 15 minutes. A public agent can be read by anyone. An unlisted agent returns `404` without a credential, `403` for an authenticated non-contact, and `200` for the agent, an accepted contact, or the organization key. Without `BEAM_DIRECTORY_SIGNING_PRIVATE_KEY` and `BEAM_DIRECTORY_SIGNING_PUBLIC_KEY` the route returns `503 ISSUER_KEY_REQUIRED`. This read shares the public agent-lookup limit (`lookupPerMinute`, default 120). A 429 response is `RATE_LIMITED` with `Retry-After: 60`. Verify the signature against the pinned directory key. `publicKey` in the body is not part of the signed payload. Intent delivery still proceeds and carries `trustAssertion: null` beside the frame. A configured issuer adds the assertion beside the frame and on direct HTTP delivery; the signed intent frame itself is unchanged. A result signature is also stored on `intent_log.result_signature`.

```http
PUT /agents/agent@coppen.beam.directory/acceptance
x-api-key: beam_org_...

{
  "allowedOrgDomains": ["coppen.de"],
  "allowedScopes": ["read"],
  "allowedAgents": [],
  "requireKnownContact": false,
  "version": 1,
  "timestamp": "2026-10-08T12:00:00.000Z",
  "nonce": "0123456789abcdef"
}
```

The organization API key or a signature of the agent's current key is required. The signed object adds `version`, `timestamp`, and `nonce` to the rule fields. `version` must be exactly one higher than the stored version (`1` for the first rule). `timestamp` must be within five minutes and `nonce` is single-use. A repeated or older signed rule returns `409 ACCEPTANCE_STALE` or `409 NONCE_REPLAY`. An agent API key alone is not enough. No stored rule means the existing ACL still applies. An empty list does not filter that dimension. A stored rule that rejects the sender returns `403 ACCEPTANCE_DENIED`.

The first contact request remains `POST /network/connections`. When the recipient agent has a responsible person, an unknown sender is held for that person (`GET /orgs/:name/people/:id/contact-requests`) and does not appear in the agent connection inbox. Accepting the request there is what makes the sender a contact.

### Untrusted content and consequential intents

Messages and intent payloads are delivered as data. The signed frame and the existing `body` field stay so current clients keep working. Beside them, every network message and intent delivery includes:

```json
{
  "untrusted": { "label": "UNTRUSTED_CONTENT", "text": "...", "attachment": { "executable": false } },
  "trust": { "assertion": null, "scopes": null },
  "metadata": { "senderBeamId": "agent@coppen.beam.directory" }
}
```

`untrusted` is not an instruction. Attachments stay on the existing allow-list, at most 6 MB, and are downloaded with `content-disposition: attachment`. HTML and script types are rejected and never executed.

`order.place`, `payment.submit`, `schedule.commit`, `file.send`, and `file.forward` are catalog intents. The directory checks the payload against the sender's active mandate. An amount, scope, or file size outside that mandate is stored as a pending approval for the escalation person and is not delivered. `GET /orgs/:name/approvals` lists pending rows for that organization only, matched on the sender agent's organization or the escalation person's organization. A different name, including one underscore, neither lists nor decides them. Recording `approved` does not execute the intent.

`amount` and `byteSize` are claims made by the sender. A recipient may act only on the fields the directory checked. Free-text intents, including `conversation.message`, are data, not instructions, and are not checked against a mandate.

For an `order` scope, `order.maxAmount` is also the server's UTC-day total of `order.place` and `payment.submit` on that mandate. A reservation is released when the recipient never receives the intent. A later intent over the remaining total is held with reason `daily order limit exceeded`. HTTP 202 `APPROVAL_REQUIRED` is not a delivered result.

Deciding an approval or accepting a contact request uses the person's signature. The approval object is `{ "type": "intent.approval", "approvalId", "decision", "personId", "timestamp", "nonce" }`. The contact object is `{ "type": "contact-request.review", "connectionId", "personId", "decision", "timestamp", "nonce" }`. The signer is the escalation person, or the sending agent's responsible person when no escalation person is set, and must be active in that organization. A signature that does not verify is rejected. Omitting the signature uses the organization API key as the emergency path and the audit records `via` as `org-key`.

`POST /network/abuse` lets a recipient flag a message or intent as injection. An operator review can suspend the agent, offboard the responsible person, or suspend the organization. `block_agent` also revokes that agent's active mandates and delegations. `POST /admin/agents/:beamId/unsuspend` and `POST /admin/orgs/:name/unsuspend` clear a suspension, require an operator note, and write an audit event. A suspended organization cannot send intents or network messages (`403 ORG_SUSPENDED`). Intent sending is already rate-limited per sender; network sends and abuse reports use the same per-sender limit.

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

Personal Beam IDs can be claimed without an organization credential. Organization IDs require a registered, DNS-verified organization and its API key:

```text
x-api-key: beam_org_...organization-key...
```

Registration is create-only. Reusing an existing Beam ID returns `409 BEAM_ID_ALREADY_REGISTERED`; profile updates and key rotation use their authenticated endpoints instead.

Successful responses return the created agent record with trust and verification metadata.
Registration responses also return an API key with the prefix `bk_`. Store it securely — it is only meant to
be shown in plaintext at creation time. Successful registration responses are marked `Cache-Control: no-store`.

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

Public discovery and authenticated management are separate.

- `GET /agents/search` and `GET /agents/browse` return only `visibility=public` agents. They never include `email`, `email_token`, or `api_key_hash`. Unlisted and private agents are omitted even when the caller sends an admin session.
- `GET /directory/agents` is the public connected-status listing and also stays on `visibility=public` unless an admin session asks for `includeUnlisted=true`.
- `GET /agents/managed` is the authenticated inventory. It requires a directory admin session, an organization API key, an agent API key, or a session whose email matches a verified agent address. Admins receive every agent. An organization key receives that org's agents. An agent key receives that one agent. A matching verified email receives those owned agents. The response includes unlisted and private agents and may include `email` for that caller. Anonymous callers get `401`. Authenticated callers with no matching scope get `403`.
- `GET /agents/:beamId` returns a public agent to anyone. Unlisted and private agents are `404` unless the caller has the same scope as `GET /agents/managed`: a directory admin, that organization's API key, that agent's API key, or a session whose email matches the agent's verified address. `email` is included only for a directory admin or the matching agent API key.
- `GET /agents/:beamId/domain-status` omits the DNS challenge token unless that same owner or admin scope is present. Anonymous callers do not receive `dnsRecord.value`.

Typical public search:

```text
GET /agents/search?org=demo&capabilities=chat,search&minTrustScore=0.5&limit=20
```

Authenticated inventory:

```text
GET /agents/managed?limit=250
Authorization: Bearer <admin-session>
```

## Credential issuance and verification

`POST /agents/email`, `POST /agents/domain`, and `POST /agents/business` mint a `verified: true` credential only when the caller is a directory admin or the agent API key holder, and only when that email, domain, or business check is already current. Anonymous requests are rejected and do not return a credential.

`POST /agents/verify` accepts `{ "vc": ... }` and returns:

```json
{ "valid": true, "signatureValid": true, "current": true }
```

`valid` is true only when the directory issuer key signed the credential and the underlying check is still current. A self-signed proof returns `signatureValid: false` and `errorCode: "INVALID_SIGNATURE"`. A directory signature whose check has been removed returns `signatureValid: true`, `current: false`, and `errorCode: "VERIFICATION_NOT_CURRENT"`.

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
  "version": "1.4.0",
  "gitSha": "abcdef1234567890abcdef1234567890abcdef12",
  "deployedAt": "2026-04-01T19:00:00.000Z",
  "release": {
    "version": "1.4.0",
    "gitSha": "abcdef1234567890abcdef1234567890abcdef12",
    "gitShaShort": "abcdef1",
    "deployedAt": "2026-04-01T19:00:00.000Z"
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

Successful verification always sets an HttpOnly session cookie. The dashboard requests cookie-only transport and never stores the bearer token in browser storage. CLI and automation clients receive the short-lived bearer token by default; they can request cookie-only transport with `{"sessionTransport":"cookie"}`.

New magic-link secrets are stored only as SHA-256 hashes. Unused legacy plaintext rows remain consumable during the migration window and are deleted by the normal used/expired cleanup.

## Workspace access and invitations

```text
GET    /admin/workspaces/:slug/access
GET    /admin/workspaces/:slug/members
PATCH  /admin/workspaces/:slug/members/:id
DELETE /admin/workspaces/:slug/members/:id

GET    /admin/workspaces/:slug/invitations
POST   /admin/workspaces/:slug/invitations
DELETE /admin/workspaces/:slug/invitations/:id

GET    /admin/workspaces/invitations/:token
POST   /admin/workspaces/invitations/:token/accept
```

Member and invitation administration requires the workspace `owner` role. Invitation preview is token-authenticated and deliberately redacted. Acceptance also requires an authenticated session for the exact invited email. Raw invitation secrets and token hashes are never returned by list endpoints.

## Key lifecycle endpoints

```text
GET  /agents/:beamId/keys
POST /agents/:beamId/keys/rotate
POST /agents/:beamId/keys/revoke
GET  /keys/revoked
```

Rotation and revocation accept either:

- a signature from the agent's current signing key (`signature` over the key-management payload, or the legacy `rotation_proof` over the new public key)
- the organization API key of the org that owns the agent

The agent API key (`bk_...`) is not enough. A request that presents only that key returns `400 INVALID_ROTATION_PROOF` or `400 INVALID_SIGNATURE`, and the signing key stays unchanged.

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

Agent sockets require the registered Beam-ID and a short-lived, single-use WebSocket ticket. Obtain
the ticket with `POST /agents/:beamId/ws-ticket` and the agent API key. The API key therefore stays
in the authenticated HTTPS request instead of appearing in a WebSocket URL. Transport authentication
and per-frame Ed25519 signatures serve different purposes; both remain required.

```text
wss://api.beam.directory/ws?beamId=assistant@demo.beam.directory&ticket=bwt_...single-use...
```

Non-browser clients may authenticate the WebSocket upgrade itself with
`Authorization: Bearer <api-key>` or `X-API-Key`, but tickets are the portable default. Query-string API keys are disabled
unless the explicit temporary migration flag `BEAM_ALLOW_LEGACY_WS_API_KEY_QUERY=true` is set.
Result Frames must be signed by the connected recipient's Ed25519 identity. The `feed=intents`
operator feed requires an authenticated directory admin session and is not a public status feed.

Common message types:

- `connected` when the socket is accepted
- `intent` when a remote agent sends a request
- `result` when a recipient replies
- `error` when validation or delivery fails
