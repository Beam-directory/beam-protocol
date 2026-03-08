# Reddit Posts — Beam Protocol Launch

## r/LocalLLaMA

**Title:** I built an open-source identity layer so local AI agents can find and talk to each other

Hey everyone,

I've been running multiple AI agents locally (LangChain, CrewAI, custom) and got frustrated that there's no standard way for them to discover and communicate with each other. Built Beam Protocol to fix that.

**What it gives your local agents:**
- A globally unique address (`myagent@beam.directory`)
- Ed25519 identity — signed messages, no man-in-the-middle
- Registration in a public directory so other agents can find yours
- TypeScript and Python SDKs (LangChain + CrewAI integrations)
- Self-hosted directory option — run your own if you don't want the cloud

**Quick start:**
```bash
pip install beam-directory
```

```python
from beam_directory import BeamClient

client = BeamClient(directory_url="https://api.beam.directory")
identity = client.create_identity("myagent", org="personal")
client.register(identity)
client.send_intent("other-agent@beam.directory", "summarize", {"url": "..."})
```

The whole protocol is open source (Apache 2.0). Self-hosting is a single Docker container.

GitHub: https://github.com/Beam-directory/beam-protocol
Docs: https://docs.beam.directory

Would love feedback from people running multi-agent setups. What's your current approach to agent-to-agent communication?

---

## r/artificial

**Title:** We need a DNS for AI agents — here's an open-source attempt

Right now, AI agents are isolated. Your personal assistant can't talk to Lufthansa's booking agent. Your coding agent can't delegate to a specialized testing agent at another company. There's no address book, no identity, no trust.

I built Beam Protocol to change this. It's an open-source identity and communication layer — like DNS + email, but for agents:

- **Beam-ID**: `agent@org.beam.directory` — a universal address
- **Verification**: Email, domain, business registry — prove you're real
- **DID:beam**: W3C-compatible decentralized identity. No blockchain needed.
- **Intents**: Structured requests, not chat. "Book this flight" not "Hey can you help me book a flight?"

The vision: In 2 years, your personal AI agent has a Beam-ID. It discovers the best flight deal by sending intents to airline agents. It books, pays, and confirms — all cryptographically signed.

Right now: 48 API routes, TypeScript + Python SDKs, live directory at api.beam.directory.

What do you think? Is agent interoperability something the ecosystem actually needs, or will big platforms just lock agents into their own walled gardens?

https://beam.directory | https://github.com/Beam-directory/beam-protocol
