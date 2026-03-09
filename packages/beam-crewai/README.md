# beam-crewai

`beam-crewai` is a small Python package that connects [CrewAI](https://github.com/crewAIInc/crewAI) agents to Beam Protocol using the `beam-directory` SDK.

It provides two high-level primitives:

- `BeamTool`: a CrewAI-compatible tool for sending natural-language messages to Beam agents
- `BeamAgent`: a thin wrapper around the Beam Protocol Python SDK for registration, intent sending, and natural-language conversations

## Installation

```bash
pip install beam-crewai
```

## Quick Start

### 1) Create a Beam wrapper

```python
from beam_crewai import BeamAgent

beam = BeamAgent.create(
    agent_name="researcher",
    org_name="acme",
    directory_url="https://api.beam.directory",
    default_recipient="analyst@partner.beam.directory",
)
```

### 2) Send a Beam intent

```python
result = beam.send_intent_sync(
    intent="query.status",
    params={"detail": "full"},
)

print(result.success)
print(result.payload)
```

### 3) Send a natural-language Beam message

```python
reply = beam.talk_sync("What is the latest account summary?")
print(reply["message"])
```

## Using `BeamTool` with CrewAI

```python
from crewai import Agent
from beam_crewai import BeamAgent, BeamTool

beam = BeamAgent.create(
    agent_name="ops-assistant",
    org_name="acme",
    directory_url="https://api.beam.directory",
    default_recipient="crm@partner.beam.directory",
)

beam_tool = BeamTool(
    beam_agent=beam,
    description="Send a message to the CRM Beam agent and return the reply.",
)

agent = Agent(
    role="Operations Assistant",
    goal="Fetch information from partner agents over Beam",
    backstory="A CrewAI agent that delegates partner-system questions to Beam agents.",
    tools=[beam_tool],
)
```

The tool sends a `conversation.message` request through Beam and returns the remote agent's text response. If the Beam response has no plain-text `message`, it falls back to serialized structured payload.

## API

### `BeamAgent`

- `BeamAgent.create(...)`: creates a new Beam identity and client
- `BeamAgent.from_identity_data(...)`: rebuilds a wrapper from exported Beam identity data
- `register(...)` / `register_sync(...)`: registers the local Beam agent in the directory
- `send_intent(...)` / `send_intent_sync(...)`: sends a Beam intent frame
- `talk(...)` / `talk_sync(...)`: sends a natural-language Beam message

### `BeamTool`

- Accepts `message`, optional `to`, optional `context`, optional `language`, and `timeout_ms`
- Uses the wrapper's `default_recipient` when `to` is omitted
- Raises an error on Beam delivery failures so CrewAI can surface the tool failure

## Development

Run the package tests with:

```bash
python -m unittest discover -s tests
```

## License

Apache-2.0

