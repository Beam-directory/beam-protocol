# S3: Usage-Based Pricing Model

## Problem
Flat €9-199/yr Tiers = maximal ~€228K ARR bei optimistischen Annahmen.
Nicht venture-scale. Heaviest Users zahlen gleich wie Light-Users.
€199/yr für Enterprise SLA ist absurd günstig und signalisiert "Hobby-Projekt".

## Neues Pricing: Hybrid (Tier + Usage)

### Tier 1: Free (Developer)
- 1 Agent, 100 Intents/Tag
- ⚪ Basic Verification
- Community Support
- **Ziel:** Developer Adoption, Playground

### Tier 2: Pro (€29/Monat = €348/Jahr)
- 10 Agents, 10.000 Intents/Tag
- 🔵 Email-Verified
- Beam Shield (alle 5 Walls)
- Dashboard + Analytics
- Email Support
- **+ €0.001/Intent über 10K/Tag**

### Tier 3: Business (€99/Monat = €1.188/Jahr)
- 50 Agents, 100.000 Intents/Tag
- 🟢 Business-Verified (Handelsregister)
- Custom Shield Config
- Priority Support (24h SLA)
- SSO/SAML
- **+ €0.0005/Intent über 100K/Tag**

### Tier 4: Enterprise (Custom Pricing)
- Unlimited Agents
- 🟠 Enterprise-Verified
- Dedicated Directory Instance
- SLA 99.9%
- On-Premise Option
- Dedicated Account Manager
- **Typisch €2.000-10.000/Monat**

### Revenue Projections (24 Monate)
| Scenario | Free | Pro | Business | Enterprise | Intent Fees | ARR |
|----------|------|-----|----------|------------|-------------|-----|
| Conservative | 5.000 | 200 | 30 | 3 | €50K | €170K |
| Moderate | 20.000 | 1.000 | 150 | 15 | €300K | €900K |
| Optimistic | 50.000 | 3.000 | 500 | 50 | €1.2M | €3.2M |

### Warum Hybrid?
- **Tier = Predictable Revenue** (Monthly Recurring)
- **Usage = Scales with Value** (mehr Intents = mehr Wert = mehr Zahlung)
- **Free Tier = Adoption Funnel** (100 Intents/Tag reicht zum Testen)
- **Enterprise = High-Touch Sales** (Custom, nicht Self-Serve)

### Vergleich mit Infrastruktur-Pricing
| Service | Model | ~Price |
|---------|-------|--------|
| Twilio | Per Message | $0.0075/SMS |
| Auth0 | Per Authentication | $0.003/auth |
| Stripe | Per Transaction | 2.9% + $0.30 |
| Beam (neu) | Per Intent + Tier | €0.001/intent + €29-99/mo |
| Beam (alt) | Flat Tier | €9-199/yr ← zu billig |

## Implementation
1. Stripe Products + Prices aktualisieren
2. Intent-Metering in intent_log (bereits vorhanden) → monatliche Abrechnung
3. Usage-Dashboard im Agent Dashboard
4. Billing-Alerts bei 80%/100% Limit

## Timeline: Q2 2026 (Mai, nach Entity-Gründung)
