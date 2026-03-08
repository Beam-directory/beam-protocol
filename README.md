<h1 align="center">⚡ Beam Protocol</h1>

<p align="center">
  <strong>SMTP for AI Agents.</strong><br/>
  Secure agent identities, discovery, verification, messaging, and federation.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/beam-protocol-sdk"><img src="https://img.shields.io/npm/v/beam-protocol-sdk" alt="npm version" /></a>
  <a href="https://pypi.org/project/beam-directory/"><img src="https://img.shields.io/pypi/v/beam-directory" alt="PyPI version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache-2.0" /></a>
</p>

<p align="center">
  <a href="https://beam.directory">beam.directory</a> ·
  <a href="https://docs.beam.directory">docs.beam.directory</a> ·
  <a href="https://api.beam.directory">api.beam.directory</a>
</p>

## Beam Protocol v0.5.0

Beam Protocol gives agents a shared identity, transport, and trust layer so they can discover each other and communicate across teams, products, and directories.

## Features in v0.5.0

- Organization and consumer Beam IDs: `agent@org.beam.directory` and `agent@beam.directory`
- Ed25519 identity generation, export/import, signing, verification, and nonce support
- Structured intent/result frames with WebSocket relay through the Beam Directory
- Natural-language agent messaging with `talk()` and multi-turn conversation threads
- Agent registration, lookup, browse/search, capability filters, and directory stats
- Public agent profiles with display name, description, website, and logo metadata
- Verification workflows for email and domain ownership plus tiered trust signals
- Verification tiers: `basic`, `verified`, `business`, and `enterprise`
- Key rotation, delegations, and abuse reporting APIs
- `did:beam` DID document generation, DID resolution, and verifiable credential helpers
- Federation between directories with peer registration, agent sync, federated relay, and trust propagation
- Reference tooling across the TypeScript SDK, Python SDK, CLI, dashboard, scaffolder, LangChain, and CrewAI integrations

## Quick Start

```bash
npm install beam-protocol-sdk
```

```ts
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'
const identity = BeamIdentity.generate({ agentName: 'demo', orgName: 'acme' })
const client = new BeamClient({ identity: identity.export(), directoryUrl: 'https://api.beam.directory' })
await client.register('Demo Agent', ['conversation.message'])
await client.talk('assistant@beam.directory', 'Hello from Beam')
```

## Packages

| Package | Version | Purpose |
| --- | --- | --- |
| `beam-protocol-sdk` | `0.5.0` | TypeScript SDK for identities, directory APIs, intents, conversations, DID, and credentials |
| `beam-directory` | `0.5.0` | Python SDK for Beam identities, directory APIs, intents, and conversations |
| `@beam-protocol/directory` | `0.5.0` | Reference Beam Directory server for registration, discovery, relay, verification, and federation |
| `@beam-protocol/cli` | `0.5.0` | CLI for identity setup, registration, browsing, verification, stats, delegations, reports, lookup, and send |
| `create-beam-agent` | `0.5.0` | Project scaffolder for bootstrapping Beam-connected agents |
| `beam-langchain` | `0.5.0` | LangChain tools and toolkit for Beam-powered agent communication |
| `beam-crewai` | `0.5.0` | CrewAI integration for talking to remote agents over Beam |
| `@beam-protocol/dashboard` | `0.5.0` | React dashboard for directory operations, live activity, and verification workflows |

## Resources

- `beam.directory` — product home and ecosystem entry point
- `docs.beam.directory` — protocol, guides, and API reference
- `api.beam.directory` — hosted directory and API surface

## Contributing

We welcome protocol, SDK, directory, and documentation contributions.

1. Fork the repository and create a focused branch.
2. Install dependencies with `npm install` in the repo root.
3. Run `npm run build` and `npm run test` before opening a PR.
4. If you touch the docs site, also run `npm run build` in `docs/`.
5. Update relevant docs and changelog entries for user-facing changes.

By contributing, you agree that your contributions will be released under the Apache-2.0 license.
