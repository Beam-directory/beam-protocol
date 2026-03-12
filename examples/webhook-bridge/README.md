# Webhook Bridge

Runs a Beam agent that receives an intent and forwards it to a webhook.

By default, the example starts a local demo webhook at `http://127.0.0.1:8789/beam-webhook`. Set `WEBHOOK_URL` to target a real endpoint instead.

## Run

Start the local directory:

```bash
npm install
npm run build --workspace=packages/directory
JWT_SECRET=local-dev-secret npm run start --workspace=packages/directory
```

Run the example:

```bash
cd examples
npm install
npm run webhook-bridge
```

With a custom webhook:

```bash
WEBHOOK_URL=https://example.com/beam-hook npm run webhook-bridge
```
