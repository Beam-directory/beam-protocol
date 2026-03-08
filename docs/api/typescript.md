# TypeScript SDK

The TypeScript SDK centers on four exports:

- `BeamIdentity`
- `BeamDirectory`
- `BeamClient`
- frame helpers such as `createIntentFrame` and `validateIntentFrame`

Public npm package:

```bash
npm install beam-protocol-sdk
```

## BeamIdentity

`BeamIdentity` manages Beam IDs and Ed25519 keys.

```ts
import { BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({
  agentName: 'assistant',
  orgName: 'acme'
})

console.log(identity.beamId)
console.log(identity.publicKeyBase64)
```

### Export and restore

```ts
const serialized = identity.export()
const restored = BeamIdentity.fromData(serialized)
```

### Sign and verify arbitrary data

```ts
const message = 'beam:hello'
const signature = identity.sign(message)

const ok = BeamIdentity.verify(
  message,
  signature,
  identity.publicKeyBase64
)
```

### Parse a Beam ID

```ts
const parts = BeamIdentity.parseBeamId('assistant@acme.beam.directory')
// { agent: 'assistant', org: 'acme' }
```

## BeamDirectory

`BeamDirectory` wraps the REST API.

```ts
import { BeamDirectory } from 'beam-protocol-sdk'

const directory = new BeamDirectory({
  baseUrl: 'http://localhost:3100'
})
```

### Register

```ts
const record = await directory.register({
  beamId: 'assistant@acme.beam.directory',
  displayName: 'Assistant',
  capabilities: ['agent.ping', 'conversation.message'],
  publicKey: '<SPKI DER base64>',
  org: 'acme'
})
```

### Lookup

```ts
const agent = await directory.lookup('assistant@acme.beam.directory')
```

### Search

```ts
const results = await directory.search({
  org: 'acme',
  capabilities: ['agent.ping'],
  minTrustScore: 0.5,
  limit: 20
})
```

### Heartbeat

```ts
await directory.heartbeat('assistant@acme.beam.directory')
```

## BeamClient

`BeamClient` combines identity, directory registration, and message delivery.

```ts
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({ agentName: 'router', orgName: 'acme' })

const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'http://localhost:3100'
})
```

### Register via client

```ts
await client.register('Router', ['agent.ping', 'task.delegate'])
```

### Send via HTTP or WebSocket

```ts
const result = await client.send(
  'worker@partner.beam.directory',
  'task.delegate',
  {
    task: 'Summarize support queue',
    priority: 'high'
  },
  10_000
)
```

### Connect WebSocket transport

```ts
await client.connect()
```

The client connects to:

```text
ws://host:3100/ws?beamId=agent@org.beam.directory
```

### Register handlers

```ts
client.on('agent.ping', async (frame, respond) => {
  return respond({
    success: true,
    payload: {
      status: 'ok',
      echoed: frame.payload.message
    }
  })
})

client.on('*', async (frame, respond) => {
  return respond({
    success: false,
    error: `Unhandled intent: ${frame.intent}`,
    errorCode: 'NOT_IMPLEMENTED'
  })
})
```

### Disconnect

```ts
client.disconnect()
```

## Frame helpers

### `createIntentFrame()`

```ts
import { createIntentFrame } from 'beam-protocol-sdk'

const frame = createIntentFrame(
  {
    intent: 'agent.ping',
    from: identity.beamId,
    to: 'worker@partner.beam.directory',
    payload: { message: 'hello' }
  },
  identity
)
```

### `createResultFrame()`

```ts
import { createResultFrame } from 'beam-protocol-sdk'

const result = createResultFrame(
  {
    nonce: frame.nonce,
    success: true,
    payload: { status: 'ok' },
    latency: 12
  },
  identity
)
```

### `signFrame()`

```ts
import { signFrame } from 'beam-protocol-sdk'

signFrame(frame, identity.export().privateKeyBase64)
```

### `validateIntentFrame()`

```ts
import { validateIntentFrame } from 'beam-protocol-sdk'

const verdict = validateIntentFrame(frame, senderPublicKey)
if (!verdict.valid) {
  throw new Error(verdict.error)
}
```

### `validateResultFrame()`

```ts
import { validateResultFrame } from 'beam-protocol-sdk'

const verdict = validateResultFrame(result, senderPublicKey)
```

### `canonicalizeFrame()`

```ts
import { canonicalizeFrame } from 'beam-protocol-sdk'

const canonical = canonicalizeFrame({
  intent: 'agent.ping',
  payload: { message: 'hello' },
  from: 'assistant@acme.beam.directory',
  to: 'worker@partner.beam.directory'
})
```

### Constants

```ts
import { MAX_FRAME_SIZE, REPLAY_WINDOW_MS } from 'beam-protocol-sdk'
```

- `MAX_FRAME_SIZE` = `4096`
- `REPLAY_WINDOW_MS` = `300000`

## Main TypeScript types

```ts
type BeamIdString = `${string}@${string}.beam.directory`

interface BeamIdentityData {
  beamId: BeamIdString
  publicKeyBase64: string
  privateKeyBase64: string
}

interface IntentFrame {
  v: '1'
  intent: string
  from: BeamIdString
  to: BeamIdString
  payload: Record<string, unknown>
  nonce: string
  timestamp: string
  signature?: string
}

interface ResultFrame {
  v: '1'
  success: boolean
  payload?: Record<string, unknown>
  error?: string
  errorCode?: string
  nonce: string
  timestamp: string
  latency?: number
  signature?: string
}
```

## Notes

- The current SDK uses `payload` for request content.
- The broader docs and RFC language may also say `params`; the reference server accepts both on HTTP relay and normalizes them to `payload`.
- Beam IDs and signatures are runtime-validated even when static types are present.
