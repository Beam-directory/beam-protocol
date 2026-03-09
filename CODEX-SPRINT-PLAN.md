# Beam Protocol — Codex Sprint Plan
## Basierend auf Devils Advocate Report V2 (09.03.2026)

Alle 3 Analysten (Enterprise Buyer, DevRel, UX Researcher) sind sich einig: Beam ist ein Prototyp, kein Launch-Ready Product. Dieser Sprint fixt die P0-Items die alle 3 identisch genannt haben.

---

## Sprint Scope: P0 Fixes (1-2 Tage)

### 1. 🔴 Echo-Agent (`echo@beam.directory`) — 4h
**Was:** Ein permanent laufender Echo-Agent auf dem Directory Server, der jede eingehende Nachricht zurückspiegelt.
**Warum:** Ohne zweiten Agent kann niemand Beam testen. Wie SMS ohne zweites Telefon.
**Tasks:**
- Neues Package `packages/echo-agent/` erstellen
- Auto-registriert sich als `echo@beam.directory` beim Start
- Unterstützt alle Intents: `conversation.message` → Echo zurück, `booking.*` → Mock Response
- Health-Endpoint `/echo/health`
- In `packages/directory/` als optionalen built-in Agent integrieren (Env-Flag `ECHO_AGENT=true`)
- README mit Beispiel: `beam talk echo@beam.directory "Hello Beam!"`

### 2. 🔴 Post-Registration Onboarding — 4h
**Was:** Nach erfolgreicher Agent-Registration zeigt die Success-Seite sofort nutzbaren Code.
**Warum:** Aktuell: Registration → NICHTS. Drop-off geschätzt 90-95%.
**Tasks:**
- `packages/register/index.html` → Success-Screen erweitern:
  - Copy-Button mit Beam-ID
  - 5-Zeilen Quick-Start Code (TypeScript + Python)
  - "Test your agent now" Link zum Echo-Agent
  - "Open Dashboard" Button
- `packages/public-site/register.html` → gleiche Verbesserungen

### 3. 🔴 CI Fix on Main — 2h
**Was:** GitHub Actions CI muss grün sein.
**Warum:** Failing CI = "#1 red flag für Open Source" (DevRel Analyst). Signalisiert "abandoned".
**Tasks:**
- `.github/workflows/ci.yml` prüfen und fixen
- Alle Tests in `packages/sdk-typescript` + `packages/directory` müssen passing sein
- Sicherstellen dass Build auf Node 20 + 22 funktioniert
- Badge in README muss grün anzeigen

### 4. 🔴 Docs SSL Fix — 1h
**Was:** `docs.beam.directory` hat SSL-Zertifikatfehler (ERR_CERT_COMMON_NAME_INVALID).
**Warum:** Security-Protokoll-Docs über HTTP = Ironie und Vertrauens-Killer.
**Tasks:**
- `.github/workflows/docs.yml` prüfen — VitePress Deploy
- Wenn GitHub Pages: Custom Domain SSL in Repo Settings
- Wenn Vercel/andere: DNS + SSL Cert prüfen
- Test: `curl -I https://docs.beam.directory` muss 200 zurückgeben

### 5. 🔴 Pricing Vereinheitlichung — 1h
**Was:** README sagt "Verified €9/year, Business €49/year", Landing Page sagt "Pro €29/month, Business €99/month". Faktor 38x.
**Warum:** Inkonsistenz = Unseriosität.
**Tasks:**
- `README.md` Pricing-Sektion auf die aktuellen Landing-Page-Preise angleichen
- Oder Landing Page auf README-Preise angleichen (Tobias entscheidet)
- CTA-Buttons in Pricing Cards auf Landing Page hinzufügen (falls fehlend)

### 6. 🔴 Landing Page Visual Bugs — 2h
**Was:** Schwarze/leere Sektionen (CSS `.fade-up { opacity: 0 }` ohne Scroll-Trigger-JS).
**Warum:** "Bounce Rate geschätzt: 60-70% allein durch visuellen Eindruck" (UX Researcher).
**Tasks:**
- `packages/public-site/styles.css` → fade-up Animation fixen oder entfernen
- Directory Widget: "Could not load agents" Error durch Fallback-State ersetzen
- "4 Live Agents" counter mit echtem Health-Check verbinden oder statisch machen
- Mobile Rendering testen und fixen

---

## P1 Backlog (nach Sprint)
- Web Playground ("Try Beam in browser") — 2d
- API Key auth (simple key neben Ed25519) — 2d  
- Privacy Policy + ToS — 4h
- Status Page (BetterStack/UptimeRobot) — 2h
- Auto-Onboarding Email Sequence — 1d

## P3 Enterprise (Later)
- Multi-region HA
- PostgreSQL Migration
- SOC 2 Type II (3-6 Monate)
- SSO/SAML + RBAC

---

## Codex Instructions
**Repo:** `/Users/tobik/.openclaw/workspace/projects/beam-protocol`
**Monorepo:** npm workspaces, packages in `packages/`
**Stack:** TypeScript, Hono (server), Vite (dashboard), VitePress (docs), better-sqlite3
**Node:** >=18, Tests: Vitest (SDK), node:test (Directory)
**DO NOT** touch `.env` files or secrets.
**DO NOT** deploy anything — only code changes + local test.
**Commit granular** — one commit per fix item.
