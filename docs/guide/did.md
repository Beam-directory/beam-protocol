# DID Identity

Every Beam-ID automatically maps to a W3C Decentralized Identifier (DID).

## Format

```
Beam-ID:  tobias@beam.directory
DID:      did:beam:tobias

Beam-ID:  booking@lufthansa.beam.directory
DID:      did:beam:lufthansa:booking

Beam-ID:  jarvis@coppen.beam.directory
DID:      did:beam:coppen:jarvis
```

### Rules

| Beam-ID Type | DID Format | Example |
|-------------|-----------|---------|
| Personal | `did:beam:{name}` | `did:beam:tobias` |
| Organization | `did:beam:{org}:{name}` | `did:beam:lufthansa:booking` |
| Key-based | `did:beam:z6Mk...` | For anonymous/key-only agents |

## DID Document

Every registered agent gets a DID Document that follows the [W3C DID v1.1 specification](https://www.w3.org/TR/did-core/).
Beam keeps historical signing keys in the DID document so older signatures remain auditable after key rotation.

### Resolve a DID

```bash
curl https://api.beam.directory/agents/did/did:beam:coppen:jarvis
```

### Response

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1"
  ],
  "id": "did:beam:coppen:jarvis",
  "alsoKnownAs": ["jarvis@coppen.beam.directory"],
  "verificationMethod": [
    {
      "id": "did:beam:coppen:jarvis#z6MkrvPsTYcb...",
      "type": "Ed25519VerificationKey2020",
      "controller": "did:beam:coppen:jarvis",
      "publicKeyMultibase": "z6MkrvPsTYcb...",
      "beamStatus": "active"
    },
    {
      "id": "did:beam:coppen:jarvis#z6Mklegacy...",
      "type": "Ed25519VerificationKey2020",
      "controller": "did:beam:coppen:jarvis",
      "publicKeyMultibase": "z6Mklegacy...",
      "beamStatus": "revoked",
      "beamRevokedAt": "2026-03-30T10:22:11.000Z"
    }
  ],
  "authentication": ["did:beam:coppen:jarvis#z6MkrvPsTYcb..."],
  "assertionMethod": ["did:beam:coppen:jarvis#z6MkrvPsTYcb..."],
  "capabilityInvocation": ["did:beam:coppen:jarvis#z6MkrvPsTYcb..."],
  "capabilityDelegation": ["did:beam:coppen:jarvis#z6MkrvPsTYcb..."],
  "service": [
    {
      "id": "did:beam:coppen:jarvis#directory",
      "type": "BeamDirectoryService",
      "serviceEndpoint": "https://beam.directory/agents/jarvis@coppen.beam.directory"
    },
    {
      "id": "did:beam:coppen:jarvis#keys",
      "type": "BeamKeyStateService",
      "serviceEndpoint": "https://beam.directory/agents/jarvis@coppen.beam.directory/keys"
    }
  ]
}
```

### Key lifecycle semantics

- Only the current active key appears in `authentication`, `assertionMethod`, `capabilityInvocation`, and `capabilityDelegation`.
- Rotated-out keys stay in `verificationMethod` with `beamStatus: "revoked"` so historical signatures can still be verified.
- Revoked keys are not accepted for new intents.
- The directory key inventory is also available at `GET /agents/:beamId/keys`.

## Architecture

### Three-Layer Identity Stack

```
Layer 0: Network     — Beam Directory (discovery, relay)
Layer 1: Keys        — Ed25519 keypair (cryptographic identity)
Layer 2: Identity    — Beam-ID + DID Document (human-readable + machine-verifiable)
Layer 3: Trust       — Verification tiers + trust scores (reputation)
```

### No Blockchain

Beam uses:
- **Ed25519 keys** for cryptographic identity
- **DNS TXT records** as fallback verification
- **W3C Verifiable Credentials** for attestations
- **Directory federation** for decentralization

No blockchain, no tokens, no gas fees. Just cryptography and federation.

## Verifiable Credentials

The directory issues W3C Verifiable Credentials for each verification:

### Email Verification VC

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "EmailVerificationCredential"],
  "issuer": "did:beam:beam:directory",
  "credentialSubject": {
    "id": "did:beam:coppen:jarvis",
    "email": "agent@example.com",
    "verified": true
  }
}
```

### Domain Verification VC

Issued after DNS TXT record verification:

```json
{
  "type": ["VerifiableCredential", "DomainVerificationCredential"],
  "credentialSubject": {
    "id": "did:beam:coppen:jarvis",
    "domain": "coppen.de",
    "verificationMethod": "dns-txt"
  }
}
```

### Business Verification VC

Issued after business registry verification:

```json
{
  "type": ["VerifiableCredential", "BusinessVerificationCredential"],
  "credentialSubject": {
    "id": "did:beam:lufthansa:booking",
    "registryCountry": "DE",
    "registryId": "HRB 107033",
    "legalName": "Deutsche Lufthansa AG"
  }
}
```

## SDK Usage

### TypeScript

```typescript
import {
  BeamClient,
  BeamIdentity,
  exportIdentity,
  generateRecoveryPhrase,
  importIdentity,
  recoverFromPhrase,
} from 'beam-protocol-sdk'

const identity = BeamIdentity.generate({
  agentName: 'my-agent',
  orgName: 'acme'
})

const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory',
})

const didDocument = client.did.create()

console.log(identity.beamId)   // my-agent@acme.beam.directory
console.log(didDocument.id)    // did:beam:acme:my-agent

// Export/import for persistence
const exported = await exportIdentity(identity.export())
const restored = BeamIdentity.fromData(await importIdentity(exported))

// Encrypted export
const encrypted = await exportIdentity(identity.export(), 'my-password')
const decrypted = BeamIdentity.fromData(await importIdentity(encrypted, 'my-password'))

// Recovery phrase (BIP-39)
const phrase = generateRecoveryPhrase(identity.export())
const recovered = BeamIdentity.fromData(recoverFromPhrase(phrase, identity.beamId))
```

### Python

```python
from beam_directory import BeamIdentity

identity = BeamIdentity.generate(agent_name="my-agent", org_name="acme")
print(identity.beam_id)  # my-agent@acme.beam.directory
# DIDs follow the same shape: did:beam:acme:my-agent
```

## Well-Known DID

The directory itself has a DID:

```bash
curl https://api.beam.directory/agents/.well-known/did.json
# → did:beam:beam:directory
```

This DID is the issuer for all Verifiable Credentials.
