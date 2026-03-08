# beam-langchain

LangChain integration for the Beam Protocol.

This package bridges LangChain tools with Beam's agent-to-agent messaging model so an LLM can:

- send natural-language messages to remote Beam agents with `conversation.message`
- expose Beam agent capabilities as LangChain tools
- use the hosted Beam directory at `https://api.beam.directory`

## Installation

```bash
pip install beam-langchain
```

## Quick Start

```python
import asyncio

from beam_directory import BeamClient, BeamIdentity
from beam_langchain import BeamAgentTool, BeamToolkit


async def main() -> None:
    identity = BeamIdentity.generate(agent_name="planner", org_name="demo")
    client = BeamClient(identity=identity, directory_url="https://api.beam.directory")

    message_tool = BeamAgentTool(
        client=client,
        beam_id="researcher@demo.beam.directory",
        name="beam_researcher_message",
        description="Ask the remote research agent for a natural-language answer.",
    )

    reply = await message_tool._arun(message="Summarize today's support queue.")
    print(reply)

    toolkit = await BeamToolkit.afrom_agents(
        client,
        ["researcher@demo.beam.directory"],
    )
    for tool in toolkit.get_tools():
        print(tool.name)


asyncio.run(main())
```

## API

### `BeamAgentTool`

`BeamAgentTool` wraps Beam's `conversation.message` intent as a LangChain tool.

```python
tool = BeamAgentTool(
    client=client,
    beam_id="support@demo.beam.directory",
)

answer = await tool._arun(
    message="What incidents are still open?",
    context={"priority": "high"},
)
```

### `BeamToolkit`

`BeamToolkit` converts Beam agents and their advertised capabilities into LangChain tools.

```python
from beam_directory.types import AgentSearchQuery

toolkit = await BeamToolkit.afrom_search(
    client,
    AgentSearchQuery(org="demo", limit=5),
)

tools = toolkit.get_tools()
```

Each discovered agent produces:

- one `BeamAgentTool` for `conversation.message`
- one intent tool per declared Beam capability

## Development

```bash
cd packages/beam-langchain
python -m venv .venv
source .venv/bin/activate
pip install -e .
python -m unittest discover -s tests
```

## License

Apache 2.0 — see `../../LICENSE`.

