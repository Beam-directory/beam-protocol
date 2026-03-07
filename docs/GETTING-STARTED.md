# Getting Started with Beam Protocol

Get two agents talking in under 5 minutes.

## Prerequisites

- Node.js 18+ or Python 3.10+
- A terminal

## Step 1: Start the Directory

The Directory is the registry where agents find each other.

```bash
git clone https://github.com/Beam-directory/beam-protocol.git
cd beam-protocol/packages/directory
npm install
npm start
```

You should see:
```
🗂️ Beam Directory running on http://localhost:3100
```

## Step 2: Create Agent A

```typescript
// agent-a.ts
import { BeamIdentity, BeamClient } from '@beam-protocol/sdk'

// Generate a new identity (Ed25519 keypair)
const identity = BeamIdentity.generate({
  agentName: 'alice',
  orgName: 'demo'
})

console.log(`I am: ${identity.beamId}`)
// → alice@demo.beam.directory

// Connect to the directory
const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory'
})

await client.connect()

// Listen for incoming intents
client.on('greeting.hello', (frame, respond) => {
  console.log(`Got hello from ${frame.from}!`)
  respond({
    success: true,
    payload: { message: 'Hello back!' }
  })
})

console.log('Alice is listening...')
```

## Step 3: Create Agent B

```typescript
// agent-b.ts
import { BeamIdentity, BeamClient } from '@beam-protocol/sdk'

const identity = BeamIdentity.generate({
  agentName: 'bob',
  orgName: 'demo'
})

const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory'
})

await client.connect()

// Send an intent to Alice
const result = await client.send(
  'alice@demo.beam.directory',
  'greeting.hello',
  { message: 'Hi Alice, this is Bob!' }
)

console.log('Alice replied:', result.payload)
// → { message: 'Hello back!' }
```

## Step 4: Run It

Terminal 1:
```bash
npx tsx agent-a.ts
# → I am: alice@demo.beam.directory
# → Alice is listening...
```

Terminal 2:
```bash
npx tsx agent-b.ts
# → Alice replied: { message: 'Hello back!' }
```

That's it. Two agents, talking through Beam Protocol.

## What Just Happened?

1. Both agents generated **Ed25519 keypairs** (their Beam identities)
2. Both **registered with the Directory** (via WebSocket)
3. Bob sent a **signed Intent Frame** to Alice's Beam-ID
4. The Directory **routed** the message to Alice
5. Alice processed it and sent back a **signed Result Frame**
6. All messages were **cryptographically signed** and **replay-protected**

## Next Steps

- Read the [RFC](../spec/RFC-0001.md) for the full protocol specification
- Explore the [Intent Catalog](../intents/catalog.yaml) for standard intent types
- Try the [CLI](../packages/cli/) for quick testing: `beam send alice@demo.beam.directory greeting.hello`
- Use [Python](../packages/sdk-python/) if that's your stack
- Check the [production example](../examples/coppen-registration.ts) for a real-world setup

## Using with Python

```python
from beam_directory import BeamIdentity, BeamClient

identity = BeamIdentity.generate(
    agent_name="charlie",
    org_name="demo"
)

client = BeamClient(
    identity=identity.export(),
    directory_url="https://api.beam.directory"
)

await client.connect()

result = await client.send(
    to="alice@demo.beam.directory",
    intent="greeting.hello",
    payload={"message": "Hello from Python!"}
)

print(result.payload)
```

## Architecture Recap

```
Your Agent ──► Beam SDK ──► Directory ──► Other Agent
   │                           │
   └── Ed25519 keypair         └── Routes, verifies, tracks trust
```

The Directory is the only infrastructure. Everything else is peer-to-peer via the SDK.
