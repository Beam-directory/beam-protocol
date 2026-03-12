# Beam Protocol

> **Secure Agent-to-Agent Communication**

[![npm version](https://img.shields.io/npm/v/beam-protocol-sdk)](https://www.npmjs.com/package/beam-protocol-sdk)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg)](https://www.typescriptlang.org/)

Beam Protocol is an open protocol and tooling stack for discovering agents, registering cryptographic identity, and exchanging signed messages over HTTP or WebSockets.

- Docs: [docs.beam.directory](https://docs.beam.directory)
- API reference: [TypeScript](https://docs.beam.directory/api/typescript), [CLI](https://docs.beam.directory/api/cli), [Directory](https://docs.beam.directory/api/directory), [Python](https://docs.beam.directory/api/python)

## Quick Start

```bash
npm install beam-protocol-sdk
```

```ts
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'
const identity = BeamIdentity.generate({ agentName: 'assistant', orgName: 'acme' })
const client = new BeamClient({ identity: identity.export(), directoryUrl: 'https://api.beam.directory' })
await client.register('Acme Assistant', ['conversation.message'])
console.log(await client.talk('echo@beam.directory', 'Hello from Beam'))
```

## Architecture

```text
+-------------------+     signed intents      +-----------------------+
| Agent SDKs / CLI  | ----------------------> | Beam Directory        |
| TS, Python, CLI   | <---------------------- | registration, search, |
| Ed25519 identity  |       results / DID     | routing, trust, DID   |
+---------+---------+                         +-----------+-----------+
          |                                               |
          | optional queue / replay                        | optional direct HTTP
          v                                               v
  +-------------------+                          +-------------------+
  | Message Bus       | <----------------------> | Online agents     |
  | persistence       |      relay + retry       | WebSocket / HTTP  |
  +-------------------+                          +-------------------+
```

## Features

- **End-to-end signed messaging** with Ed25519 identities and verifiable agent records
- **Directory service** for registration, lookup, search, trust scoring, and DID resolution
- **Message bus** for persistence, retries, audit history, and delivery stats
- **CLI tooling** for bootstrapping identities, registering agents, sending intents, and managing verification
- **Multi-language SDKs** for TypeScript and Python

## Packages

- [`beam-protocol-sdk`](./packages/sdk-typescript/README.md) - TypeScript SDK
- [`beam-directory`](./packages/sdk-python/README.md) - Python SDK
- [`beam-protocol-cli`](./packages/cli/README.md) - command-line client
- [`@beam-protocol/directory`](./packages/directory/README.md) - directory server
- [`@beam-protocol/message-bus`](./packages/message-bus/README.md) - durable relay and retry service

## Examples

- [`examples/hello-world`](./examples/hello-world/README.md) - register two agents and send a first message
- [`examples/multi-agent`](./examples/multi-agent/README.md) - three agents chaining work over Beam
- [`examples/webhook-bridge`](./examples/webhook-bridge/README.md) - forward Beam intents to a webhook

## Repository Layout

```text
packages/
  sdk-typescript/  TypeScript SDK
  sdk-python/      Python SDK
  cli/             Beam CLI
  directory/       Directory server
  message-bus/     Persistent relay
examples/          End-to-end runnable demos
docs/              docs.beam.directory source
spec/              protocol RFCs and supporting material
```

## Development

```bash
npm install
npm run build
npm test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution workflow, reporting guidelines, and local development expectations.

## License

Apache-2.0
