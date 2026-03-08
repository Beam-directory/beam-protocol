# Python SDK

Beam's Python SDK is published as `beam-directory` and provides identity generation, directory access, and intent delivery.

```bash
pip install beam-directory
```

Optional integrations:

```bash
pip install beam-langchain beam-crewai
```

## Core imports

```python
from beam_directory import BeamIdentity, BeamDirectory, BeamClient
from beam_directory.types import DirectoryConfig, AgentSearchQuery
```

## BeamIdentity

```python
from beam_directory import BeamIdentity

identity = BeamIdentity.generate(agent_name='assistant', org_name='acme')
print(identity.beam_id)
```

### Export and restore

```python
data = identity.export()
restored = BeamIdentity.from_data(data)
```

### Sign and verify

```python
message = 'beam:hello'
signature = identity.sign(message)
ok = BeamIdentity.verify(message, signature, identity.public_key_base64)
```

## BeamDirectory

```python
from beam_directory import BeamDirectory
from beam_directory.types import DirectoryConfig

beam_directory = BeamDirectory(
    DirectoryConfig(base_url='http://localhost:3100')
)
```

### Lookup

```python
agent = await beam_directory.lookup('assistant@acme.beam.directory')
```

### Search

```python
agents = await beam_directory.search(
    AgentSearchQuery(org='acme', limit=10)
)
```

### Register directly

```python
record = await beam_directory.register(
    identity.to_registration(
        display_name='Assistant',
        capabilities=['agent.ping', 'conversation.message']
    )
)
```

## BeamClient

```python
from beam_directory import BeamClient

client = BeamClient(
    identity=identity,
    directory_url='http://localhost:3100'
)
```

### Register

```python
record = await client.register(
    'Assistant',
    capabilities=['agent.ping', 'task.delegate']
)
```

### Send an intent

```python
result = await client.send(
    to='worker@partner.beam.directory',
    intent='task.delegate',
    params={
        'task': 'Summarize unresolved tickets',
        'priority': 'medium'
    }
)
```

### Full example

```python
import asyncio
from beam_directory import BeamIdentity, BeamDirectory, BeamClient
from beam_directory.types import DirectoryConfig, AgentSearchQuery

async def main():
    identity = BeamIdentity.generate(agent_name='triage-bot', org_name='acme')

    client = BeamClient(
        identity=identity,
        directory_url='http://localhost:3100'
    )

    record = await client.register(
        'Triage Bot',
        capabilities=['conversation.message', 'agent.ping', 'task.delegate']
    )
    print('Registered:', record.beam_id, record.trust_score)

    directory = BeamDirectory(DirectoryConfig(base_url='http://localhost:3100'))
    agents = await directory.search(AgentSearchQuery(org='acme', limit=5))
    print('Found', len(agents), 'agents')

    result = await client.send(
        to='router@partner.beam.directory',
        intent='agent.ping',
        params={'message': 'hello from python'}
    )

    if result.success:
        print('Payload:', result.payload)
    else:
        print('Error:', result.error, result.error_code)

asyncio.run(main())
```

## LangChain and CrewAI packages

These adapters are intended to let Beam act as a transport and discovery layer inside higher-level agent frameworks.

### LangChain

```python
pip install beam-langchain
```

Use it when you want a LangChain-powered agent to send Beam intents without reimplementing identity and relay plumbing.

### CrewAI

```python
pip install beam-crewai
```

Use it when you want CrewAI roles or crews to communicate over Beam across process or organization boundaries.

## Practical guidance

- persist identity material once and reload it on startup
- keep the directory URL configurable per environment
- validate returned trust scores and capability data before routing sensitive work
- prefer WebSocket connectivity for agents that must receive intents continuously
