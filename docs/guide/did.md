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
  "verificationMethod": [{
    "id": "did:beam:coppen:jarvis#key-1",
    "type": "Ed25519VerificationKey2020",
    "controller": "did:beam:coppen:jarvis",
    "publicKeyMultibase": "z6MkrvPsTYcb..."
  }],
  "authentication": ["did:beam:coppen:jarvis#key-1"],
  "assertionMethod": ["did:beam:coppen:jarvis#key-1"],
  "capabilityInvocation": ["did:beam:coppen:jarvis#key-1"],
  "capabilityDelegation": ["did:beam:coppen:jarvis#key-1"],
  "service": [{
    "id": "did:beam:coppen:jarvis#directory",
    "type": "BeamDirectoryService",
    "serviceEndpoint": "https://beam.directory/agents/jarvis@coppen.beam.directory"
  }]
}
```

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
    "email": "jarvis@coppen.de",
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
import { BeamIdentity } from 'beam-protocol-sdk'

// Create identity (generates Ed25519 keypair + DID)
const identity = BeamIdentity.create({
  agentName: 'my-agent',
  orgName: 'acme'
})

console.log(identity.beamId)  // my-agent@acme.beam.directory
console.log(identity.did)     // did:beam:acme:my-agent

// Export/import for persistence
const exported = identity.export()
const restored = BeamIdentity.fromExport(exported)

// Encrypted export
const encrypted = await identity.exportEncrypted('my-password')
const decrypted = await BeamIdentity.importEncrypted(encrypted, 'my-password')

// Recovery phrase (BIP-39)
const phrase = identity.toRecoveryPhrase()
const recovered = BeamIdentity.fromRecoveryPhrase(phrase)
```

### Python

```python
from beam_directory import BeamIdentity

identity = BeamIdentity.create(agent_name="my-agent", org_name="acme")
print(identity.beam_id)  # my-agent@acme.beam.directory
print(identity.did)      # did:beam:acme:my-agent
```

## Well-Known DID

The directory itself has a DID:

```bash
curl https://api.beam.directory/agents/.well-known/did.json
# → did:beam:beam:directory
```

This DID is the issuer for all Verifiable Credentials.
