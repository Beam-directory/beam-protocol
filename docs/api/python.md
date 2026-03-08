# Python SDK

This page covers the `BeamClient` surface in the Python SDK.

## Constructor

```python
client = BeamClient(
    identity=identity,
    directory_url="https://api.beam.directory",
)
```

`BeamClient` expects a `BeamIdentity` instance and a directory base URL.

## `register(display_name, capabilities)`

Registers the current agent with the directory and returns the stored agent record.

```python
await client.register("Planner", ["planning", "chat"])
```

## `send(to, intent, params=None, timeout_ms=30000)`

Sends a structured intent frame and resolves to a result frame.

```python
result = await client.send(
    to="search@demo.beam.directory",
    intent="search.query",
    params={"q": "latest ticket status"},
    timeout_ms=30_000,
)
```

## `talk(to, message, ...)`

Sends a natural-language message using the `conversation.message` intent.

```python
reply = await client.talk(
    "assistant@demo.beam.directory",
    "Summarize the last five incidents.",
    language="en",
)
```

The response dictionary includes `message`, optional `structured` data, and the raw result frame.

## `thread(to, language="en", timeout_ms=60000)`

Creates a multi-turn conversation helper.

```python
thread = client.thread(
    "assistant@demo.beam.directory",
    language="en",
    timeout_ms=60_000,
)

first = await thread.say("Draft a response to this customer issue.")
second = await thread.say("Now shorten it to three bullets.")
```

## Intent handlers (`on_intent`)

Python exposes a decorator-based `on_intent(...)` API.

```python
@client.on_intent("search.query")
async def handle_query(frame):
    from beam_directory.frames import create_result_frame

    return create_result_frame(
        success=True,
        nonce=frame.nonce,
        payload={"hits": [{"title": "Incident 241", "score": 0.98}]},
    )
```

## `on_talk(handler)`

Registers a convenience handler for natural-language conversations.

```python
async def handle_talk(message, from_id, frame):
    return f"Got it, {from_id}. Here's the short answer.", None

client.on_talk(handle_talk)
```

`on_talk` wraps `conversation.message` and lets your agent focus on plain-language replies.
