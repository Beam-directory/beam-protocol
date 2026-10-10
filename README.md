# Beam

Beam shows whether an AI agent really belongs to a company or person.

Every Beam agent has an address such as `jarvis@coppen.beam.directory` and an Ed25519 signing key. The Beam directory records which organization controls the agent, how that organization proved its domain, and which person is responsible for it. It publishes that as a signed trust assertion that anyone can check against a pinned directory key.

[![CI](https://github.com/Beam-directory/beam-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/Beam-directory/beam-protocol/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

- Website: [beam.directory](https://beam.directory)
- Check an agent: [beam.directory/verify](https://beam.directory/verify)
- Docs: [docs.beam.directory](https://docs.beam.directory)
- Directory API: `https://api.beam.directory`

## Quickstart

### Verify an agent with the TypeScript SDK

```ts
import { verifyAgent } from 'beam-protocol-sdk'

const check = await verifyAgent('jarvis@coppen.beam.directory')
console.log(check.verified, check.summary) // true 'verified: coppen (coppen.de)'
```

`verifyAgent` fetches `GET /agents/:address/trust-assertion`, checks the signature against the directory key built into the SDK, and returns the organization, owner role, scopes, expiry and the signature result. It sends no API key.

`verifyAgent` is in `main` and will ship in the next npm release of `beam-protocol-sdk` (the latest published version is 1.6.0). Until then, build the SDK from this repository:

```bash
npm ci
npm run build --workspace=beam-protocol-sdk
```

### Verify an agent from an MCP client

The MCP server in [`packages/mcp-server`](./packages/mcp-server/README.md) offers the read-only tool `beam_verify_agent`. It runs the same check on the server and stays available when Network and send are turned off.

```bash
npm run build --workspace=@beam-protocol/mcp-server
grok mcp add beam -- node /absolute/path/to/beam-protocol/packages/mcp-server/dist/index.js
```

The server needs a Beam identity in its environment (`BEAM_ID`, `BEAM_PUBLIC_KEY_BASE64`, `BEAM_PRIVATE_KEY_BASE64`, `BEAM_API_KEY`). Then ask the assistant to call `beam_verify_agent` with `{ "address": "jarvis@coppen.beam.directory" }`. Setup for Codex and for a hosted, OAuth-protected deployment is in the [MCP server README](./packages/mcp-server/README.md).

## Repository map

| Path | What it is |
| --- | --- |
| [`packages/directory`](./packages/directory/README.md) | Directory API server: registration, domain proof, people, mandates, trust assertions, routing. Runs at `api.beam.directory`. |
| [`packages/sdk-typescript`](./packages/sdk-typescript/README.md) | `beam-protocol-sdk` on npm: identities, signing, directory client, `verifyAgent`. |
| [`packages/sdk-python`](./packages/sdk-python/README.md) | `beam-directory` on PyPI: Python SDK. |
| [`packages/cli`](./packages/cli/README.md) | `beam-protocol-cli` on npm: the `beam` command. |
| [`packages/mcp-server`](./packages/mcp-server/README.md) | MCP server for Grok, Codex and other MCP clients, local (stdio) or as a dedicated hosted tenant with OAuth. |
| [`packages/public-site`](./packages/public-site) | beam.directory. The built site is committed at the top of this folder; the source is in `site/`. |
| [`packages/dashboard`](./packages/dashboard/README.md) | Operator dashboard (React and Vite). |
| [`packages/message-bus`](./packages/message-bus/README.md) | Durable relay with retries, dedupe and a dead-letter queue. |
| [`packages/a2a-adapter`](./packages/a2a-adapter/README.md) | Mappings between A2A v1 messages and signed Beam handoffs. |
| [`packages/echo-agent`](./packages/echo-agent/README.md) | Test agent used by the local quickstart stack. |
| [`packages/create-beam-agent`](./packages/create-beam-agent/README.md) | Scaffolds a minimal Beam agent project. |
| [`packages/beam-langchain`](./packages/beam-langchain/README.md), [`packages/beam-crewai`](./packages/beam-crewai/README.md) | Python integrations for LangChain and CrewAI. |
| [`integrations`](./integrations) | Plugins for [Grok Build](./integrations/grok-build/README.md) and [Codex](./integrations/codex/beam/README.md). |
| [`docs`](./docs) | Source of docs.beam.directory (VitePress). |
| [`spec`](./spec) | Protocol RFCs, the `did:beam` method, compatibility fixtures and dashboard screenshot baselines. |
| [`examples`](./examples/README.md) | Runnable TypeScript examples against a local directory. |
| [`ops`](./ops) | Docker Compose quickstart, the hosted MCP pilot on Fly.io, and a self-hosted MCP tenant. |
| [`scripts`](./scripts) | End-to-end tests, release checks, production gates, demo seeding and OpenClaw host tooling. |
| [`reports`](./reports/README.md) | Release notes and release evidence. Older reports are in `reports/archive`. |
| `vendor/braces` | Patched copy of `braces`, pinned through npm `overrides`. |

[CONTRIBUTING.md](./CONTRIBUTING.md) describes the folders in more detail.

## Development

Requires Node.js 20.19 or newer and npm 10 or newer. The Python SDK needs Python 3.10 or newer.

```bash
npm ci
npm run build
npm test
```

Cross-stack tests (TypeScript SDK, Python SDK, CLI, directory and message bus):

```bash
python3 -m pip install -e packages/sdk-python
npm run test:e2e
```

Local stack with directory, dashboard, message bus and demo agents:

```bash
cp ops/quickstart/.env.example ops/quickstart/.env
docker compose -f ops/quickstart/compose.yaml --env-file ops/quickstart/.env up -d --build
npm run quickstart:smoke
```

See the [Hosted Quickstart guide](https://docs.beam.directory/guide/hosted-quickstart) for what the stack contains.

## Contributing and security

- How to contribute: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Report a vulnerability: security@beam.directory. Details in [SECURITY.md](./SECURITY.md).
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- Changes per release: [CHANGELOG.md](./CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](./LICENSE).
