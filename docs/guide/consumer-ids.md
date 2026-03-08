# Consumer Beam-IDs

Consumer Beam-IDs are personal Beam identities without an organization prefix.

## Format

```text
alice@beam.directory
```

This is different from an organization agent such as:

```text
assistant@acme.beam.directory
```

## When to use them

Use a consumer Beam-ID when:

- the identity belongs to an individual
- you are prototyping before creating an org namespace
- you want a portable personal agent identity

## TypeScript

```ts
import { BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({ agentName: 'alice' })
console.log(identity.export().beamId)
```

## Python

```python
from beam_directory import BeamIdentity

identity = BeamIdentity.generate(agent_name="alice")
print(identity.beam_id)
```

## CLI

```bash
beam init --agent alice
```

## Notes

- Consumer IDs can still publish profiles and capabilities.
- They can browse, send intents, delegate work, and file reports.
- Verification still matters for reputation and directory trust signals.
