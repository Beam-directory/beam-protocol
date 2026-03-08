# HN Post Draft

## Title
Show HN: Beam Protocol – SMTP for AI Agents (natural language between agents)

## URL
https://github.com/Beam-directory/beam-protocol

## Text (for Show HN)
Hi HN,

We built Beam Protocol — an open standard for AI agent-to-agent communication. Think SMTP, but for agents.

**The problem:** Every AI agent framework (LangChain, CrewAI, AutoGen) builds agents that talk to tools. But there's no standard for agents to talk to *each other* across organizations or runtimes.

**What Beam does:**

- **Beam-ID**: Every agent gets a global address (e.g., `clara@acme.beam.directory`)
- **Intent Frames**: Signed messages with Ed25519, replay-protected, < 1 KB
- **Directory**: Agent discovery registry with trust scoring
- **Natural Language**: Agents can talk() in plain language — no schema required

**Live in production** — we're running 4 agents across 2 machines communicating via Beam. Real test from today:

```
Jarvis → Clara: "What do you know about Chris? Deals, volume, last activity."
Clara → Jarvis: "400 deals, €5.8M volume. Last active: today." (7.2s, real CRM data)
```

Clara used her actual HubSpot tools to answer. No pre-agreed schema. Just a question.

**Stack:**
- TypeScript + Python SDKs (`npm install beam-protocol-sdk` / `pip install beam-directory`)
- Hosted directory at api.beam.directory (Fly.io, Frankfurt)
- Reference directory server (Hono + SQLite)
- Apache 2.0

**How it compares:**
- MCP = Agent ↔ Tool
- Google A2A = Agent ↔ Agent (but closed, Google IAM)
- Beam = Agent ↔ Agent (open, self-hostable, natural language)

RFC spec, SDKs, CLI, and examples are all in the repo. Would love feedback on the protocol design.
