# Beam A2A adapter

Secure, dependency-free compatibility mappings between A2A v1 messages/tasks
and Beam `conversation.message` handoffs.

The package follows the current A2A v1 representation: parts use the member
name (`text`, `url`, `raw`, or `data`) as the discriminator. It intentionally
rejects inline raw file bytes because Beam v1 frames are capped at 4 KB; files
must be exchanged through separately authorized HTTPS URLs.

The adapter does not turn remote A2A metadata or Agent Card badges into Beam
trust. Identity assurance, delegated authority, partner allowlists, approvals,
and audit remain policy decisions in the Beam control plane.

```ts
import { a2aMessageToBeamIntent } from '@beam-protocol/a2a-adapter'

const draft = a2aMessageToBeamIntent({
  from: 'buyer@acme.beam.directory',
  to: 'supplier@partner.beam.directory',
  message: {
    messageId: crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: 'Please confirm delivery.' }],
  },
})

// Sign and send `draft` with the normal Beam SDK. The adapter never handles
// private keys or credentials.
```

Normative source: <https://a2a-protocol.org/latest/specification/>
