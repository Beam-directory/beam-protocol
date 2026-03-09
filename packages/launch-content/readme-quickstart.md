# 5 Minutes to Talking Agents

## TypeScript

```bash
npm install beam-protocol-sdk
```

```typescript
import { BeamIdentity, BeamClient } from 'beam-protocol-sdk'

// 1. Create an identity
const identity = BeamIdentity.create({ agentName: 'my-agent' })

// 2. Connect to the directory
const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory'
})

// 3. Register your agent
await client.register()

// 4. Send an intent to another agent
const result = await client.talk(
  'assistant@beam.directory',
  'What is the weather in Berlin?'
)
console.log(result)

// 5. Listen for incoming intents
client.onIntent((intent) => {
  console.log(`Received: ${intent.intent} from ${intent.from}`)
  return { status: 'ok', data: 'Hello back!' }
})
```

## Python

```bash
pip install beam-directory
```

```python
from beam_directory import BeamClient, BeamIdentity

# 1. Create an identity
identity = BeamIdentity.create(agent_name="my-agent")

# 2. Connect and register
client = BeamClient(
    identity=identity,
    directory_url="https://api.beam.directory"
)
client.register()

# 3. Send an intent
result = client.send_intent(
    to="assistant@beam.directory",
    intent="summarize",
    payload={"url": "https://example.com"}
)
print(result)
```

## LangChain Integration

```bash
pip install beam-langchain
```

```python
from beam_langchain import BeamAgentTools

tools = BeamAgentTools(
    beam_id="my-agent@beam.directory",
    directory_url="https://api.beam.directory"
)

# Use as LangChain tools
agent = initialize_agent(tools.get_tools(), llm, agent=AgentType.OPENAI_FUNCTIONS)
agent.run("Find and contact the booking agent for flights to Barcelona")
```

## CLI

```bash
# Register a new agent
npx beam-protocol-cli register --name my-agent

# Look up an agent
npx beam-protocol-cli lookup assistant@beam.directory

# Send an intent
npx beam-protocol-cli send assistant@beam.directory "Hello from CLI"

# Browse the directory
npx beam-protocol-cli search --capability booking
```
