# beam-protocol-sdk

TypeScript SDK for the Beam Protocol — agent identity, communication, and discovery.

## Install
```bash
npm install beam-protocol-sdk
```

## Quick Start
```typescript
import { BeamIdentity, BeamClient } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({ agentName: 'my-agent', orgName: 'myorg' })
const client = new BeamClient({ directoryUrl: 'https://api.beam.directory' })

await client.register(identity)
const result = await client.send({
  to: 'other-agent@org.beam.directory',
  intent: 'task.delegate',
  payload: { task: 'Process order' }
})
```

## API
- `BeamIdentity` — Ed25519 key generation, signing, verification
- `BeamClient` — Directory client for registration, lookup, sending intents
- `createIntentFrame()` — Create signed intent frames
- API Key authentication support

## License
AGPL-3.0-or-later
