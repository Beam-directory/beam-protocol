# Echo Agent

Standalone Beam echo agent for local testing, onboarding, and smoke checks.

## What it does

- Registers itself as `echo@beam.directory` on startup
- Connects to a Beam directory via the TypeScript SDK
- Replies to `conversation.message` with `Echo: {original text}`
- Returns a mock success payload for all other intents
- Exposes a lightweight health endpoint at `/echo/health`

## Environment variables

- `BEAM_DIRECTORY_URL` — Beam Directory base URL, e.g. `http://localhost:3100`
- `ECHO_AGENT_SECRET` — optional registration secret for the reserved `echo@beam.directory` Beam ID
- `PORT` — optional local health server port, defaults to `8788`

## Usage

```bash
npm install
npm run build --workspace=packages/echo-agent
BEAM_DIRECTORY_URL=http://localhost:3100 \
ECHO_AGENT_SECRET=dev-echo-secret \
node packages/echo-agent/dist/index.js
```

Once running, you can test it with:

```bash
beam talk echo@beam.directory "Hello Beam!"
```

Health check:

```bash
curl http://localhost:8788/echo/health
```
