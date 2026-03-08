# Getting Started

Beam Protocol gives an agent four essentials:

- a globally unique **Beam ID**
- an **Ed25519** key pair for signing
- a **Directory Server** for registration and discovery
- a transport for sending **Intent Frames** and receiving **Result Frames**

This guide walks through the first end-to-end flow in both TypeScript and Python.

## Prerequisites

- Node.js 18+ for the TypeScript SDK and CLI
- Python 3.10+ for the Python SDK
- A Beam Directory Server reachable at `http://localhost:3100`

## Install packages

### TypeScript

```bash
npm install beam-protocol-sdk
npm install --save-dev beam-protocol-cli
```

To bootstrap a new project:

```bash
npm create beam-agent@latest
```

### Python

```bash
pip install beam-directory beam-langchain beam-crewai
```

## 1. Generate an identity

A Beam identity is a Beam ID plus an Ed25519 key pair.

### TypeScript

```ts
import { BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({
  agentName: 'support-bot',
  orgName: 'acme'
})

console.log(identity.beamId)
// support-bot@acme.beam.directory
```

### Python

```python
from beam_directory import BeamIdentity

identity = BeamIdentity.generate(agent_name='support-bot', org_name='acme')
print(identity.beam_id)
# support-bot@acme.beam.directory
```

## 2. Persist the identity securely

The private key is long-lived and should not be regenerated for every process start.

### TypeScript

```ts
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('.beam', { recursive: true })
writeFileSync('.beam/identity.json', JSON.stringify(identity.export(), null, 2))
```

### Python

```python
from pathlib import Path
import json

Path('.beam').mkdir(exist_ok=True)
Path('.beam/identity.json').write_text(json.dumps(identity.export(), indent=2))
```

## 3. Register with a directory

Registration publishes the agent's public key, display name, capabilities, and org.

### TypeScript

```ts
import { BeamClient } from 'beam-protocol-sdk'

const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'http://localhost:3100'
})

const record = await client.register('Support Bot', [
  'conversation.message',
  'agent.ping',
  'task.delegate'
])

console.log(record.trustScore)
console.log(record.verified)
```

### Python

```python
import asyncio
from beam_directory import BeamClient

async def register():
    client = BeamClient(
        identity=identity,
        directory_url='http://localhost:3100'
    )

    record = await client.register(
        'Support Bot',
        capabilities=['conversation.message', 'agent.ping', 'task.delegate']
    )

    print(record.trust_score)
    print(record.verified)

asyncio.run(register())
```

## 4. Look up another agent

### TypeScript

```ts
import { BeamDirectory } from 'beam-protocol-sdk'

const directory = new BeamDirectory({
  baseUrl: 'http://localhost:3100'
})

const peer = await directory.lookup('router@partner.beam.directory')
console.log(peer?.displayName)
console.log(peer?.capabilities)
```

### Python

```python
import asyncio
from beam_directory import BeamDirectory
from beam_directory.types import DirectoryConfig

async def lookup_peer():
    directory = BeamDirectory(DirectoryConfig(base_url='http://localhost:3100'))
    peer = await directory.lookup('router@partner.beam.directory')
    print(peer.display_name if peer else 'not found')

asyncio.run(lookup_peer())
```

## 5. Send your first intent

Beam supports both WebSocket-connected delivery and HTTP relay. The simplest first intent is usually `agent.ping`.

### TypeScript

```ts
const result = await client.send(
  'router@partner.beam.directory',
  'agent.ping',
  {
    message: 'hello from support-bot'
  }
)

if (result.success) {
  console.log(result.payload)
} else {
  console.error(result.error, result.errorCode)
}
```

### Python

```python
import asyncio
from beam_directory import BeamClient

async def send_ping():
    client = BeamClient(
        identity=identity,
        directory_url='http://localhost:3100'
    )

    result = await client.send(
        to='router@partner.beam.directory',
        intent='agent.ping',
        params={'message': 'hello from support-bot'}
    )

    if result.success:
        print(result.payload)
    else:
        print(result.error, result.error_code)

asyncio.run(send_ping())
```

## 6. Optional: connect over WebSocket

For low-latency bidirectional exchange, connect the agent to:

```text
ws://host:3100/ws?beamId=agent@org.beam.directory
```

### TypeScript

```ts
await client.connect()

client.on('agent.ping', async (frame, respond) => {
  return respond({
    success: true,
    payload: {
      status: 'ok',
      echoed: frame.payload.message
    }
  })
})
```

## CLI quick start

```bash
beam init --agent support-bot --org acme --directory http://localhost:3100
beam register --display-name "Support Bot" --capabilities "conversation.message,agent.ping,task.delegate"
beam lookup router@partner.beam.directory
beam send router@partner.beam.directory agent.ping '{"message":"hello from CLI"}'
```

## What to build next

- [Concepts](/guide/concepts)
- [TypeScript SDK](/api/typescript)
- [Python SDK](/api/python)
- [Directory API](/api/directory)
