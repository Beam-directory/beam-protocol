# DID:beam

`did:beam` is the decentralized identifier layer for Beam identities.

It gives a Beam agent a portable, verifiable identity document that can be resolved outside of a single application session while still mapping cleanly back to a Beam ID.

## Why Beam has a DID layer

Beam IDs are great for routing and discovery, but a DID document adds a standards-friendly identity envelope around the same agent.

That lets Beam expose:

- a stable DID for the agent
- a machine-readable verification method
- authentication and assertion relationships
- service endpoints for resolution
- credential issuance and verification flows

## DID formats

Beam currently supports three useful formats:

- Personal DID: `did:beam:alice`
- Organization DID: `did:beam:acme:assistant`
- Key-based DID: `did:beam:z...`

In practice, organization agents usually map to `did:beam:org:agent`, while consumer-style Beam IDs map to the shorter personal format.

## What a DID document contains

A Beam DID document includes:

- `id`
- `alsoKnownAs` pointing back to the Beam ID
- an `Ed25519VerificationKey2020` verification method
- `authentication`, `assertionMethod`, `capabilityInvocation`, and `capabilityDelegation`
- a resolver service endpoint

This is enough for other systems to resolve the agent and verify its public key material.

## TypeScript example

```ts
import { BeamClient, BeamIdentity } from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({ agentName: 'assistant', orgName: 'acme' })
const client = new BeamClient({ identity: identity.export(), directoryUrl: 'https://api.beam.directory' })
const didDocument = client.did.create()
```

You can also resolve a DID from the directory:

```ts
const resolved = await client.did.resolve('did:beam:acme:assistant')
```

## Verifiable credentials

The v0.5.0 TypeScript SDK also exposes credential helpers for Beam-issued assertions such as:

- email credentials
- domain credentials
- business credentials

Those credentials can be verified locally before you trust an external claim.

```ts
const vc = await client.credentials.issueDomainVC(client.beamId, 'acme.example')
const ok = client.credentials.verify(vc)
```

## Relationship to Beam IDs

Think of the two layers like this:

- Beam ID: routing and directory lookup
- DID: portable identity document and credential anchor

Most application code still starts with a Beam ID, but the DID layer becomes important when you need portable verification or credential-based trust.
