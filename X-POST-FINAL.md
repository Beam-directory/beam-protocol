# X Post — Beam Protocol Release

## Post Text

We just open-sourced Beam Protocol.

It gives every AI agent an address.

Like email gave every person an address (tobias@company.com), Beam gives every AI agent an address (jarvis@coppen.beam.directory). That's it. That's the core idea.

Here's the problem we solved:

We run 15 AI agents at our company. Different frameworks, different models, different machines. They're brilliant individually — but they can't talk to each other. Agent A can't ask Agent B to check a payment. Agent C can't escalate to Agent A when it's stuck.

Every agent platform is a silo. LangChain agents can't talk to CrewAI agents. OpenAI agents can't talk to Anthropic agents. There's no phone book. No shared protocol. No way to just say "hey, send this to Fischer."

So we built one.

Beam Protocol has 3 parts:

𝟏. 𝐁𝐞𝐚𝐦-𝐈𝐃 — A universal agent address
agent@org.beam.directory
Like an email address, but for AI agents.

𝟐. 𝐈𝐧𝐭𝐞𝐧𝐭 𝐅𝐫𝐚𝐦𝐞𝐬 — Structured messages
Small (<1KB) typed messages like `payment.status_check` or `escalation.request`. No free-text chaos. Agent A says what it wants, Agent B responds. Clean contracts.

𝟑. 𝐃𝐢𝐫𝐞𝐜𝐭𝐨𝐫𝐲 — The phone book
A registry where agents register, discover each other, and exchange messages in real-time via WebSocket.

It's live. Right now. In production.

4 agents registered. 7 intent types. Jarvis→Fischer in 6.7 seconds. End-to-end, including the agent thinking about the response.

The code is 3 lines to send your first intent:

```
const client = new BeamClient({ identity, directory });
await client.connect();
await client.send('fischer@coppen.beam.directory', 'payment.status_check', { invoiceId: 'INV-2024-001' });
```

Google has A2A. Anthropic has MCP. Both are great — but they solve different problems. A2A is enterprise orchestration. MCP is tool integration. Neither gives you a simple way to say: "Send this message from Agent A to Agent B."

Beam is SMTP for agents. The simplest possible protocol to make two agents talk to each other.

We built it because we needed it. Now it's open source (Apache 2.0) because everyone else needs it too.

→ beam.directory
→ github.com/Beam-directory/beam-protocol

If you're running multiple AI agents and they can't talk to each other — that's the problem we solved.

---

## Image

Attach: beam.directory OG image or fresh screenshot of the website

## Hashtags (in reply)

#BeamProtocol #AIAgents #OpenSource #AgentToAgent #A2A #AI #BuildInPublic
