# Multi-Agent

Starts three agents and demonstrates a chained workflow:

1. `alpha` sends `team.sync` to `beta`
2. `beta` asks `gamma` for a checkpoint
3. `gamma` notifies `alpha`
4. the result propagates back through the chain

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
npm run multi-agent
```

Override the target directory with `BEAM_DIRECTORY_URL` if needed.
