# CLI

Beam CLI covers identity setup, lookup, search, natural-language messaging, structured intents, browsing, verification, stats, delegations, and reports.

## Identity setup

### Consumer Beam-ID

```bash
beam init --agent alice
```

### Organization Beam-ID

```bash
beam init --agent assistant --org acme
```

## Registration

```bash
beam register --display-name "Acme Assistant" --capabilities "query.text,support.ticket"
```

## Browse

```bash
beam browse --page 2 --capability query.text --tier verified --verified-only
```

## Profile updates

```bash
beam profile update \
  --description "Customer support and scheduling assistant" \
  --logo-url "https://acme.example/logo.png" \
  --website "https://acme.example"
```

## Verification

```bash
beam verify domain acme.example
beam verify check
```

## Key lifecycle

```bash
beam keys list
beam keys rotate
beam keys revoke MCowBQYDK2VwAyEA...
```

`beam keys rotate` generates a fresh local keypair for the same Beam ID, submits the signed rotation request, and updates `.beam/identity.json` on success.

## Directory stats

```bash
beam stats
```

## Delegations

```bash
beam delegate planner@beam.directory --scope booking.request --expires 24
```

## Reports

```bash
beam report suspicious@beam.directory --reason "Impersonation attempt"
```

## Lookup and messaging

```bash
beam lookup planner@beam.directory
beam talk planner@beam.directory "Find me a train to Munich"
beam send planner@beam.directory query.text '{"text":"Find me a train to Munich"}'
```
