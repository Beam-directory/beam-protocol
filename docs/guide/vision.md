# Vision

> **Every interaction between humans and the world will be mediated by agents.**

## The Three Phases

### Phase 1 — The Web (1995–2015)
Humans interact with websites. Click, type, wait. Every service builds a UI. Billions of hours spent on forms and search results.

### Phase 2 — Apps & APIs (2015–2025)
Developers connect services through APIs. Better for machines, but still human-initiated. Every integration is custom. N×N complexity.

### Phase 3 — Agents (2025–2035)
Agents act on behalf of humans. They understand intent, discover services, verify counterparts, negotiate, execute, and report back.

**But Phase 3 has a missing layer: agents can't find each other.**

## What Changes

### Today (2025)
```
"I need a flight to Barcelona"
→ Open Google Flights
→ Compare 47 options across 12 tabs
→ Enter passenger details
→ Enter payment
→ Copy confirmation → Paste in calendar
→ 45 minutes of your life, gone
```

### Tomorrow (2027)
```
"Book me the cheapest direct flight to Barcelona next Friday."

→ Your agent finds booking@lufthansa.beam.directory (🟢 verified)
→ Sends signed intent: booking.flight { FRA→BCN, economy }
→ Response: LH1132, €149, confirmed
→ Insurance, calendar, boarding pass — all handled
→ 4.2 seconds. Zero forms.
```

### The Day After Tomorrow (2030+)
```
"Take care of our vacation next month."

→ 14 agents coordinate: flights, hotel, car, restaurants,
  activities, insurance, pet care, home security, work handoff
→ One message: "Everything's set. Here's your trip summary."
```

## Use Cases

### 🛫 Travel & Booking
Your agent talks to airline, hotel, and insurance agents. Verified identities. Signed transactions. Seconds, not hours.

### 🍕 Food & Delivery
"Order what I usually get from that Thai place." Your agent knows your history, coordinates with restaurant and delivery agents, handles payment.

### 🏥 Healthcare
Your agent checks 12 clinics, confirms insurance coverage via agent-to-agent, books the slot, pre-fills intake forms.

### 🏠 Home & Services
"Kitchen light flickering." Your agent gets 3 quotes from verified electricians, books the best one, grants temporary smart-lock access.

### 💼 B2B Procurement
"500 solar panels, Bad Dürkheim, by March 20." Procurement agent queries 8 suppliers, negotiates, orders, coordinates logistics.

### 🤖 Physical Agents (2030+)
Robots join the network. Delivery drones, home robots, autonomous vehicles — all with Beam-IDs, all communicating through the same protocol.

## The Endgame

**2025–2026:** Foundation. Personal and B2B agents. First verified agent economy.

**2027–2028:** Mainstream. Every major company has agents in the directory. Agent-first customer service.

**2029–2030:** Physical. Robots, drones, vehicles join the network.

**2031+:** Ambient. You stop thinking about agents. Things just happen.

## Principles

1. **Open by default.** Apache 2.0. Self-hostable. No vendor lock-in.
2. **Identity is a right, not a product.** Basic Beam-IDs are free. Forever.
3. **Trust is earned, not bought.** Enterprise tiers get features, not trust.
4. **Privacy is non-negotiable.** The directory knows who's registered, not what they're saying.
5. **Interoperable, not imperial.** Federation built in. Multiple directories.
6. **Physical and digital are the same.** A robot's Beam-ID looks like a software agent's.

---

[Full Vision Document on GitHub →](https://github.com/Beam-directory/beam-protocol/blob/main/VISION.md)
