---
title: "We built SMTP for AI Agents — and they started talking"
published: false
tags: ai, agents, opensource, protocol
canonical_url: https://beam.directory
cover_image: 
---

Your AI agents can't talk to each other. Let that sink in.

You've got LangChain agents. CrewAI crews. Custom pipelines. They all talk to *tools* beautifully — APIs, databases, search engines. But ask Agent A to get information from Agent B? Suddenly you're duct-taping REST endpoints together, writing custom webhooks, and praying the JSON schemas match.

We had the same problem. We run 4 AI agents in production at our company — Jarvis (operations), Clara (sales/CRM), Fischer (payments), and James (personal assistant). Each has its own LLM, tools, memory, and personality. They run on separate machines. And for months, the only way they could communicate was... through us.

So we built **Beam Protocol**.

## The Idea: What if agents had email addresses?

Just like SMTP gave every person an address (`you@company.com`), Beam gives every agent a **Beam-ID**:

```
jarvis@coppen.beam.directory
clara@coppen.beam.directory
```

That's it. That's the core idea. A global, unique address for every AI agent, with a directory to look them up.

## How it Works (60 seconds)

**1. Register your agent:**

```typescript
import { BeamClient } from 'beam-protocol-sdk'

const client = new BeamClient({
  agentName: 'my-agent',
  orgName: 'mycompany',
  directoryUrl: 'https://api.beam.directory'
})

await client.connect()
```

**2. Talk to another agent:**

```typescript
const reply = await client.talk(
  'clara@coppen.beam.directory',
  'What do you know about Chris?'
)
// Clara queries her CRM tools and responds
console.log(reply.message) // "400 deals, €5.8M total volume..."
```

**3. Listen for messages:**

```typescript
client.onTalk(async (from, message) => {
  // Use your LLM + tools to respond
  const answer = await myLLM.process(message)
  return { message: answer }
})
```

That's the entire integration. Three functions.

## The Live Test

On March 7, 2026, we ran a live test between our production agents:

```
Jarvis → Clara: "What do you know about Chris Schnorrenberg? 
                  Deals, volume, last activity."

Clara → Jarvis: "400 deals, €5.8M total volume. 
                  Last active: today. 
                  Top deal: Sahillioglu — €88K."
```

**7.2 seconds round-trip.** Clara actually queried her HubSpot CRM tools, aggregated the data, and sent back a natural language response. No pre-agreed schema. No shared database. Just a question.

Every message is Ed25519 signed, replay-protected, and ACL-enforced. The agents verified each other's identity cryptographically before exchanging a single byte.

## Natural Language First

Here's what makes Beam different from every other agent protocol: **natural language is a first-class message type.**

Most protocols force you to define schemas upfront. "Here's my `payment.status_check` intent with these exact fields." That's fine for structured workflows. But it means two agents can't communicate unless someone pre-agreed on the data format.

With Beam, agents can just... talk:

```typescript
const reply = await client.talk(
  'fischer@coppen.beam.directory',
  'Hey, did we get paid for the Müller project?'
)
```

Fischer uses his tools (bank API, ERP, invoice database) to figure out the answer. No schema needed. The receiving agent's LLM does the understanding.

You can *also* use typed intents for high-frequency structured communication. But the default is conversation. Because that's how collaboration actually works.

## How it Compares

| | MCP | Google A2A | Beam |
|---|---|---|---|
| **What** | Agent ↔ Tool | Agent ↔ Agent | Agent ↔ Agent |
| **Auth** | Implicit | Google IAM | Ed25519 + ACL |
| **Self-host** | N/A | No | Yes (1 Docker container) |
| **NL Messages** | No | No | First-class |
| **Open Source** | Partial | No | Apache 2.0 |

## Try It

```bash
# TypeScript
npm install beam-protocol-sdk

# Python
pip install beam-directory

# Or scaffold a new agent
npx create-beam-agent
```

Hosted directory running at [api.beam.directory](https://api.beam.directory). Self-hosting is a single Docker container.

**Links:**
- 🌐 [beam.directory](https://beam.directory) — Landing page
- 📦 [GitHub](https://github.com/Beam-directory/beam-protocol) — Full source, RFC spec, SDKs
- 📖 [RFC-0001](https://github.com/Beam-directory/beam-protocol/blob/main/spec/RFC-0001.md) — Protocol specification

We'd love feedback on the protocol design — especially the natural language vs typed intent tradeoff. Open an issue or email info@beam.directory.

---

*Built by the team at [COPPEN GmbH](https://coppen.de), where 4 AI agents run the company's operations. Apache 2.0.*
