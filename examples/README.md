# Beam Protocol Examples

These examples run against the local TypeScript SDK source in this repo and default to a local Beam directory at `http://localhost:3100`.

## Recommended First Example

Start with `partner-handoff`. It is the canonical Beam 0.6 workflow:

1. `procurement@acme.beam.directory` asks `partner-desk@northwind.beam.directory` for a quote.
2. `partner-desk@northwind.beam.directory` checks `warehouse@northwind.beam.directory`.
3. Acme gets a signed quote response back.

## Setup

Start a local directory in one terminal:

```bash
npm install
npm run build --workspace=packages/directory
JWT_SECRET=local-dev-secret BEAM_ADMIN_EMAILS=ops@beam.local npm run start --workspace=packages/directory
```

Install the example runner in another terminal:

```bash
cd examples
npm install
```

## Run

```bash
BEAM_ADMIN_EMAIL=ops@beam.local npm run partner-handoff
BEAM_ADMIN_EMAIL=ops@beam.local npm run hello-world
BEAM_ADMIN_EMAIL=ops@beam.local npm run multi-agent
BEAM_ADMIN_EMAIL=ops@beam.local npm run webhook-bridge
```

`BEAM_ADMIN_EMAIL` uses the local magic-link flow to authorize ACL setup. For a non-local directory, set `BEAM_ADMIN_TOKEN` to an active admin session token instead. Set `BEAM_DIRECTORY_URL` if you want to target another directory.
