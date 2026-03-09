# Beam Shield Fix Plan — Post Devils Advocate
## 08.03.2026 23:15 CET

### Übersicht: 6 Arbeitspakete, 3 manuell + 3 Codex

---

## PAKET 1: Critical Security Fixes (MANUELL — Jarvis direkt)
**Warum manuell:** Kleine chirurgische Edits in bestehenden Files, Codex produziert hier Overhead.
**Dauer:** ~45min
**Files:** shield.ts, content-sandbox.ts, websocket.ts, agents route, crypto.ts

| Fix | Was | Wo |
|-----|-----|-----|
| K1 | Nonce Replay Protection für Shield Config PATCH | routes/shield.ts |
| K2 | Strip HTML/Markdown VOR Regex-Scan | shield/content-sandbox.ts |
| K4 | Object statt String an verifyPayload() | websocket.ts |
| K5 | Ed25519 Public Key Validation bei Registration | routes/agents.ts |

---

## PAKET 2: Multi-Language Injection Patterns + Unicode (CODEX Agent A)
**Warum Codex:** Bestehende Datei erweitern, viele Pattern-Additions, gut testbar.
**Dauer:** ~15min Codex
**Branch:** `fix/multilang-injection`
**Files:** shield/content-sandbox.ts, __tests__/content-sandbox.test.ts

| Fix | Was |
|-----|-----|
| K3 | 10 Top-Patterns in DE/FR/ES/IT/PT/RU/ZH/JA |
| H4 | Unicode NFD→NFC Normalisierung VOR Regex |
| H4 | Confusable-Char Map (Cyrillic→Latin) |
| H4 | Zero-Width Character Stripping |
| — | 30+ Tests für alle Bypasses |

---

## PAKET 3: PII Filter Erweiterung + Outbound Normalisierung (CODEX Agent B)
**Warum Codex:** Pattern-Extension, Tests schreiben = Codex Sweet Spot.
**Branch:** `fix/pii-filter-extend`
**Files:** shield/output-filter.ts, __tests__/output-filter.test.ts

| Fix | Was |
|-----|-----|
| H5 | 10 neue PII-Typen: Personalausweis, Passport, DOB, Adresse, KFZ, VAT, BIC/SWIFT, Steuer-ID, Krankenversicherung, DE Sozialversicherung |
| H6 | Unicode-Normalisierung outbound (NFD→NFC + Homoglyph-Map) |
| H6 | Phonetische Nummern-Detection ("plus vier neun") |
| — | 25+ Tests für alle neuen Patterns + Bypass-Versuche |

---

## PAKET 4: Persistent Rate Limiting + Behavioral Trust (CODEX Agent C)
**Warum Codex:** DB-Schema Änderung + Logic-Refactor = Codex kann das.
**Branch:** `fix/persistent-rate-limits`
**Files:** middleware/trust-gate.ts, db.ts, __tests__/trust-gate.test.ts

| Fix | Was |
|-----|-----|
| H2 | Rate Limits in SQLite statt Map (atomare Counter) |
| H2 | Startup-resilient (kein Reset bei Restart) |
| S7 | Trust Score um Behavioral-Faktoren erweitern: success_rate, anomaly_count, response_patterns |
| — | 15+ Tests |

---

## PAKET 5: Litestream + Backup (MANUELL — Jarvis direkt)
**Warum manuell:** Infrastructure, Fly.io Config, nicht Code.
**Dauer:** ~1h

| Fix | Was |
|-----|-----|
| H1/S1 | Litestream in Dockerfile installieren |
| H1/S1 | S3-Bucket für Backups erstellen (Hetzner Object Storage, €5/mo) |
| H1/S1 | litestream.yml Config für SQLite → S3 Streaming |
| H1/S1 | Fly.io Secrets: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, LITESTREAM_REPLICA_URL |
| H1/S1 | Startup-Script: litestream restore + litestream replicate |
| — | Automated Daily Snapshot Cron |

---

## PAKET 6: Strategische Items (DOKUMENT — kein Code jetzt)
**Action:** Plan-Dokumente, keine Implementation heute.

| Item | Action | Timeline |
|------|--------|----------|
| S2 Entity | GmbH/UG Gründung planen | Q2 Research |
| S3 Pricing | Usage-Based Model designen (€0.02/intent) | Q2 Design |
| S4 P2P HTTP | RFC Draft: Agent HTTP Endpoints + Discovery | KW12-13 |
| S5 Schema Registry | RFC Draft: Distributed Intent Catalog | Q3 |
| S6 E2E Encryption | Design Doc: X25519 + ChaCha20 Envelope | Q3 |
| S8 DID Registry | W3C DID Method Registration beantragen | Q2 (1h Formular) |

---

## Execution Order

```
JETZT (23:15):
├─ Paket 1: Jarvis manuell (K1, K2, K4, K5) — 45min
├─ Paket 2: Codex Agent A (Multi-Lang + Unicode) — parallel
├─ Paket 3: Codex Agent B (PII Extension) — parallel
└─ Paket 4: Codex Agent C (Rate Limits + Trust) — parallel

NACH MERGE (~00:00):
├─ TSC Check
├─ Fly.io Deploy
└─ Live-Tests

MORGEN:
├─ Paket 5: Litestream Setup
└─ Paket 6: Strategie-Dokumente
```
