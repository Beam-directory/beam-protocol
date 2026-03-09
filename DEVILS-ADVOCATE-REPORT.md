# Devils Advocate Report — Beam Protocol
## Konsolidiert aus 3 Opus-Analysten | 08.03.2026

---

# 🔴 KRITISCH (Diese Woche fixen)

## K1: Shield Config Replay Attack
**Quelle:** Security Researcher
**Problem:** `PATCH /shield/config/:beamId` prüft Ed25519-Signatur, aber Nonce wird NICHT in DB gespeichert. Gleiche Signatur+Nonce kann endlos replayed werden → Angreifer kann Shield-Config zurücksetzen.
**Fix:** `recordNonce()` nach Signatur-Validierung aufrufen.
**Aufwand:** 30min | **Impact:** HIGH

## K2: HTML-Wrapped Injections bypassen alle 23 Patterns
**Quelle:** Security Researcher
**Problem:** `sanitizeExternalMessage()` läuft Regex VOR `stripHtmlAndMarkdown()`. HTML-Tags brechen Regex: `<span>igno</span><span>re previous instructions</span>` → Regex sieht "igno" und "re previous" getrennt.
**Fix:** Reihenfolge umkehren — erst strip, dann scan.
**Aufwand:** 15min | **Impact:** CRITICAL

## K3: Content Sandbox nur Englisch
**Quelle:** Security Researcher
**Problem:** Alle 23 Patterns sind nur Englisch. Deutsch, Französisch, Japanisch → 0% Detection.
**Fix:** Top-10 Patterns in DE/FR/ES/IT/PT + Unicode-Normalisierung (NFD→NFC, Homoglyph-Map).
**Aufwand:** 2h | **Impact:** HIGH

## K4: Signature Double-Encoding Bug
**Quelle:** Security Researcher
**Problem:** `verifyIntentSignature()` → `JSON.stringify({...})` → String → `verifyPayload()` → `canonicalizeJson(string)` = doppelt encoded. Funktioniert nur weil SDK denselben Bug hat. Drittanbieter-SDKs werden scheitern.
**Fix:** Object statt String an `verifyPayload()` übergeben.
**Aufwand:** 1h (+ SDK-Update) | **Impact:** HIGH

## K5: Keine Public Key Validierung bei Registration
**Quelle:** Security Researcher
**Problem:** `publicKey` wird als beliebiger String akzeptiert. Jemand kann `publicKey: "lol"` registrieren → Namespace-Pollution, DB-Verschwendung.
**Fix:** Ed25519 SPKI Parse-Check bei Registration. Reject wenn `createPublicKey()` fehlschlägt.
**Aufwand:** 30min | **Impact:** MEDIUM

---

# 🟡 HOCH (Nächste 2 Wochen)

## H1: SQLite = Single Point of Failure
**Quelle:** VC + Competitor
**Problem:** Eine SQLite-Datei auf einem Fly.io Volume = das gesamte Beam Netzwerk. Kein Failover, keine Replikation, kein Backup-Strategy.
**Fix Phase 1:** Litestream (SQLite → S3 Streaming Replication). Automated daily backups.
**Fix Phase 2:** Turso/LibSQL für Multi-Region Read-Replicas.
**Aufwand:** 1 Tag (Litestream) | **Impact:** EXISTENTIAL

## H2: In-Memory Rate Limiting
**Quelle:** Security + Competitor
**Problem:** `senderRateCounts = new Map()` — Restart = alle Limits weg. Multi-Instance = pro-Instance Limits (trivial umgehbar).
**Fix:** Rate Limits in SQLite (oder Redis wenn Scale nötig). Atomare Counter.
**Aufwand:** 2h | **Impact:** HIGH

## H3: WebSocket Single-Connection Limit
**Quelle:** Competitor
**Problem:** Ein WebSocket pro Beam-ID. Agent mit 3 Replicas? Nur eine verbindet. HA unmöglich.
**Fix:** Connection-Pool pro Beam-ID (Round-Robin oder Broadcast an alle Connections).
**Aufwand:** 4h | **Impact:** HIGH für Enterprise

## H4: Unicode/Homoglyph Injection Bypasses
**Quelle:** Security Researcher
**Problem:** Cyrillic а/о, Zero-Width Spaces, Soft Hyphens → alle Patterns umgehbar.
**Fix:** Unicode-Normalisierung + Confusable-Detection (ICU + Unicode Confusables Table) VOR Regex.
**Aufwand:** 3h | **Impact:** HIGH

## H5: PII Filter Lücken
**Quelle:** Security Researcher
**Problem:** Fehlend: Personalausweis, Passport, Geburtsdaten, Adressen, KFZ-Kennzeichen, VAT-IDs, BIC/SWIFT. Phonetische Umgehung ("plus vier neun...").
**Fix:** 10 weitere Pattern-Typen + Natural-Language PII Heuristic.
**Aufwand:** 3h | **Impact:** MEDIUM

