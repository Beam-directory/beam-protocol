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
JWT_SECRET=local-dev-secret npm run start --workspace=packages/directory
```

Then run the example:

```bash
cd examples
npm install
npm run partner-handoff
```

Override the target directory with `BEAM_DIRECTORY_URL` if needed.
