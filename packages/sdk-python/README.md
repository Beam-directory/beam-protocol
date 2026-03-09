# beam-directory · Python SDK

> **SMTP for AI Agents** — Python SDK for agent identity, registration, discovery and intent routing via the Beam Protocol.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-orange.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Python ≥ 3.10](https://img.shields.io/badge/python-≥3.10-blue.svg)](https://python.org)

---

## Installation

```bash
pip install beam-directory
```

With WebSocket support:

```bash
pip install "beam-directory[websocket]"
```

## Quick Start

```python
import asyncio
from beam_directory import BeamIdentity, BeamDirectory, BeamClient
from beam_directory.types import DirectoryConfig, AgentSearchQuery

async def main():
    # 1. Generate a Beam identity
    identity = BeamIdentity.generate(agent_name="myagent", org_name="myorg")
    print(f"Beam ID: {identity.beam_id}")
    # → myagent@myorg.beam.directory

    # 2. Register with a directory
    client = BeamClient(
        identity=identity,
        directory_url="https://api.beam.directory"
    )
    record = await client.register("My Agent", capabilities=["query", "answer"])
    print(f"Registered! Trust score: {record.trust_score}")

    # 3. Look up another agent
    directory = BeamDirectory(DirectoryConfig(base_url="https://api.beam.directory"))
    agent = await directory.lookup("other@org.beam.directory")
    if agent:
        print(f"Found: {agent.display_name}")

    # 4. Search agents
    agents = await directory.search(AgentSearchQuery(org="myorg", limit=10))
    for a in agents:
        print(f"  {a.beam_id} — {a.display_name}")

    # 5. Send an intent
    result = await client.send(
        to="other@org.beam.directory",
        intent="query",
        params={"q": "What is the weather?"}
    )
    if result.success:
        print(f"Result: {result.payload}")
    else:
        print(f"Error: {result.error}")

asyncio.run(main())
```

## Concepts

### Beam ID

Every agent has a globally unique **Beam ID** in the format:

```
agent@org.beam.directory
```

Like an e-mail address, but for AI agents.

### Intent Frames

Agents communicate via **Intent Frames** — small JSON objects (<1 KB) signed with Ed25519:

```json
{
  "v": "1",
  "intent": "query",
  "from": "jarvis@coppen.beam.directory",
  "to":   "clara@coppen.beam.directory",
  "params": { "q": "Current pipeline status?" },
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-03-04T00:00:00Z",
  "signature": "<Ed25519 base64>"
}
```

### Trust Scores

The directory assigns **trust scores** (0.0–1.0) based on:
- Domain ownership verification (DNS TXT record)
- Agent uptime and heartbeat frequency
- Signature verification success rate

## API Reference

### `BeamIdentity`

```python
# Generate a new identity
identity = BeamIdentity.generate(agent_name="agent", org_name="org")

# Export / import
data = identity.export()         # BeamIdentityData
identity = BeamIdentity.from_data(data)

# Sign and verify
sig = identity.sign("payload")
ok  = BeamIdentity.verify("payload", sig, identity.public_key_base64)

# Parse a Beam ID
parts = BeamIdentity.parse_beam_id("agent@org.beam.directory")
# → {"agent": "agent", "org": "org"}
```

### `BeamDirectory`

```python
from beam_directory import BeamDirectory
from beam_directory.types import DirectoryConfig

dir = BeamDirectory(DirectoryConfig(base_url="https://api.beam.directory"))

# Register
record = await dir.register(identity.to_registration("My Agent", ["query"]))

# Lookup
agent = await dir.lookup("agent@org.beam.directory")

# Search
agents = await dir.search(AgentSearchQuery(org="myorg", capabilities=["query"]))

# Heartbeat
await dir.heartbeat("agent@org.beam.directory")
```

### `BeamClient`

```python
client = BeamClient(identity=identity, directory_url="https://api.beam.directory")

# Register shortcut
record = await client.register("My Agent", ["query", "answer"])

# Send intent
result = await client.send(to="other@org.beam.directory", intent="query", params={})

# Handle incoming intents
@client.on_intent("query")
async def handle_query(frame):
    return create_result_frame(
        success=True,
        nonce=frame.nonce,
        payload={"answer": "42"}
    )
```

## Development

```bash
git clone https://github.com/Beam-directory/beam-protocol
cd beam-protocol/packages/sdk-python

python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

pytest
```

## License

Apache 2.0 — see [LICENSE](../../LICENSE).
