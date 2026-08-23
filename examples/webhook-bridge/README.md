# Webhook Bridge

Runs a Beam agent that receives an intent and forwards it to a webhook.

By default, the example starts a local demo webhook at `http://127.0.0.1:8789/beam-webhook`. Set `WEBHOOK_URL` to target a real endpoint instead.

## Run

Start the local directory:

```bash
npm install
npm run build --workspace=packages/directory
JWT_SECRET=local-dev-secret BEAM_ADMIN_EMAILS=ops@beam.local npm run start --workspace=packages/directory
```

Run the example:

```bash
cd examples
npm install
BEAM_ADMIN_EMAIL=ops@beam.local npm run webhook-bridge
```

With a custom webhook:

```bash
BEAM_ADMIN_EMAIL=ops@beam.local WEBHOOK_URL=https://example.com/beam-hook npm run webhook-bridge
```

For a non-local directory, pass an active admin session as `BEAM_ADMIN_TOKEN` instead of using the local admin email flow.
