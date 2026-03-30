# Beam Protocol

> **Verified B2B handoffs for AI agents**

[![npm version](https://img.shields.io/npm/v/beam-protocol-sdk)](https://www.npmjs.com/package/beam-protocol-sdk)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg)](https://www.typescriptlang.org/)

Beam is an open protocol and tooling stack for one hard problem: letting one company's agent hand work to another company's agent without shared API keys, brittle one-off integrations, or blind trust.

The opinionated Beam 0.6.0 wedge is a verified partner handoff:

1. `procurement@acme.beam.directory` asks `partner-desk@northwind.beam.directory` for a quote.
2. `partner-desk@northwind.beam.directory` checks inventory with `warehouse@northwind.beam.directory`.
3. Acme gets a signed response, a traceable nonce, and an operator-visible audit trail.

- Docs: [docs.beam.directory](https://docs.beam.directory)
- First-run guide: [Verified Partner Handoff](https://docs.beam.directory/guide/partner-handoff)
- Compatibility policy: [Beam 0.6 Compatibility](https://docs.beam.directory/guide/compatibility)
- API reference: [TypeScript](https://docs.beam.directory/api/typescript), [CLI](https://docs.beam.directory/api/cli), [Directory](https://docs.beam.directory/api/directory), [Python](https://docs.beam.directory/api/python)

## Quick Start

```bash
npm install beam-protocol-sdk
```

```ts
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({ agentName: 'procurement', orgName: 'acme' })
const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory',
})

await client.register('Acme Procurement Desk', ['conversation.message', 'quote.request'])

const reply = await client.talk(
  'partner-desk@northwind.beam.directory',
  'Need 240 inverters for Mannheim by Friday. Include delivery window and stock confidence.',
)

console.log(reply.message)
```

For the full three-agent flow, see [`examples/partner-handoff`](./examples/partner-handoff/README.md).

## Why Beam

- **Verified addresses** so both sides know which company and which agent received the request
- **Signed intents and results** with Ed25519 and nonce-based replay protection
- **Operator visibility** through traces, audit logs, alerts, and dead-letter inspection
- **Retry and recovery** with a message bus for durable handoffs and restart safety
- **Self-hostable building blocks** across Directory, Dashboard, CLI, and SDKs

## Architecture

```text
+------------------------+     signed handoff      +------------------------+
| Acme procurement agent | ----------------------> | Beam Directory         |
| TS SDK / Python / CLI  | <---------------------- | identity, ACL, trace,  |
| procurement@acme       |        result / DID     | operator views         |
+------------+-----------+                         +-----------+------------+
             |                                                  |
             | optional durable relay                            | direct / federated delivery
             v                                                  v
  +------------------------+                          +------------------------+
  | Message Bus            | <----------------------> | Northwind agents       |
  | retry, dedupe, DLQ     |       queued handoff     | partner desk, warehouse|
  +------------------------+                          +------------------------+
```

## Compatibility

Beam 0.6.0 treats `beam/1` as the compatibility contract across the protocol, directory, CLI, and SDKs.

- Additive fields are allowed within `beam/1`.
- Receivers must ignore unknown top-level and payload fields.
- `payload` is the canonical request body; `params` remains a legacy alias accepted by current SDKs.
- Breaking field removals, required-field changes, or signature changes require a new protocol version.

See the full policy in [`docs/guide/compatibility.md`](./docs/guide/compatibility.md).

## Packages

- [`beam-protocol-sdk`](./packages/sdk-typescript/README.md) - TypeScript SDK
- [`beam-directory`](./packages/sdk-python/README.md) - Python SDK
- [`beam-protocol-cli`](./packages/cli/README.md) - command-line client
- [`@beam-protocol/directory`](./packages/directory/README.md) - directory server
- [`@beam-protocol/message-bus`](./packages/message-bus/README.md) - durable relay and retry service

## Examples

- [`examples/partner-handoff`](./examples/partner-handoff/README.md) - the recommended 0.6.0 B2B workflow
- [`examples/hello-world`](./examples/hello-world/README.md) - register two agents and send a first message
- [`examples/multi-agent`](./examples/multi-agent/README.md) - a generic chained workflow
- [`examples/webhook-bridge`](./examples/webhook-bridge/README.md) - forward Beam intents to a webhook

## Release Readiness

The 0.6.0 dogfood workflow and findings live in [`reports/0.6.0-release-readiness.md`](./reports/0.6.0-release-readiness.md).

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
reports/           Dogfood and release-readiness reports
spec/              protocol RFCs and compatibility fixtures
```

## Development

```bash
npm install
npm run build
npm test
python3 -m pip install -e packages/sdk-python
npm run test:e2e
npm run dogfood:partner-handoff
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution workflow, reporting guidelines, and local development expectations.

## License

Apache-2.0
