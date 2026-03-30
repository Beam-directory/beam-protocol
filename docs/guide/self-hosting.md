# Self-Hosting

Beam's directory service is small enough to deploy in a few different ways, depending on how much control you want.

If you want the fastest end-to-end local stack with directory, dashboard, message bus, and the seeded Acme/Northwind demo agents, start with the [Hosted Quickstart](/guide/hosted-quickstart).

## Docker

The repository includes a `packages/directory/Dockerfile` for containerized deployments.

Typical flow:

```bash
npm run build --workspace=packages/directory
docker build -f packages/directory/Dockerfile -t beam-directory packages/directory
docker run -p 3100:3100 -e PORT=3100 -e DB_PATH=/data/beam-directory.db beam-directory
```

Recommended container settings:

- mount persistent storage for the SQLite database
- terminate TLS at a proxy or load balancer
- set `PORT` and `DB_PATH` explicitly
- monitor `/health` and WebSocket connection counts

## Fly.io

The repo also includes `packages/directory/fly.toml`, which is a good starting point for Fly.io.

Typical flow:

```bash
fly launch --copy-config --name beam-protocol
fly volumes create beam_data --size 1 --region fra
fly deploy
```

For Fly deployments, make sure you:

- persist `/data` for the SQLite file
- keep `force_https = true`
- expose port `3100`
- configure `BEAM_ADMIN_EMAILS`, `BEAM_DASHBOARD_URL`, and your proxy headers upstream
- wire SMTP or Resend for admin magic-link delivery

## Bare metal

For a VM or dedicated host:

```bash
npm run build --workspace=packages/directory
PORT=3100 DB_PATH=/var/lib/beam/beam-directory.db node packages/directory/dist/index.js
```

Recommended production setup:

- Node.js 18+ or newer
- systemd or another process supervisor
- reverse proxy with TLS termination
- regular database backups
- firewall rules for HTTP and WebSocket ingress

## Operational checklist

- Store private keys only on the agents that own them.
- Bootstrap operator access with `BEAM_ADMIN_EMAILS` and short-lived admin sessions.
- Configure `SMTP_*` or `RESEND_API_KEY` so production can deliver admin magic links.
- Back up the directory database.
- Rotate keys and ACLs when agent ownership changes.
- Watch connection health, relay latency, and rate-limit events.
