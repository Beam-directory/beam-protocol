# Hosted Quickstart

This guide boots a usable local Beam stack with Docker Compose in about 15 minutes:

- Beam Directory on `http://localhost:3100`
- Beam Dashboard on `http://localhost:5173`
- Beam Message Bus on `http://localhost:8420`
- Echo Agent on `http://localhost:8788`

It is the fastest way to validate admin login, agent registration, discovery, and a real `conversation.message` exchange before shipping `0.6.0`.

## Prerequisites

- Docker Desktop or Docker Engine with Compose
- Node.js `20.19+`
- npm `10+`

## 1. Clone And Install

```bash
git clone https://github.com/Beam-directory/beam-protocol.git
cd beam-protocol
npm ci
npm run build
```

`npm run build` prepares the local CLI and SDK used by the smoke path.

## 2. Copy The Quickstart Env

```bash
cp ops/quickstart/.env.example ops/quickstart/.env
```

Default local values:

- `BEAM_ADMIN_EMAILS=ops@beam.local`
- `BEAM_BUS_API_KEY=beam-local-bus-key`
- `ECHO_AGENT_SECRET=beam-local-echo-secret`

Change them if you want different local credentials or ports.

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
curl http://localhost:3100/health
curl http://localhost:8420/health
curl http://localhost:8788/echo/health
open http://localhost:5173/login
```

Expected results:

- directory returns `{"status":"ok",...}`
- message bus returns `{"status":"ok","service":"beam-message-bus"}`
- echo agent returns `{"status":"ok",...}`
- dashboard shows the Beam login page

## 5. Run The 15-Minute Smoke Path

```bash
npm run quickstart:smoke
```

The smoke path verifies:

- local admin magic-link issue and session creation
- dashboard callback URL generation
- CLI identity creation
- agent registration
- lookup-based discovery of `echo@beam.directory`
- `beam talk` round-trip to the echo agent
- message-bus stats reachability

## 6. Manual Operator Flow

Request a local dev magic link:

```bash
curl -X POST http://localhost:3100/admin/auth/magic-link \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:5173" \
  -d '{"email":"ops@beam.local"}'
```

On localhost without SMTP or Resend, the response includes:

- `token`
- `url`
- `role`

Open the returned `url` in the browser or exchange the token directly:

```bash
curl -X POST http://localhost:3100/admin/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"token":"paste-token-here"}'
```

Create a sender agent and talk to the echo agent:

```bash
mkdir -p /tmp/beam-quickstart
cd /tmp/beam-quickstart
npx --no-install beam init --agent demo --org quickstart --directory http://localhost:3100 --force
npx --no-install beam register --display-name "Quickstart Demo" --capabilities "conversation.message" --directory http://localhost:3100
npx --no-install beam lookup echo@beam.directory --directory http://localhost:3100
npx --no-install beam talk echo@beam.directory "Hello from the hosted quickstart" --directory http://localhost:3100
```

If you want Dead Letter operations in the dashboard, open `Settings` and paste:

- Bus URL: `http://localhost:8420`
- Bus API key: the `BEAM_BUS_API_KEY` value from `ops/quickstart/.env`

For the full operator workflow after login, including alert investigation, exports, and prune safeguards, continue with the [Operator Observability](/guide/operator-observability) guide.

## 7. Tear Down

```bash
docker compose \
  -f ops/quickstart/compose.yaml \
  --env-file ops/quickstart/.env \
  down -v --remove-orphans
```

## Troubleshooting

- If `quickstart:smoke` fails before the CLI step, verify `npm run build` completed locally.
- If the dashboard loads but login fails, make sure `BEAM_ADMIN_EMAILS` in `ops/quickstart/.env` matches the email you request.
- If the echo agent stays unhealthy, rebuild after changing `ECHO_AGENT_SECRET` so the directory and agent use the same secret.
- If Docker reused stale images, rerun with `docker compose ... up -d --build --force-recreate`.
