# @beam-protocol/directory

Beam directory server for registration, discovery, routing, verification, DID resolution, and operational controls.

## Local Setup

```bash
npm install
npm run build
JWT_SECRET=local-dev-secret npm run start
```

Default local endpoints:

- API: `http://localhost:3100`
- health: `GET /health`
- agent registration: `POST /agents/register`
- intent relay: `POST /intents/send`
- WebSocket relay: `ws://localhost:3100/ws?beamId=<beam-id>`

## Core Capabilities

- agent registration with Ed25519 public keys
- Beam ID lookup and search
- WebSocket relay for request/response intents
- direct HTTP delivery when an agent advertises `httpEndpoint`
- DID document resolution and credential endpoints
- domain verification and business verification routes
- trust gate, payload limits, rate limiting, ACLs, and audit endpoints
- federation routes and directory admin/dashboard endpoints

## Configuration

### Required

- `JWT_SECRET` - required at startup

### Common

- `PORT` - server port, default `3100`
- `DB_PATH` - SQLite database path, default `./beam-directory.db`
- `BEAM_ADMIN_EMAILS` - comma-separated bootstrap admin emails
- `BEAM_OPERATOR_EMAILS` - comma-separated read-only operator emails
- `BEAM_VIEWER_EMAILS` - comma-separated read-only viewer emails
- `BEAM_DASHBOARD_URL` - dashboard origin used in admin magic links
- `BEAM_DIRECTORY_BASE_URL` - DID base URL override
- `PUBLIC_BASE_URL` - public origin used in verification links
- `BEAM_RATE_LIMIT_PER_MIN` - global per-agent rate limit override
- `ECHO_AGENT_SECRET` - protects registration of `echo@beam.directory`

### Verification and email

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `RESEND_API_KEY`
- `COMPANIES_HOUSE_API_KEY`

### Federation and signing

- `BEAM_DIRECTORY_URL`
- `BEAM_FEDERATION_SHARED_SECRET`
- `BEAM_PRIVATE_DIRECTORY_MODE`
- `BEAM_DIRECTORY_DID`
- `BEAM_DIRECTORY_SIGNING_PRIVATE_KEY`
- `BEAM_DIRECTORY_SIGNING_PUBLIC_KEY`

## Docker

The repo includes [`Dockerfile`](./Dockerfile):

```bash
cd packages/directory
npm install
npm run build
docker build -t beam-directory .
docker run --rm -p 3100:3100 \
  -e JWT_SECRET=local-dev-secret \
  -e BEAM_ADMIN_EMAILS=ops@example.com \
  -e BEAM_DASHBOARD_URL=http://localhost:5173 \
  -v "$PWD/data:/data" \
  beam-directory
```

If `LITESTREAM_REPLICA_BUCKET` is set, the container starts with Litestream replication enabled.

## Admin Auth

Directory operator access now uses authenticated admin sessions instead of a pasted static browser key.

Local development:

1. Set `BEAM_ADMIN_EMAILS=you@example.com`
2. Start the directory with `JWT_SECRET`
3. Request a magic link through `POST /admin/auth/magic-link`
4. On `localhost`, the API returns the dev callback URL directly if SMTP/Resend is not configured

Production:

- configure `BEAM_ADMIN_EMAILS` and optional operator/viewer email lists
- set `BEAM_DASHBOARD_URL` to the real dashboard origin
- configure `SMTP_*` or `RESEND_API_KEY` for magic-link delivery
- the dashboard and admin APIs use `/admin/auth/*` plus a short-lived signed session

For the full operator workflow, including alerts, traces, audit history, exports, and prune confirmation, see:

- [docs.beam.directory/guide/operator-observability](https://docs.beam.directory/guide/operator-observability)

## Fly.io

The repo includes [`fly.toml`](./fly.toml):

```bash
cd packages/directory
fly launch --copy-config --no-deploy
fly volumes create beam_data --size 1
fly secrets set JWT_SECRET=your-secret
fly deploy
```

## Reference

- Docs: [docs.beam.directory](https://docs.beam.directory)
- Directory API: [docs.beam.directory/api/directory](https://docs.beam.directory/api/directory)

## License

Apache-2.0
