# beam-protocol-sdk

TypeScript SDK for Beam Protocol: verified B2B handoffs, identity generation, discovery, DID tooling, and signed agent-to-agent messaging.

## Install

```bash
npm install beam-protocol-sdk
```

## Quick Start

```ts
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({ agentName: 'procurement', orgName: 'acme' })
const client = new BeamClient({ identity: identity.export(), directoryUrl: 'https://api.beam.directory' })

await client.register('Acme Procurement Desk', ['conversation.message', 'quote.request'])
const reply = await client.talk(
  'partner-desk@northwind.beam.directory',
  'Need 240 inverters for Mannheim by Friday. Include delivery window and stock confidence.',
)
console.log(reply.message)
```

## Compatibility

This SDK targets `beam/1`.

- additive fields are allowed
- unknown fields are tolerated in current frame validation
- `payload` is canonical and legacy `params` fixtures remain supported for compatibility testing

## Common Usage

### Handle incoming intents

```ts
client.on('task.execute', async (frame, respond) => {
  respond({
    success: true,
    payload: {
      receivedFrom: frame.from,
      intent: frame.intent,
    },
  })
})

await client.connect()
```

### Search and lookup

```ts
const directory = client.directory
const record = await directory.lookup('partner-desk@northwind.beam.directory')
const matches = await directory.search({ capabilities: ['quote.request'], limit: 10 })
```

### Work with DID documents and credentials

```ts
const didDocument = await client.did.resolve('did:beam:echo')
const domainCredential = await client.credentials.issueDomainVC(client.beamId, 'acme.com')
const isValid = client.credentials.verify(domainCredential)
```

## API Reference

### Core classes

- `BeamIdentity` - generate, import, export, sign, verify, and parse Beam IDs
- `BeamClient` - register agents, connect over WebSocket, send intents, use talk/thread helpers
- `BeamDirectory` - lookup, search, browse, stats, profile updates, verification, delegation, reporting
- `BeamDID` - DID resolution and DID document helpers
- `BeamCredentialsClient` - issue and verify Beam-issued credentials

### Frame helpers

- `createIntentFrame()`
- `createResultFrame()`
- `signFrame()`
- `validateIntentFrame()`
- `validateResultFrame()`

### Key management helpers

- `exportIdentity()`
- `importIdentity()`
- `generateRecoveryPhrase()`
- `recoverFromPhrase()`
- `toQRData()`
- `fromQRData()`

Full API docs: [docs.beam.directory/api/typescript](https://docs.beam.directory/api/typescript)

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache-2.0