## H6: Output Filter — Encoded Exfiltration
**Quelle:** Security Researcher
**Problem:** Homoglyph-Encoding, Steganographie (Zero-Width), phonetische Buchstabierung → PII-Filter umgehbar.
**Fix:** Unicode-Normalisierung outbound + Pattern für "spelled out" Numbers. Long-term: LLM Classifier.
**Aufwand:** 2h (Normalisierung) | **Impact:** MEDIUM

---

# 🔵 STRATEGISCH (Diesen Monat)

## S1: Litestream + Automated Backups
Siehe H1. Existenzielle Infrastruktur-Lücke.

## S2: Dedicated Entity / Foundation
**Quelle:** VC + Competitor
**Problem:** Side-Project eines Solar-CEOs → kein Enterprise-Vertrauen.
**Fix:** Beam Protocol UG oder GmbH gründen. Oder Linux Foundation / Apache Incubator bewerben.
**Timeline:** Q2 2026

## S3: Usage-Based Pricing
**Quelle:** VC
**Problem:** €9-199/yr Flat = maximal €228K ARR. Nicht venture-scale.
**Fix:** Per-Intent-Fee (€0.02) + Verification-as-a-Service. Freemium → Usage-based.
**Timeline:** Q2 2026

## S4: Peer-to-Peer HTTP Fallback
**Quelle:** Competitor
**Problem:** Alles läuft über WebSocket Relay = zentraler Broker, nicht P2P.
**Fix:** Agent Cards mit HTTP Endpoint. Direkter HTTP POST Agent→Agent. WebSocket als Optimierung, nicht Pflicht.
**Timeline:** Q2 2026

## S5: Schema Registry + Capability Negotiation
**Quelle:** Competitor
**Problem:** Kein Intent-Schema-Discovery. Keine Versionierung. Keine Kompatibilitätsprüfung.
**Fix:** Intent Catalog als verteiltes Registry mit JSON Schema + Semver.
**Timeline:** Q3 2026

## S6: E2E Encryption
**Quelle:** Security
**Problem:** Directory liest alle Payloads. Kein E2E.
**Fix:** X25519 Key Agreement + ChaCha20-Poly1305 für Payload-Encryption. Envelope bleibt klar.
**Timeline:** Q3 2026

## S7: Trust Score Behavior-Based
**Quelle:** Security
**Problem:** Trust Score = attribute-basiert (Tier + Age). Kein Verhalten. Sybil-angreifbar.
**Fix:** Behavioral scoring: success rate, response patterns, anomaly history.
**Timeline:** Q2 2026

## S8: DID Method Registry
**Quelle:** VC + Competitor
**Problem:** `did:beam` ist nicht im W3C DID Method Registry.
**Fix:** Formal registration beantragen (kostenlos, Open Process).
**Timeline:** Q2 2026

---

# ✅ WAS GUT IST (laut allen 3 Analysten)

1. **Security Architecture** — 5-Wall Beam Shield ist besser als alles was MCP oder A2A hat
2. **Identity Model** — Email-like Addresses + Ed25519 + DID + Verification Tiers = genuinely differenziert
3. **Natural Language First** — Richtiger Insight für LLM-Zeitalter (aber braucht Schema-Fallback)
4. **Developer Experience** — SDKs, CLI, Scaffolder, LangChain/CrewAI Integration
5. **Landing Page** — "Besser als die meisten Series A Companies" (VC)
6. **It's Real** — Kein Vaporware. Live API, Live Agents, Live E2E Tests

---

# 📊 PRIORITÄTS-MATRIX

| # | Task | Aufwand | Impact | Wann |
|---|------|---------|--------|------|
| K2 | HTML Strip vor Regex | 15min | CRITICAL | SOFORT |
| K1 | Shield Config Nonce Replay Fix | 30min | HIGH | SOFORT |
| K4 | Signature Double-Encoding Fix | 1h | HIGH | SOFORT |
| K5 | Public Key Validation | 30min | MEDIUM | SOFORT |
| K3 | Multi-Language Injection Patterns | 2h | HIGH | Diese Woche |
| H1 | Litestream Backup | 1 Tag | EXISTENTIAL | Diese Woche |
| H2 | Persistent Rate Limiting | 2h | HIGH | Diese Woche |
| H4 | Unicode Normalisierung | 3h | HIGH | Diese Woche |
| H3 | Multi-WS per Agent | 4h | HIGH | Nächste Woche |
| H5 | PII Pattern Erweiterung | 3h | MEDIUM | Nächste Woche |
| H6 | Outbound Unicode Normalisierung | 2h | MEDIUM | Nächste Woche |
| S1 | Litestream Setup | 1 Tag | EXISTENTIAL | Diese Woche |
| S7 | Behavioral Trust Score | 3 Tage | HIGH | KW11-12 |
| S4 | P2P HTTP Fallback | 1 Woche | HIGH | KW12-13 |
| S2 | Entity/Foundation | — | STRATEGIC | Q2 |
| S3 | Usage-Based Pricing | 3 Tage | STRATEGIC | Q2 |
| S5 | Schema Registry | 1 Woche | MEDIUM | Q3 |
| S6 | E2E Encryption | 1 Woche | HIGH | Q3 |
| S8 | DID Method Registry | 1h | MEDIUM | Q2 |
