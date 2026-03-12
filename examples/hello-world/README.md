# Hello World

Registers two throwaway agents, connects the receiver over WebSocket, and sends a first `conversation.message`.

## Run

From the repo root, start the local directory:

```bash
npm install
npm run build --workspace=packages/directory
JWT_SECRET=local-dev-secret npm run start --workspace=packages/directory
```

From `examples/`:

```bash
npm install
npm run hello-world
```

Optional:

```bash
BEAM_DIRECTORY_URL=https://api.beam.directory npm run hello-world
```
