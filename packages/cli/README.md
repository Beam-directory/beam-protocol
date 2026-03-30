# beam-protocol-cli

Command-line client for generating Beam identities, registering agents, searching the directory, and sending verified partner handoffs.

## Install

```bash
npm install -g beam-protocol-cli
```

## Quick Start

```bash
beam init --agent procurement --org acme
beam register --display-name "Acme Procurement Desk" --capabilities "conversation.message,quote.request"
beam lookup partner-desk@northwind.beam.directory
beam talk partner-desk@northwind.beam.directory "Need 240 inverters for Mannheim by Friday."
```

## Compatibility

This CLI targets `beam/1`. New optional response fields may appear in JSON output, but breaking protocol changes require a new protocol family.

## Commands

### `beam init`

Generate a new Ed25519 identity and save it to `.beam/identity.json`.

```bash
beam init --agent <name> [--org <name>] [--directory <url>] [--force]
beam init --name <name> [--org <name>] [--directory <url>] [--force]
```

### `beam register`

Register the current identity with a directory.

```bash
beam register [--display-name <name>] [--capabilities <csv>] [--directory <url>]
beam register [--name <name>] [--capabilities <csv>] [--directory <url>]
```

### `beam lookup`

Look up a single Beam ID.

```bash
beam lookup <beamId> [--directory <url>] [--json]
```

### `beam search`

Search by org, capability, and minimum trust score.

```bash
beam search [--org <org>] [--capability <cap>] [--min-trust <0-1>] [--limit <n>] [--directory <url>] [--json]
```

### `beam browse`

Browse paginated public directory listings.

```bash
beam browse [--page <n>] [--capability <cap>] [--tier <tier>] [--verified-only] [--directory <url>] [--json]
```

### `beam profile update`

Update public metadata for the current agent.

```bash
beam profile update [--description <text>] [--logo-url <url>] [--website <url>] [--directory <url>] [--json]
```

### `beam verify domain`

Start DNS-based domain verification.

```bash
beam verify domain <domain> [--directory <url>] [--json]
```

### `beam verify check`

Check current domain verification status.

```bash
beam verify check [--directory <url>] [--json]
```

### `beam stats`

Show directory-wide stats.

```bash
beam stats [--directory <url>] [--json]
```

### `beam delegate`

Create a delegation from the current agent to another Beam ID.

```bash
beam delegate <targetBeamId> --scope <scope> [--expires <hours>] [--directory <url>] [--json]
```

### `beam report`

Report an agent to the directory.

```bash
beam report <targetBeamId> --reason <reason> [--directory <url>] [--json]
```

### `beam send`

Send an intent and print the result.

```bash
beam send <to> <intent> [params-json] [--timeout <seconds>] [--directory <url>] [--json]
```

Example:

```bash
beam send partner-desk@northwind.beam.directory quote.request '{"sku":"INV-240","quantity":240,"shipTo":"Mannheim, DE"}'
```

### `beam talk`

Send a natural-language message over the standard `conversation.message` intent.

```bash
beam talk <to> <message> [--timeout <seconds>] [--language <code>] [--context <json>] [--directory <url>] [--json]
```

Example:

```bash
beam talk partner-desk@northwind.beam.directory "Need 240 inverters for Mannheim by Friday."
```

## Files

- `.beam/identity.json` - generated local identity and directory config

## Reference

Full CLI docs: [docs.beam.directory/api/cli](https://docs.beam.directory/api/cli)

## License

Apache-2.0
