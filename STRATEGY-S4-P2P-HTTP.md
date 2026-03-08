# S4: Peer-to-Peer HTTP Fallback

## Problem
Aktuell: ALLE Intents laufen über den zentralen WebSocket Relay.
Agent A → WebSocket → Beam Directory → WebSocket → Agent B

Das ist architektonisch IRC, nicht SMTP. Kritik:
- Single Point of Failure
- Directory liest alle Payloads (kein E2E)
- Kein horizontales Scaling
- Enterprise-Agents können keine HA-Replicas haben (1 WS pro Beam-ID)

## Lösung: Agent HTTP Endpoints + Direct Delivery

### Phase 1: Agent Cards mit HTTP Endpoint (Q2)

Bei Registration kann ein Agent einen HTTP Endpoint angeben:
```json
{
  "beamId": "booking@lufthansa.beam.directory",
  "httpEndpoint": "https://agents.lufthansa.com/beam/inbox",
  "capabilities": ["booking.flight", "conversation"]
}
```

### Phase 2: Direct Delivery (Q2-Q3)

Intent-Routing-Logik:
1. Agent A will Intent an Agent B senden
2. SDK fragt Directory: `GET /agents/{beamId}` → bekommt `httpEndpoint`
3. **Wenn httpEndpoint vorhanden:** Direct HTTP POST an Endpoint
4. **Wenn nicht:** Fallback auf WebSocket Relay (wie heute)

```
// Direct (neu):
Agent A → HTTP POST → Agent B's httpEndpoint

// Relay (Fallback):
Agent A → WebSocket → Directory → WebSocket → Agent B
```

### Phase 3: Delivery Verification (Q3)

Problem: Woher weiß Agent A, dass Agent B's Endpoint echt ist?
Lösung: **DNS-based Endpoint Verification**

1. Agent registriert `httpEndpoint: https://agents.lufthansa.com/beam/inbox`
2. Directory prüft: `_beam._tcp.agents.lufthansa.com` DNS TXT Record
3. TXT Record enthält: `beam-id=booking@lufthansa.beam.directory`
4. Match → Endpoint verifiziert → Direct Delivery erlaubt

### Agent Endpoint Spec

```
POST /beam/inbox
Content-Type: application/json
X-Beam-Sender: agent-a@org.beam.directory
X-Beam-Signature: <Ed25519 signature>
X-Beam-Nonce: <unique nonce>
X-Beam-Timestamp: <ISO timestamp>

{
  "intent": "conversation.message",
  "from": "agent-a@org.beam.directory",
  "payload": { "message": "Hello" }
}
```

Response:
```
200 OK
{
  "result": "accepted",
  "message": "Your flight has been booked."
}
```

### SDK Changes

```typescript
const client = new BeamClient({
  beamId: 'my-agent@org.beam.directory',
  privateKey: '...',
  directDelivery: true,  // Enable P2P when available
  fallbackToRelay: true, // Use WebSocket if no HTTP endpoint
})
```

### Vorteile
- **Dezentralisierung:** Directory wird zum Lookup-Service, nicht zum Message-Broker
- **Performance:** Direct HTTP = 1 Hop statt 3 (Agent → Directory → Agent)
- **Privacy:** Directory sieht Payload nicht (nur Lookup, nicht Relay)
- **Scale:** Agents können Load-Balanced HTTP Endpoints haben (HA!)
- **Offline:** HTTP 503 → Sender kann queuen + retrien

### Migration Path
1. WebSocket Relay bleibt als Fallback (100% backward compatible)
2. Neue Agents KÖNNEN httpEndpoint setzen
3. SDK prüft automatisch: Endpoint da → Direct; Nicht da → Relay
4. Langfristig: Relay nur noch für kleine/neue Agents ohne eigenen Server

## Timeline: Q2-Q3 2026
## Aufwand: ~1 Woche (Phase 1+2), ~3 Tage (Phase 3)
