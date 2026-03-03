# Beam Directory — 30-Tage-Sprint

*Start: 04.03.2026 | Deadline: 03.04.2026*
*Ziel: Von "Code auf GitHub" zu "Produkt das Leute nutzen können"*

---

## Woche 1 (04.-10.03) — Foundation

### Tag 1-2: Developer Experience
- [ ] `npm publish @beam-protocol/sdk` auf npmjs.com
- [ ] Python SDK bauen (`pip install beam-directory`)
- [ ] CLI Tool: `beam init`, `beam register`, `beam send`, `beam lookup`

### Tag 3-4: Landing Page + Docs
- [ ] Landing Page auf beam.directory deployen (Vercel/Cloudflare Pages)
- [ ] Docs-Seite: Getting Started, API Reference, Concepts
- [ ] getbeam.de → Redirect auf beam.directory

### Tag 5: Dogfood Start
- [ ] Beam Directory Server auf Hetzner/Fly.io deployen (Produktion)
- [ ] COPPEN Agents registrieren: jarvis, fischer, clara
- [ ] Erster echter Intent: Fischer fragt Jarvis nach Kundendaten

---

## Woche 2 (11.-17.03) — Produkt

### Tag 6-7: Dashboard + Analytics
- [ ] Web Dashboard auf beam.directory/dashboard
- [ ] Agent-Übersicht: Registrierte Agents, Trust Scores, Status
- [ ] Intent-Log: Wer hat wem was geschickt, Latenz, Errors

### Tag 8-9: Verification Flow
- [ ] Org-Verification: Domain-Ownership via DNS TXT Record
- [ ] Verified Badge (✅) im Directory + Dashboard
- [ ] COPPEN als erste verifizierte Org

### Tag 10: Security Hardening
- [ ] Rate Limiting (produktionsreif)
- [ ] TLS everywhere
- [ ] Nonce-Dedup mit Redis/SQLite TTL
- [ ] Abuse Prevention (Max Agents pro Org im Free Tier)

---

## Woche 3 (18.-24.03) — Community

### Tag 11-12: Content + Launch Prep
- [ ] Blog Post: "Why we built SMTP for AI Agents" (beam.directory/blog)
- [ ] Twitter/X Thread: Problem → Solution → Demo
- [ ] README mit GIF/Video: 30-Sekunden-Demo

### Tag 13-14: Community Outreach
- [ ] Hacker News: "Show HN: Beam Directory — SMTP for AI Agents"
- [ ] Reddit: r/artificial, r/MachineLearning, r/LocalLLaMA
- [ ] OpenClaw Discord: Announce + Integration Guide
- [ ] ProductHunt Listing vorbereiten

### Tag 15: First External User
- [ ] 3-5 OpenClaw-User identifizieren die Agent-Fleets haben
- [ ] Persönliche Einladung: "Registrier deine Agents, wir helfen beim Setup"
- [ ] Onboarding-Flow: `npx create-beam-agent` oder ähnlich

---

## Woche 4 (25.-31.03) — Scale

### Tag 16-17: Federation Groundwork
- [ ] Multi-Directory Discovery Spec (RFC Amendment)
- [ ] Cross-Org Intent Routing testen (COPPEN → External Org)

### Tag 18-19: Monetization Infrastructure
- [ ] Stripe Integration für Starter/Pro Plans
- [ ] Usage Tracking (Intent-Zähler pro Org)
- [ ] Pricing Page auf beam.directory/pricing

### Tag 20: Waitlist + Signup
- [ ] Self-Service Signup: E-Mail → API Key → `beam register`
- [ ] Waitlist für Pro/Enterprise
- [ ] Newsletter-Setup für Updates

---

## Erfolgsmetriken (Tag 30)

| Metrik | Ziel |
|---|---|
| Registrierte Agents | ≥50 |
| Registrierte Orgs | ≥10 |
| Externe Orgs (nicht COPPEN) | ≥3 |
| npm Downloads | ≥500 |
| GitHub Stars | ≥100 |
| HN Upvotes | ≥50 |
| Erster zahlender Kunde | Nice-to-have |

---

## Ressourcen

| Was | Wer |
|---|---|
| SDK + CLI + Server | Jarvis (Coding) |
| Landing Page | Jarvis (Lovable oder local) |
| Content (Blog, Twitter) | Jarvis Draft → Tobias Review |
| Community Outreach | Tobias (persönlich) |
| Stripe + Billing | Jarvis |
| Architektur-Entscheidungen | Zusammen |

---

## Regeln

1. **Kein Feature Creep.** Nur was auf dieser Liste steht
2. **Ship daily.** Jeden Tag mindestens 1 Commit
3. **Dogfood first.** Nichts releasen was wir nicht selbst nutzen
4. **Feedback > Perfektion.** Lieber v0.1 live als v1.0 in der Schublade

---

*"Beam ist nicht fertig wenn alles drin ist. Beam ist fertig wenn Agents miteinander reden."*
