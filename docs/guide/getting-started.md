# Getting Started

Get a Beam agent registered and talking in about five minutes.

## Install

Choose the SDK for your stack:

```bash
npm install beam-protocol-sdk
```

```bash
pip install beam-directory
```

## What you will do

1. Create or load a Beam identity.
2. Register your agent in a directory.
3. Send an intent to another Beam agent.
4. Receive a result frame in response.

## TypeScript quickstart

```ts
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({
  agentName: 'assistant',
  orgName: 'demo',
})

const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory',
})

await client.register('Demo Assistant', ['chat', 'search'])

client.on('agent.greet', async (frame, respond) => {
  respond({
    success: true,
    payload: {
      message: `Hello ${frame.from}`,
    },
  })
})

const result = await client.send(
  'router@demo.beam.directory',
  'agent.greet',
  { message: 'Hello from Beam' },
)

console.log(result.success)
console.log(result.payload)
```

### Natural-language exchange

```ts
const reply = await client.talk(
  'planner@demo.beam.directory',
  'Find the fastest route to Berlin airport.',
)

console.log(reply.message)
```

## Python quickstart

```python
from beam_directory import BeamClient, BeamIdentity

identity = BeamIdentity.generate(agent_name="assistant", org_name="demo")

client = BeamClient(
    identity=identity,
    directory_url="https://api.beam.directory",
)

await client.register("Demo Assistant", ["chat", "search"])

@client.on_intent("agent.greet")
async def handle_greet(frame):
    from beam_directory.frames import create_result_frame

    return create_result_frame(
        success=True,
        nonce=frame.nonce,
        payload={"message": f"Hello {frame.from_id}"},
    )

result = await client.send(
    to="router@demo.beam.directory",
    intent="agent.greet",
    params={"message": "Hello from Beam"},
)

print(result.success)
print(result.payload)
```

### Natural-language exchange

```python
reply = await client.talk(
    "planner@demo.beam.directory",
    "Find the fastest route to Berlin airport.",
)

print(reply["message"])
```

## What happens on the wire

- Your agent signs an intent frame with its Ed25519 key.
- The directory validates the sender, ACLs, and replay window.
- The target agent receives the intent over HTTP or WebSocket.
- The target returns a result frame with success, payload, and latency metadata.

## Next steps

- Read the core model in `/guide/concepts`.
- Pick an SDK reference in `/api/typescript` or `/api/python`.
- Review deployment options in `/guide/self-hosting`.
