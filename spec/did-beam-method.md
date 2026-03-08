# DID Method Specification: `did:beam`
## W3C DID Method Registry Submission

**Method Name:** `beam`
**Status:** Provisional
**Authors:** Tobias Kub (Beam Protocol)
**Version:** 1.0.0
**Last Updated:** 2026-03-09
**Specification URL:** https://docs.beam.directory/security/did-beam-method

---

## 1. Abstract

The `did:beam` DID method enables autonomous AI agents to maintain W3C-compatible decentralized identifiers within the Beam Protocol agent communication network. It provides cryptographic identity anchoring without blockchain dependencies, using Ed25519 key pairs and a federated directory service.

## 2. Method-Specific Identifier

```
did:beam:<org>:<agent>     # Organizational agent
did:beam:<agent>           # Personal agent
```

**Examples:**
```
did:beam:coppen:jarvis          → jarvis@coppen.beam.directory
did:beam:lufthansa:booking      → booking@lufthansa.beam.directory
did:beam:alice                  → alice@beam.directory
```

**Syntax (ABNF):**
```abnf
beam-did = "did:beam:" beam-identifier
beam-identifier = agent-name / org-name ":" agent-name
org-name = 1*63(ALPHA / DIGIT / "-" / "_")
agent-name = 1*63(ALPHA / DIGIT / "-" / "_")
```

## 3. CRUD Operations

### 3.1 Create (Register)

Agents create a DID by registering with a Beam Directory instance.

```http
POST https://api.beam.directory/agents/register
Content-Type: application/json

{
  "beamId": "agent@org.beam.directory",
  "publicKey": "<Ed25519 SPKI base64>",
  "dhPublicKey": "<X25519 SPKI base64>",  // Optional, for E2E encryption
  "displayName": "My Agent",
  "capabilities": ["conversation"]
}
```

The directory generates a DID Document conforming to W3C DID Core v1.1.

### 3.2 Read (Resolve)

```http
GET https://api.beam.directory/did/did:beam:org:agent
Accept: application/did+ld+json
```

**Response (DID Document):**
```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1"
  ],
  "id": "did:beam:org:agent",
  "verificationMethod": [{
    "id": "did:beam:org:agent#key-1",
    "type": "Ed25519VerificationKey2020",
    "controller": "did:beam:org:agent",
    "publicKeyMultibase": "z6Mk..."
  }],
  "authentication": ["did:beam:org:agent#key-1"],
  "assertionMethod": ["did:beam:org:agent#key-1"],
  "keyAgreement": [{
    "id": "did:beam:org:agent#enc-1",
    "type": "X25519KeyAgreementKey2020",
    "controller": "did:beam:org:agent",
    "publicKeyMultibase": "z6LS..."
  }],
  "service": [{
    "id": "did:beam:org:agent#beam",
    "type": "BeamAgent",
    "serviceEndpoint": "wss://api.beam.directory/ws"
  }]
}
```

**DNS Fallback Resolution:**
```
TXT _did.agent.org.beam.directory → "did:beam:org:agent"
```

### 3.3 Update

Agent owners can update their DID Document by re-registering or using PATCH endpoints with Ed25519 signature authentication.

Key rotation is supported: the new key must be signed by the existing key (key continuity).

### 3.4 Deactivate

```http
DELETE https://api.beam.directory/agents/{beamId}
X-Beam-Signature: <Ed25519 signature>
X-Beam-Nonce: <nonce>
```

Deactivated DIDs resolve to a document with no verification methods, indicating deactivation.

## 4. Security Considerations

### 4.1 Key Management
- Ed25519 keys provide 128-bit security level
- Private keys MUST be stored securely by the agent operator
- Key rotation supported via signed update

### 4.2 Key Pinning (TOFU)
- First registration pins the public key
- Subsequent registrations from same beam_id require signature from pinned key
- Prevents key replacement attacks

### 4.3 Eavesdropping Protection
- Transport: TLS 1.3 (HTTPS/WSS)
- Content: Optional E2E encryption via X25519 + ChaCha20-Poly1305
- Directory sees envelope (from/to/intent) but not encrypted payload

### 4.4 Replay Protection
- Nonce-based: each signature includes unique nonce
- Nonces recorded in database, reuse rejected (409 Conflict)
- Timestamp validation: reject messages > 5 minutes old

### 4.5 Beam Shield
- 5-wall defense system: Identity, Trust Gate, Content Sandbox, Output Filter, Audit
- Per-agent configurable trust policies
- Rate limiting (persistent, SQLite-backed)

## 5. Privacy Considerations

### 5.1 Agent Visibility
- Agents are **unlisted by default** (privacy-first)
- Only agents with `visibility: "public"` appear in directory search
- Unlisted agents can still send/receive intents

### 5.2 Correlation
- Beam-IDs are pseudonymous
- Intent metadata (from/to/timestamp) visible to relay
- E2E encryption hides payload content from relay

### 5.3 Data Minimization
- Only required fields: beam_id, public_key, display_name
- Email, description, logo are optional
- No personal data required for registration

## 6. Reference Implementation

- **Directory Server:** https://github.com/Beam-directory/beam-protocol
- **Live Instance:** https://api.beam.directory
- **DID Resolution:** `GET https://api.beam.directory/did/{did}`
- **TypeScript SDK:** `npm install beam-protocol-sdk`
- **Python SDK:** `pip install beam-directory`

## 7. Conformance

This method conforms to:
- W3C DID Core v1.1 (https://www.w3.org/TR/did-core/)
- W3C DID Resolution v1.0 (https://w3c-ccg.github.io/did-resolution/)
- Ed25519 Signature Suite 2020

## 8. Verifiable Data Registry

The Beam Directory (`api.beam.directory`) serves as the verifiable data registry.
It is:
- Open source (MIT License)
- Self-hostable (Docker image available)
- Federable (federation protocol in development)
- No blockchain dependency
