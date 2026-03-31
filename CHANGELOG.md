# Changelog

## v0.8.0 (draft)

### Buyer Path
- keep Beam on one plain-language path: landing page -> guided evaluation -> hosted pilot request
- treat hosted beta as a guided design-partner engagement around one narrow workflow

### Operator Workflow
- tighten alert, dead-letter, and recovery shortcuts around owner and next action
- add first-party funnel analytics and repo-visible dry-run evidence for buyer and operator flows
- fix live CORS allowlists for the real dashboard production URL on both Directory and Message Bus
- enable live admin magic-link delivery for the real dashboard with explicit admin emails, dashboard URL, and Resend-backed delivery

### Release Control
- add repo-visible `0.8.0` dry-run reports, cut checklist, and release-notes draft
- record the live operator-auth fix and keep `0.8.0` gated behind one final integrated cut pass

## v0.7.0 (2026-03-30)

### Hosted Beta
- align Beam around a hosted beta for verified B2B handoffs instead of an open-ended protocol pitch
- keep landing page, hosted beta intake, quickstart, docs, and demo flow on the same hosted evaluation path

### Operator Workflow
- add a dedicated hosted-beta request queue with stable request status, owner, notes, and export surfaces
- improve operator-facing proof across trace, audit, alerts, dead letters, and hosted-beta review

### Reliability and Security
- harden retries, dead-letter handling, restart recovery, key lifecycle, and abuse controls for the hosted-beta baseline
- keep cross-stack compatibility fixtures and test coverage across directory, CLI, TypeScript SDK, Python SDK, and message bus

### Release Control
- add repo-visible RC and cut artifacts for `0.7.0`
- expose live release truth on the API, status page, dashboard, SDK, and CLI so deploy drift is visible before tagging

### Compatibility Note
- No protocol-family change in this release train. Beam `0.7.0` remains on `beam/1`.

## v0.6.1 (2026-03-30)

### Quickstart
- fix the hosted quickstart bootstrap so the `echo-agent` Docker build installs the local `beam-protocol-sdk` tarball from the repo instead of requiring a pre-published npm version
- keep the local quickstart reproducible before the npm publish step runs in CI

## v0.6.0 (2026-03-30)

### Release Direction
- narrow Beam onboarding around one verified B2B workflow: Acme procurement -> Northwind partner desk -> Northwind warehouse
- align README, docs landing, getting started, examples, and public-site copy around the same handoff story

### Compatibility
- document the `beam/1` compatibility contract across protocol, directory, CLI, TypeScript SDK, and Python SDK
- make schema evolution rules explicit: additive fields only, ignore unknown fields, `payload` canonical with legacy `params` alias
- add shared compatibility fixtures and parser regression tests

### Dogfood and Operations
- add a reproducible partner-handoff dogfood run
- publish a 0.6.0 release-readiness report with concrete findings, risks, and follow-ups

### Compatibility Note
- No protocol-family change in this release train. Beam 0.6 remains on `beam/1`.

## v0.5.2 (2026-03-28)

- fix monorepo release readiness and workspace build ordering
- harden CI for Node 20/22 and reliable directory test execution
- clean up package metadata, docs, and publish-path version consistency

## v0.5.1 (2026-03-08)

### 🆔 DID Identity System
- `did:beam:tobias` (personal), `did:beam:lufthansa:booking` (org-bound), `did:beam:z6Mk...` (key-based)
- W3C DID v1.1 compatible — Ed25519VerificationKey2020, no blockchain
- DID resolution via `GET /agents/did/:didString`
- Directory issuer DID: `did:beam:beam:directory`
- Verifiable Credentials: Email, Domain, Business — all W3C VC format

### ✅ Verification Tiers
- Email verification via Resend API (SMTP fallback)
- Domain verification via DNS TXT records
- Business verification: DE (Handelsregister HRB/HRA) + UK (Companies House API)
- 4 tiers: Basic ⚪, Verified 🔵, Business 🟢, Enterprise 🟠

### 🔑 Consumer Key Management (SDK)
- AES-256-GCM encrypted export/import with PBKDF2 key derivation
- BIP-39 12-word recovery phrase generation and recovery
- QR code data format for mobile identity transfer

### 💳 Stripe Billing
- `POST /billing/checkout` — creates Stripe Checkout session for tier upgrades
- Webhook handler: auto-upgrade verification tier on payment
- Subscription management: cancel → auto-downgrade

### 🌐 Public Website
- New beam.directory with agent directory, live search, verification pricing
- Self-registration UI (vanilla HTML+JS, Ed25519 key gen in browser)
- Mobile-responsive with hamburger menu

### 🔧 Production Fixes
- All 10 route files now mounted in server.ts (credentials, DID, federation were dead code)
- Deduplicated route mounts
- `.dockerignore` for native module isolation (better-sqlite3 arm64/amd64)
- `ensureColumn` before queries, `CREATE INDEX` after `ensureColumn`
- `catalog.yaml` try/catch resilience in all 3 files
- Persistent SQLite volume on Fly.io

### 📦 Packages Published
- npm: `beam-protocol-sdk@0.5.1`, `beam-protocol-cli@0.5.1`
- PyPI: `beam-directory@0.5.1`, `beam-langchain@0.5.1`, `beam-crewai@0.5.1`

---

## v0.5.0 (2026-03-08)

### Features
- Public Directory on Fly.io Frankfurt
- Dashboard v2 on Vercel
- Federation protocol (RFC-0002)
- SDK v0.5.0 with DID and credentials support
- 17 parallel Codex agents built this release

---

## v0.3.0 (2026-03-07)

### Features
- 64 vitest tests across 7 files
- GitHub Actions CI + Docker deploy
- Dynamic trust scores, auto-reconnect, multi-org support
- VitePress documentation site (11 pages)
- RFC-0002 Federation draft

---

## v0.2.2 (2026-03-06)

### Features
- Initial npm publish with actual dist files
- CLI with init/send/lookup/register commands
- Python SDK on PyPI
- LangChain and CrewAI integrations

---

## v0.1.0 (2026-03-04)

### Initial Release
- Beam-ID system
- Intent/Result frame specification (RFC-0001)
- Ed25519 signature verification
- Self-hosted directory server
- Live E2E test: 4 agents, 25.8s roundtrip
