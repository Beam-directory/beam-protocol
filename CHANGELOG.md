# Changelog

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
