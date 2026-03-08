# S8: W3C DID Method Registry Eintrag

## Problem
`did:beam` ist implementiert und funktioniert, aber nicht im offiziellen W3C DID Method Registry.
Das bedeutet: Kein universeller DID Resolver kann did:beam auflösen.

## Was ist das DID Method Registry?
- GitHub Repo: https://github.com/w3c/did-spec-registries
- Enthält alle registrierten DID Methods (did:web, did:key, did:ethr, etc.)
- Registration = Pull Request mit Method-Spec
- Kein Review-Prozess, keine Kosten, Self-Service

## Was wir brauchen

### 1. DID Method Specification Document
Datei: `spec/did-beam-method.md` (bereits teilweise in DID-IDENTITY-DESIGN.md)

Muss enthalten:
- Method Name: `beam`
- Method-Specific Identifier: `<org>:<agent>` oder `<agent>`
- CRUD Operations (Create, Read, Update, Deactivate)
- Security Considerations
- Privacy Considerations
- Reference Implementation URL

### 2. Pull Request an w3c/did-spec-registries

```json
{
  "beam": {
    "status": "provisional",
    "verifiableDataRegistry": "Beam Directory (beam.directory)",
    "specification": "https://docs.beam.directory/security/did-beam-method"
  }
}
```

### 3. DNS-based DID Resolution (Fallback)
Für Interop mit Universal Resolver:
```
did:beam:coppen:jarvis
  → HTTPS: GET https://api.beam.directory/did/did:beam:coppen:jarvis
  → DNS Fallback: TXT _did.jarvis.coppen.beam.directory
```

## Implementation Steps
1. `spec/did-beam-method.md` schreiben (aus DID-IDENTITY-DESIGN.md extrahieren)
2. Auf docs.beam.directory publishen
3. PR an https://github.com/w3c/did-spec-registries
4. Universal Resolver Driver bauen (Optional, Docker Container)

## Timeline: Q2 2026 (1h für PR, 1 Tag für Spec-Dokument)
## Kosten: €0
## Impact: Legitimität + Interoperabilität mit dem gesamten DID-Ökosystem
