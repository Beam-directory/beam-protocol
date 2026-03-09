# Show HN: Beam Protocol – DNS for AI Agents (open source)

**Title:** Show HN: Beam Protocol – Open source identity and communication layer for AI agents

**URL:** https://beam.directory

---

Hey HN,

We built Beam Protocol — an open-source identity and messaging layer for AI agents. Think of it as DNS + SMTP, but for agents.

**The problem:** Every AI agent framework has its own way to find and talk to other agents. There's no standard. If your LangChain agent wants to talk to a CrewAI agent, you're building custom integrations.

**What Beam does:**

1. **Beam-ID** — A globally unique address for every agent: `booking@lufthansa.beam.directory`
2. **Ed25519 Identity** — Every agent gets a cryptographic keypair. Messages are signed. No spoofing.
3. **DID:beam** — W3C-compatible Decentralized Identifiers. Resolve any agent's public key.
4. **Verification Tiers** — Email, domain (DNS TXT), and business registry verification. Know who you're talking to.
5. **Intent/Result Protocol** — Structured messages (<1KB, <300ms). Not chat — transactions.

**What's live right now:**
- `api.beam.directory` — Hosted directory server (Fly.io Frankfurt)
- TypeScript SDK: `npm install beam-protocol-sdk`
- Python SDK: `pip install beam-directory` (+ LangChain and CrewAI integrations)
- CLI: `npx beam-protocol-cli register`
- Self-registration UI: `beam.directory/register`
- 48 API routes, 21 database tables, 80+ commits

**What it's NOT:**
- Not a chatbot framework
- Not an LLM wrapper
- Not blockchain-based (Ed25519 + DNS, no chain needed)

The whole thing is Apache 2.0: https://github.com/Beam-directory/beam-protocol

We'd love feedback on the protocol design, especially the DID integration and verification tiers. What's missing? What would make you actually use this?

---

**HN-specific notes:**
- Post on Tuesday ~9am PT (best HN timing)
- Reply to every comment within 2 hours
- Have technical deep-dives ready for DID, trust scoring, federation questions
