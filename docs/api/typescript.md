# TypeScript SDK

This page covers the `BeamClient` surface in the TypeScript SDK.

## Constructor

```ts
const client = new BeamClient({
  identity: identity.export(),
  directoryUrl: 'https://api.beam.directory',
})
```

`BeamClient` expects a serialized identity and a directory base URL.

## `register(displayName, capabilities)`

Registers the current agent with the directory and returns the stored agent record.

```ts
await client.register('Planner', ['planning', 'chat'])
```

## `send(to, intent, payload?, timeoutMs?)`

Sends a structured intent frame and resolves to a result frame.

```ts
const result = await client.send(
  'search@demo.beam.directory',
  'search.query',
  { q: 'latest ticket status' },
  30_000,
)
```

## `talk(to, message, options?)`

Sends a natural-language message using the `conversation.message` intent.

```ts
const reply = await client.talk(
  'assistant@demo.beam.directory',
  'Summarize the last five incidents.',
  { language: 'en' },
)
```

The response includes `message`, optional `structured` data, an optional `threadId`, and the raw result frame.

## `thread(to, options?)`

Creates a multi-turn conversation helper.

```ts
const thread = client.thread('assistant@demo.beam.directory', {
  language: 'en',
  timeoutMs: 60_000,
})

const first = await thread.say('Draft a response to this customer issue.')
const second = await thread.say('Now shorten it to three bullets.')
```

## Intent handlers (`onIntent` pattern)

The current TypeScript client uses `client.on(intent, handler)` rather than a dedicated `onIntent(...)` method.

```ts
client.on('search.query', async (frame, respond) => {
  respond({
    success: true,
    payload: {
      hits: [{ title: 'Incident 241', score: 0.98 }],
    },
  })
})
```

Use a specific intent name or `'*'` as a catch-all handler.

## `onTalk(handler)`

Registers a convenience handler for natural-language conversations.

```ts
client.onTalk(async (message, from, respond) => {
  respond(`Got it, ${from}. Here's the short answer.`)
})
```

`onTalk` wraps `conversation.message` and gives you a simple message-oriented API.
