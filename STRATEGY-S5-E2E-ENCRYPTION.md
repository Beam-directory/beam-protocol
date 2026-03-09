# S5: End-to-End Encryption

## Problem
Aktuell: Intents sind signiert (Authentizität) aber nicht verschlüsselt.
Der Directory-Server kann jeden Payload lesen.
Für Enterprise-Use-Cases (Payments, Healthcare, Legal) ist das ein Dealbreaker.

## Design: X25519 + ChaCha20-Poly1305

### Key Agreement
Jeder Agent hat neben seinem Ed25519-Signing-Key einen X25519-Encryption-Key:
```
Ed25519 (signing):    publicKey  → Signatur-Verifikation
X25519 (encryption):  dhPublicKey → Key Agreement für E2E
```

### Encryption Flow

```
Agent A will encrypted Intent an Agent B senden:

1. Agent A holt Agent B's dhPublicKey aus Directory
   GET /agents/agent-b@org.beam.directory → { dhPublicKey: "..." }

2. Agent A generiert ephemeral X25519 Keypair
   ephemeralPrivate + ephemeralPublic

3. Key Agreement: ECDH(ephemeralPrivate, B.dhPublicKey) → sharedSecret

4. Derive Key: HKDF-SHA256(sharedSecret, nonce) → encryptionKey

5. Encrypt: ChaCha20-Poly1305(encryptionKey, payload) → ciphertext

6. Intent Frame:
   {
     "to": "agent-b@org.beam.directory",
     "intent": "conversation.message",
     "encrypted": true,
     "ephemeralPublicKey": "<base64>",
     "payload": "<encrypted-base64>",  // ← nur B kann lesen
     "signature": "<Ed25519 over encrypted payload>"
   }
```

### Directory sieht:
- ✅ Sender (from)
- ✅ Empfänger (to)
- ✅ Intent Type (für Routing/ACL)
- ❌ Payload Inhalt (verschlüsselt)
- ✅ Signatur (für Authentizität)

### Agent B Decryption:
```
1. ECDH(B.dhPrivateKey, ephemeralPublicKey) → sharedSecret
2. HKDF-SHA256(sharedSecret, nonce) → encryptionKey
3. Decrypt: ChaCha20-Poly1305(encryptionKey, ciphertext) → payload
4. Verify: Ed25519(payload, signature, A.publicKey)
```

### Warum ChaCha20 statt AES?
- Schneller auf ARM (= mobile agents, IoT)
- Kein Timing-Leak-Risiko (constant-time by design)
- libsodium native Support
- Google/Cloudflare Standard für TLS

### Warum Ephemeral Keys?
- **Forward Secrecy:** Kompromittierung von B's langlebigem Key entschlüsselt keine alten Messages
- **Kein Session-State nötig:** Jeder Intent hat eigenen ephemeral Key

### Registration Update
```json
{
  "beamId": "agent@org.beam.directory",
  "publicKey": "<Ed25519 SPKI base64>",
  "dhPublicKey": "<X25519 base64>",     // ← NEU
  "capabilities": ["conversation", "e2e-encryption"]
}
```

### SDK Interface
```typescript
// Automatic E2E when both agents support it
const result = await client.send('agent-b@org.beam.directory', {
  intent: 'conversation.message',
  payload: { message: 'Sensitive payment details' },
  encrypted: true,  // opt-in, or auto if both support
})
```

### Backward Compatibility
- E2E ist opt-in (encrypted: true in Intent Frame)
- Agents ohne dhPublicKey → Unencrypted (wie heute)
- SDK auto-detects: Empfänger hat dhPublicKey? → Encrypt. Sonst → Plain.
- Directory routes encrypted Intents normal (sieht nur Envelope)

### Implementation Plan
1. `dhPublicKey` Feld in agents Tabelle + Registration
2. X25519 Key Generation im SDK (`crypto` native Node.js)
3. Encrypt/Decrypt Funktionen in `packages/directory/src/shield/encryption.ts`
4. SDK: `client.send()` mit `encrypted: true` Option
5. Bridge: Auto-Encrypt wenn Empfänger E2E supported

## Timeline: Q3 2026
## Aufwand: ~1 Woche
## Dependencies: S4 (P2P HTTP) macht E2E noch wertvoller (Directory sieht gar nichts mehr)
