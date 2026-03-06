# Beam Protocol v0.3 — Security Hardening

## Context
Beam v0.2 is live with 4 agents, 7 intents, working WebSocket relay. But it has NO security against malicious agents. Before we go public (X post, external users), we need these 5 security features.

## Current State
- Ed25519 identity keys exist per agent (in `secrets/beam-identities.json`)
- Nonce table exists in SQLite but isn't used for replay protection
- No signature verification on intents
- No ACLs — any agent can send any intent to any agent
- No rate limiting
- No payload schema validation

## Tasks (in priority order)

### 1. Intent Signature Verification (CRITICAL)
**Where:** `packages/sdk-typescript/src/frames.ts` + `packages/directory/src/websocket.ts`

Every intent frame must be signed by the sender's Ed25519 private key. The directory server verifies the signature against the registered public key before relaying.

- In `frames.ts`: Add `signFrame(frame, privateKey)` that creates an Ed25519 signature over `JSON.stringify({type, from, to, intent, payload, timestamp, nonce})` and adds it as `frame.signature`
- In `websocket.ts`: Before relaying any intent, verify the signature against the sender's registered `public_key` from the agents table. Reject with error if invalid.
- In `client.ts`: Auto-sign outgoing frames using the identity's private key

### 2. Intent ACL (Access Control Lists)
**Where:** `packages/directory/src/db.ts` + new file `packages/directory/src/acl.ts`

New SQLite table `intent_acls`:
```sql
CREATE TABLE IF NOT EXISTS intent_acls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_beam_id TEXT NOT NULL,    -- who receives
  intent_type TEXT NOT NULL,       -- e.g. 'payment.status_check'  
  allowed_from TEXT NOT NULL,      -- who may send (beam_id or '*' for any)
  created_at TEXT NOT NULL,
  FOREIGN KEY (target_beam_id) REFERENCES agents(beam_id),
  UNIQUE(target_beam_id, intent_type, allowed_from)
);
```

- Add REST endpoints: `POST /acl` (create), `GET /acl/:beamId` (list), `DELETE /acl/:id` (remove)
- In websocket relay: Before delivering, check if sender is allowed to send this intent type to this target. If no ACL entries exist for this target+intent, DEFAULT DENY.
- Seed with our current 4 agents' permissions from `intents/catalog.yaml`

### 3. Payload Schema Validation
**Where:** `packages/directory/src/` new file `validation.ts`

Each intent type has a JSON Schema. Validate payload before relaying.

- Load schemas from `intents/catalog.yaml` (the `payload` field definitions)
- Use a lightweight JSON Schema validator (e.g., `ajv` — add as dependency)
- In websocket relay: Validate payload against schema. Reject with descriptive error if invalid.
- Unknown intent types are REJECTED (must be in catalog)

### 4. Rate Limiting
**Where:** `packages/directory/src/` new file `rate-limit.ts`

Simple in-memory rate limiter per agent:
- Default: 60 intents/minute per sender
- Configurable via env var `BEAM_RATE_LIMIT_PER_MIN`
- Track in a Map<beamId, {count, windowStart}>
- Return HTTP 429 or WebSocket error when exceeded

### 5. Replay Protection (Nonce)
**Where:** Already partially built in `db.ts` — wire it up

- Each frame includes a unique `nonce` field
- Directory checks: nonce not seen before AND timestamp within 5 minutes of server time
- Store used nonces in the existing `nonces` table
- `cleanExpiredNonces()` already runs every 10 minutes — just wire up the check

## Testing
After implementing, update `scripts/beam-chain-test-v2.js` to:
1. Test valid signed intent → should succeed
2. Test tampered payload (wrong signature) → should be rejected
3. Test unauthorized sender (no ACL) → should be rejected
4. Test invalid payload schema → should be rejected
5. Test replay (same nonce twice) → second should fail

## Files to NOT touch
- `website/` — don't change the website
- `packages/dashboard/` — don't change the Convex dashboard
- Bridge scripts in `scripts/` — these will need updates but do them carefully

## Build & Test
```bash
cd packages/directory && npm run build
cd packages/sdk-typescript && npm run build
# Run tests
cd packages/sdk-typescript && npm test
```

## Dependencies to add
- `ajv` (JSON Schema validation) → `packages/directory/package.json`
- No new deps for SDK (Ed25519 already available via tweetnacl)
