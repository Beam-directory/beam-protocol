# Beam Protocol — Fix Brief (6 Tasks)

## Context
Beam Protocol is an agent-to-agent communication protocol. The repo has these packages:
- `packages/directory/` — Hono HTTP server (agent registry + WebSocket)
- `packages/message-bus/` — Hono HTTP server (persistent message queue)
- `packages/sdk-typescript/` — TypeScript SDK for agents
- `packages/sdk-python/` — Python SDK for agents
- `packages/cli/` — CLI tool
- `packages/public-site/` — Marketing site at beam.directory

All TypeScript. Tests use vitest. Currently 59/59 tests passing, 0 TypeScript errors.

## Task 1: Directory Dockerfile — Add JWT_SECRET env and fix startup

File: `packages/directory/Dockerfile`

The Dockerfile needs these changes:
- The `CMD` should use `node dist/index.js` (verify this is correct)
- Make sure the Dockerfile builds successfully with `docker build .` (dry run)
- The entrypoint needs to handle JWT_SECRET being set as a runtime env var (Fly.io secret)

File: `packages/directory/fly.toml`
- Change `auto_stop_machines = "stop"` to `auto_stop_machines = "off"` (directory should never stop)
- If no fly.toml exists, create one based on the message-bus one but for app name `beam-protocol`

## Task 2: Fix docs.beam.directory (GitHub Pages)

The docs site is at `packages/docs/` or similar. The CNAME `docs.beam.directory` points to `beam-directory.github.io` but returns HTTP 000 (timeout).

Check:
1. Is there a `docs/` folder or GitHub Pages configuration?
2. Is there a CNAME file?
3. Check `.github/workflows/` for a pages deployment workflow
4. If no docs site exists yet, create a minimal one using the README content

The GitHub repo is `Beam-directory/beam-protocol`. The GitHub Pages site should be served from there.

## Task 3: Python SDK WebSocket — Fix _ws_task

File: `packages/sdk-python/beam_directory/client.py` (or similar)

Problem: `on_intent()` registers a handler but `_ws_task` is never started. Python agents can only SEND intents, not RECEIVE them.

Fix:
1. Find where `on_intent` registers handlers
2. Find the `_ws_task` or WebSocket connection code
3. Make sure `_ws_task` actually starts when `on_intent` is called (or on `connect()`)
4. The WebSocket URL should connect to the directory's WS endpoint
5. Add a `listen()` or `start()` method that begins the WS listener if handlers are registered

Look at the TypeScript SDK (`packages/sdk-typescript/`) for reference on how WS listening works.

## Task 4: README Quick Start — Final Fixes

File: `README.md`

Check and fix:
1. The TypeScript Quick Start should show `client.register(displayName, capabilities)` with correct args
2. The Python Quick Start should use `await client.send(...)` with correct method/params
3. The `npm install beam-protocol-sdk` should be correct package name
4. The `pip install beam-directory` should be correct package name
5. Remove any remaining "Acme Corp" placeholder text from the Quick Start
6. All code examples should actually work if copy-pasted

## Task 5: Package.json files — Prep for npm publish

Files: `packages/directory/package.json`, `packages/message-bus/package.json`

For `@beam-protocol/directory`:
- Verify `"name": "@beam-protocol/directory"` 
- Verify `"types"` points to `dist/index.d.ts`
- Verify `"files"` includes `dist/`
- Verify `"main"` and `"module"` are correct
- Add `"repository"`, `"homepage"`, `"bugs"` fields
- License should be `Apache-2.0`

For `@beam-protocol/message-bus`:
- Same checks as above
- License should be `Apache-2.0` (was changed from AGPL)
- Version should be `0.1.0`

## Task 6: Clean up test data from message-bus DB schema

File: `packages/message-bus/src/db.ts`

Add a utility function `cleanTestMessages(db)` that deletes messages where `from_agent` or `to_agent` contains `@test.` or `@demo.`. This is for cleaning up test data from production.

Export it so it can be called from the server startup if an env var `BEAM_BUS_CLEAN_TEST_DATA=true` is set.

## Constraints
- All existing tests must still pass (59/59)
- No new TypeScript errors
- Don't change any API contracts
- Keep all changes backward-compatible
- Use `Apache-2.0` license for all packages
- German comments are OK but code/docs in English

## Validation
After all changes:
```bash
cd packages/directory && npx vitest run && npx tsc --noEmit
cd ../message-bus && npx vitest run && npx tsc --noEmit
cd ../sdk-typescript && npx tsc --noEmit
```

When completely finished, run this command to notify me:
openclaw system event --text "Done: Beam 6-task fix — Directory Dockerfile, docs site, Python WS, README, package.json prep, test cleanup" --mode now
