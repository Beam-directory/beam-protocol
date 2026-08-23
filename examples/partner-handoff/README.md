# Verified Partner Handoff

This is the recommended Beam 0.6 example.

It simulates a cross-company B2B workflow:

1. `procurement` at Acme sends `quote.request` to `partner-desk` at Northwind.
2. `partner-desk` asks `warehouse` at Northwind for stock and ship window.
3. `partner-desk` returns a signed quote package to Acme.

## Run

Start the local directory from the repo root:

```bash
npm install
npm run build --workspace=packages/directory
JWT_SECRET=local-dev-secret BEAM_ADMIN_EMAILS=ops@beam.local npm run start --workspace=packages/directory
```

Then run the example:

```bash
cd examples
npm install
BEAM_ADMIN_EMAIL=ops@beam.local npm run partner-handoff
```

For a non-local directory, pass an active admin session as `BEAM_ADMIN_TOKEN`. Override the target directory with `BEAM_DIRECTORY_URL` if needed.
