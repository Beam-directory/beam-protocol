# CLI Reference

Beam ships a command-line interface for generating identities, registering agents, querying the directory, and sending intents.

Public npm package:

```bash
npm install --save-dev beam-protocol-cli
```

Binary:

```bash
beam
```

## Global behavior

The CLI stores its local config in:

```text
.beam/identity.json
```

The default directory URL is:

```text
http://localhost:3100
```

You can override it per command with `--directory`.

## `beam init`

Generate a new Beam identity and write `.beam/identity.json`.

```bash
beam init --agent support-bot --org acme --directory http://localhost:3100
```

Options:

- `--agent <name>` required
- `--org <name>` required
- `--directory <url>` optional
- `--force` overwrite existing identity

Notes:

- agent and org names must match `[a-z0-9_-]+`
- the command generates an Ed25519 key pair
- the resulting Beam ID is `agent@org.beam.directory`

## `beam register`

Register the current identity with a directory.

```bash
beam register \
  --display-name "Support Bot" \
  --capabilities "conversation.message,agent.ping,task.delegate"
```

Options:

- `--display-name <name>` human-friendly label
- `--capabilities <list>` comma-separated capability or intent list
- `--directory <url>` override config value

## `beam lookup`

Resolve one agent by Beam ID.

```bash
beam lookup router@partner.beam.directory
```

Options:

- `--directory <url>` override config value
- `--json` print raw JSON

The Beam ID must match:

```text
agent@org.beam.directory
```

## `beam send`

Send a signed intent and print the result.

```bash
beam send router@partner.beam.directory agent.ping '{"message":"hello from CLI"}'
```

Options:

- `--directory <url>` override config value
- `--timeout <seconds>` request timeout, default `10`
- `--json` print raw JSON

Example with a richer intent:

```bash
beam send billing@acme.beam.directory payment.status_check '{
  "invoiceNumber": "INV-2026-1042",
  "customerName": "Example Corp"
}'
```

## `beam search`

Search the directory by org, capability, and trust score.

```bash
beam search --org acme --capability agent.ping --min-trust 0.5 --limit 20
```

Options:

- `--org <org>` filter by org namespace
- `--capability <cap>` require one capability
- `--min-trust <score>` trust-score floor
- `--limit <n>` maximum rows
- `--directory <url>` override config value
- `--json` print raw JSON

## Common workflow

```bash
beam init --agent support-bot --org acme
beam register --display-name "Support Bot" --capabilities "conversation.message,agent.ping"
beam lookup router@partner.beam.directory
beam send router@partner.beam.directory agent.ping '{"message":"hello"}'
```

## Troubleshooting

### No local identity found

If the CLI says no Beam identity exists, run:

```bash
beam init --agent my-agent --org my-org
```

### Invalid Beam ID

Beam IDs must be lowercase and follow the expected format.

### Registration or send failed

Check:

- the directory URL is reachable
- the target agent is registered
- the target agent is connected if using live relay
- the payload matches the intent schema
- ACL policy allows the sender
