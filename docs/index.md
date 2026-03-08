---
layout: home

hero:
  name: Beam Protocol
  text: SMTP for AI Agents
  tagline: Agent-to-Agent communication with global identity, signed frames, directory discovery, and secure delivery.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Read RFC-0001
      link: /spec/rfc-0001
    - theme: alt
      text: GitHub
      link: https://github.com/Beam-directory/beam-protocol

features:
  - title: Global agent identity
    details: Every agent gets a Beam ID like `agent@org.beam.directory`, backed by an Ed25519 key pair for cryptographic authenticity.
  - title: Signed intent frames
    details: Beam frames are compact JSON messages with timestamps, nonces, and signatures for replay protection and verifiable delivery.
  - title: Directory-based discovery
    details: Register agents, search by capability or trust score, and route intents over HTTP or WebSocket using a Beam Directory Server.
  - title: Trust-aware communication
    details: Directories publish trust scores, verification state, and ACL policy so agents can make safer routing decisions.
  - title: Multi-runtime SDKs
    details: Build with TypeScript, Python, CLI tooling, and framework integrations including LangChain and CrewAI adapters.
  - title: Federation-ready design
    details: Beam starts simple with one directory and evolves toward interoperable federated directories via RFC-0002.
---

## Why Beam

AI agents increasingly need to talk to other agents outside their own process, team, or vendor stack. Beam Protocol defines the missing network layer:

- **Identity** via Beam IDs and Ed25519 keys
- **Discovery** via a directory server
- **Delivery** via WebSocket and HTTP intent relay
- **Trust** via verification, activity, and policy signals
- **Interoperability** across languages, frameworks, and organizations

Beam is designed to feel like SMTP: simple primitives first, extensibility second, centralization optional.

## Core building blocks

### Beam ID

```text
agent@org.beam.directory
```

A Beam ID identifies a single agent inside an organizational namespace.

### Intent catalog examples

Beam ships with a small, opinionated intent catalog to make interoperability practical from day one:

- `conversation.message`
- `escalation.request`
- `payment.status_check`
- `sales.pipeline_summary`
- `system.broadcast`
- `agent.ping`
- `agent.introduce`
- `task.delegate`

### Typical flow

```text
1. Generate an Ed25519 identity
2. Register with a directory
3. Discover another agent
4. Send a signed Intent Frame
5. Receive a signed Result Frame
```

## Quick example

```ts
import { BeamIdentity, BeamClient } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({
  agentName: 'ops-bot',
  orgName: 'acme'
})

const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'http://localhost:3100'
})

await client.register('Ops Bot', ['agent.ping', 'task.delegate'])

const result = await client.send(
  'assistant@partner.beam.directory',
  'agent.ping',
  { message: 'hello from Beam' }
)

console.log(result)
```

## Package ecosystem

### npm

- `beam-protocol-sdk`
- `beam-protocol-cli`
- `create-beam-agent`

### PyPI

- `beam-directory`
- `beam-langchain`
- `beam-crewai`

## Read next

- [Getting Started](/guide/getting-started)
- [Core Concepts](/guide/concepts)
- [Self-Hosting](/guide/self-hosting)
- [Directory API](/api/directory)
- [Security Overview](/security/overview)
- [RFC-0002: Federated Directory](/spec/rfc-0002)
