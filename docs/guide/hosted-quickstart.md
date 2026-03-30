# Hosted Quickstart

This guide boots the exact local hosted-demo stack used for Beam's canonical Acme to Northwind partner handoff in about 15 minutes:

- Beam Directory on `http://localhost:43100`
- Beam Dashboard on `http://localhost:43173`
- Beam Message Bus on `http://localhost:43220`
- Hosted Demo Agents on `http://localhost:43290`

It is the fastest way to validate admin login, seeded demo identities, the canonical `quote.request` handoff, and the async finance preflight fan-out before shipping Beam changes.

## Prerequisites

- Docker Desktop or Docker Engine with Compose
- Node.js `20.19+`
- npm `10+`

## 1. Clone The Repo

```bash
git clone https://github.com/Beam-directory/beam-protocol.git
cd beam-protocol
```

For the hosted demo path, Docker builds the required images itself. You only need `npm ci` and `npm run build` if you plan to work on the local workspaces or run the standalone cross-stack tests.

## 2. Copy The Quickstart Env

```bash
cp ops/quickstart/.env.example ops/quickstart/.env
```

Default local values:

- `BEAM_ADMIN_EMAILS=ops@beam.local`
- `BEAM_BUS_API_KEY=beam-local-bus-key`
- `DIRECTORY_PORT=43100`
- `DASHBOARD_PORT=43173`
- `MESSAGE_BUS_PORT=43220`
- `DEMO_AGENT_PORT=43290`

The quickstart defaults use higher localhost ports to avoid common collisions with existing dev servers. Change them if you want different local credentials or ports.

## 3. Start The Stack

```bash
docker compose \
  -f ops/quickstart/compose.yaml \
  --env-file ops/quickstart/.env \
  up -d --build
```

The stack builds Linux-native images for every service, so it works cleanly on macOS and Linux without depending on host-native `better-sqlite3` binaries.

## 4. Check Health

```bash
curl http://localhost:43100/health
curl http://localhost:43220/health
curl http://localhost:43290/health
open http://localhost:43173/login
```

Expected results:

- directory returns `{"status":"ok",...}`
- message bus returns `{"status":"ok","service":"beam-message-bus"}`
- hosted demo agents return `{"status":"ok",...}`
- dashboard shows the Beam login page

## 5. Run The 15-Minute Smoke Path

```bash
npm run quickstart:smoke
```

The smoke path verifies:

- local admin magic-link issue and session creation
- seeded Acme and Northwind demo identities
- the canonical `quote.request -> inventory.check -> purchase.preflight` flow
- quote trace reachability through the admin observability API
- async acknowledgement semantics for the finance preflight
- message-bus stats reachability

## 6. Reseed The Demo Identities

The hosted demo uses committed demo-only identities under [`ops/quickstart/demo-identities.json`](https://github.com/Beam-directory/beam-protocol/blob/main/ops/quickstart/demo-identities.json). They are safe for local demo use only and must not be reused in production.

To reapply registrations and ACLs without touching SQLite directly:

```bash
npm run demo:seed
```

This ensures the same four demo agents are present:

- `procurement@acme.beam.directory`
- `partner-desk@northwind.beam.directory`
- `warehouse@northwind.beam.directory`
- `finance@acme.beam.directory`

## 7. Run The Canonical Hosted Handoff

```bash
npm run demo:run
```

Expected outcome:

- quote total `44160`
- supplier `partner-desk@northwind.beam.directory`
- finance preflight bus status `delivered`
- finance acknowledgement payload `accepted`

`delivered` on the async finance notification is intentional: the bus accepted delivery, but the transport does not mark terminal `acked` unless a polled consumer later calls `POST /v1/beam/ack`.

That status comes from the message bus response itself. The downstream finance intent can still continue to `acked` inside the directory trace if the connected consumer responds immediately, so use the dashboard trace as the source of truth for terminal lifecycle.

## 8. Manual Operator Flow

Request a local dev magic link:

```bash
curl -X POST http://localhost:43100/admin/auth/magic-link \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:43173" \
  -d '{"email":"ops@beam.local"}'
```

On localhost without SMTP or Resend, the response includes:

- `token`
- `url`
- `role`

Open the returned `url` in the browser or exchange the token directly:

```bash
curl -X POST http://localhost:43100/admin/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"token":"paste-token-here"}'
```

After login, run the demo and inspect the resulting nonce:

```bash
npm run demo:run
```

Then use the dashboard in this order:

- `Intents` → open the returned quote nonce
- `Audit` → confirm the matching control-plane events
- `Dead Letters` → verify the queue is empty for the clean path
- `Alerts` → inspect heuristics and export options

If you want Dead Letter operations in the dashboard, open `Settings` and paste:

- Bus URL: `http://localhost:43220`
- Bus API key: the `BEAM_BUS_API_KEY` value from `ops/quickstart/.env`

For the full operator workflow after login, continue with [Operator Observability](/guide/operator-observability) and the [Operator Runbook](/guide/operator-runbook).

## 9. Tear Down

```bash
docker compose \
  -f ops/quickstart/compose.yaml \
  --env-file ops/quickstart/.env \
  down -v --remove-orphans
```

## Troubleshooting

- If `quickstart:smoke` fails before the demo run, inspect `docker compose logs demo-agents directory message-bus`.
- If the dashboard loads but login fails, make sure `BEAM_ADMIN_EMAILS` in `ops/quickstart/.env` matches the email you request.
- If the demo agents stay unhealthy, inspect `docker compose logs demo-agents` and confirm `ops/quickstart/demo-identities.json` is present in the repo checkout.
- If the finance preflight never reaches `delivered`, confirm `BEAM_BUS_API_KEY` is present and the message bus can read `IDENTITY_PATH=/app/demo-identities.json`.
- If Docker reused stale images, rerun with `docker compose ... up -d --build --force-recreate`.
