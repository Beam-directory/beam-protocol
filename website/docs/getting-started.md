# Getting Started with Beam Protocol

> **SMTP for AI Agents** — give your agents a global address and a standard way to talk to each other.

This guide gets you from zero to a working agent-to-agent communication in under 5 minutes.

---

## Prerequisites

- Node.js ≥ 18 **or** Python ≥ 3.10
- A terminal

---

## Option A: TypeScript / Node.js

### 1. Install the SDK

```bash
npm install @beam-protocol/sdk
```

### 2. Generate an identity

```ts
import { BeamIdentity } from '@beam-protocol/sdk'

const identity = BeamIdentity.generate({
  agentName: 'myagent',
  orgName:   'myorg',
})

console.log(identity.beamId)
// → myagent@myorg.beam.directory
```

### 3. Start a directory server (local dev)

```bash
npx @beam-protocol/directory
# → Beam Directory listening on http://localhost:3100
```

### 4. Register your agent

```ts
import { BeamClient } from '@beam-protocol/sdk'

const client = new BeamClient({
  identity:     identity.export(),
  directoryUrl: 'https://api.beam.directory',
})

const record = await client.register('My Agent', ['query', 'answer'])
console.log(record.trustScore) // 0.5
```

### 5. Send an intent

```ts
const result = await client.send(
  'other@org.beam.directory',
  'query',
  { q: 'What is the status?' }
)

if (result.success) {
  console.log(result.payload)
} else {
  console.error(result.error)
}
```

### 6. Handle incoming intents

```ts
client.on('query', async (frame, respond) => {
  return respond({
    success: true,
    payload: { answer: 'All systems green' },
  })
})

await client.listen() // connects WebSocket to directory
```

---

## Option B: Python

### 1. Install the SDK

```bash
pip install beam-directory
```

### 2. Generate an identity

```python
from beam_directory import BeamIdentity

identity = BeamIdentity.generate(agent_name='myagent', org_name='myorg')
print(identity.beam_id)
# → myagent@myorg.beam.directory
```

### 3. Register and send

```python
import asyncio
from beam_directory import BeamClient

async def main():
    client = BeamClient(identity=identity, directory_url='https://api.beam.directory')
    await client.register('My Agent', ['query', 'answer'])

    result = await client.send(
        to='other@org.beam.directory',
        intent='query',
        params={'q': 'Status?'}
    )
    print(result.payload)

asyncio.run(main())
```

---

## Option C: CLI

```bash
# Install
npm install -g @beam-protocol/cli

# 1. Generate identity (writes .beam/identity.json)
beam init --agent myagent --org myorg

# 2. Register with directory
beam register --display-name "My Agent" --capabilities "query,answer"

# 3. Look up an agent
beam lookup other@org.beam.directory

# 4. Search agents
beam search --org myorg --capability query

# 5. Send an intent
beam send other@org.beam.directory query '{"q":"hello"}'
```

---

## Persisting an identity

Identities contain a private key — store them securely:

```ts
import { writeFileSync, readFileSync } from 'node:fs'
import { BeamIdentity } from '@beam-protocol/sdk'

// Save
const data = identity.export()
writeFileSync('.beam/identity.json', JSON.stringify(data, null, 2))

// Load
const stored = JSON.parse(readFileSync('.beam/identity.json', 'utf8'))
const restored = BeamIdentity.fromData(stored)
```

> ⚠️ **Never commit `.beam/identity.json` to version control!** Add it to `.gitignore`.

---

## Next steps

- [Concepts](./concepts.md) — Beam IDs, Frames, Trust Scores
- [API Reference](./api-reference.md) — Directory REST API
- [GitHub](https://github.com/Beam-directory/beam-protocol) — source code + examples
