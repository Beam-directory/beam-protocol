# Contributing

Thanks for helping with Beam.

## Ground rules

- Keep changes focused and reviewable. Small pull requests merge faster than broad refactors.
- Add or update tests and docs together with behavior changes.
- Do not commit secrets, private keys, `.env` files or `.beam/` identities.
- Report security issues privately to security@beam.directory, not in a public issue. See [SECURITY.md](./SECURITY.md).

## Setup

Requires Node.js 20.19 or newer and npm 10 or newer (`scripts/require-npm.mjs` checks this). The Python SDK needs Python 3.10 or newer.

```bash
npm ci
npm run build
npm test
```

Run a local directory server:

```bash
npm run build --workspace=packages/directory
JWT_SECRET=local-dev-secret npm run start --workspace=packages/directory
```

## Repository structure

```text
packages/
  directory/          Directory API server (api.beam.directory, deployed to Fly.io on release tags)
  sdk-typescript/     beam-protocol-sdk (npm)
  sdk-python/         beam-directory (PyPI)
  cli/                beam-protocol-cli (npm)
  mcp-server/         MCP server, local stdio or hosted tenant with OAuth
  public-site/        beam.directory; built output is committed here, source is in site/
  dashboard/          Operator dashboard (Vercel)
  message-bus/        Durable relay with retries and a dead-letter queue
  a2a-adapter/        A2A v1 <-> Beam mappings
  echo-agent/         Test agent for the local quickstart
  create-beam-agent/  Project scaffolder
  beam-langchain/     LangChain integration (Python)
  beam-crewai/        CrewAI integration (Python)
integrations/         Grok Build and Codex plugins
docs/                 docs.beam.directory (VitePress, deployed from main)
spec/                 RFCs, did:beam method, compatibility fixtures, dashboard screenshot baselines
examples/             Runnable TypeScript examples
ops/
  quickstart/         Docker Compose stack used by the quickstart CI job
  mcp-pilot/          Fly.io configs for the hosted MCP pilot (Postgres, Keycloak, MCP)
  mcp-tenant/         Compose file for a self-hosted MCP tenant
scripts/
  e2e/                Cross-stack, MCP and public-site end-to-end checks
  quickstart/         Smoke and screenshot checks for the quickstart stack
  release/            Release smoke and release-metadata scripts used by the workflows
  production/         Production readiness gates and operator tools
  workspace/          OpenClaw host tooling and workspace dry runs
  demo/, dogfood/     Demo seeding and dogfood runs
reports/              Release notes and release evidence (older reports in reports/archive)
intents/              Placeholder intent catalog; the directory falls back to packages/directory/catalog.yaml
vendor/braces/        Patched braces, pinned through npm overrides
```

A few things are easy to break by accident:

- `packages/public-site` is deployed to beam.directory on every push to `main` that changes it. Rebuild with `npm run build --workspace=@beam-protocol/public-site` and commit the output together with the source change.
- Tags matching `v*` publish the SDK and CLI to npm, deploy the directory and create a GitHub release from `reports/<version>-release-notes-draft.md`. Only maintainers push tags.
- `packages/directory/fly.toml`, `packages/message-bus/fly.toml` and `ops/mcp-pilot/fly/*` are live deployment configs.

## Making changes

1. Create a branch from `main`.
2. Make the smallest coherent change that solves the problem.
3. Update docs if behavior, commands or configuration changed, and add a line under `Unreleased` in [CHANGELOG.md](./CHANGELOG.md) for user-visible changes.
4. Run the checks for the packages you touched.

```bash
npm run build --workspace=packages/sdk-typescript
npm run test --workspace=packages/sdk-typescript

npm test --workspace=@beam-protocol/directory
npm test --workspace=@beam-protocol/mcp-server
```

Before a release, the `e2e` job in GitHub Actions must be green. It boots the directory and message bus and checks registration, discovery and `conversation.message` delivery through the TypeScript SDK, the Python SDK and the CLI. Run it locally with:

```bash
python3 -m pip install -e packages/sdk-python
npm run test:e2e
```

## Pull requests

Describe what changed, why, how you tested it, and any known limitations. Use the pull request template.

## Commits

Write commits that are scoped to one change and use the imperative mood ("Fix key rotation check", not "Fixed ...").

## Issues

For bugs, include the package and version, the Node.js or Python version, the operating system, exact steps to reproduce, expected and actual behavior, and logs or failing payloads.

Feature requests are most useful when they describe the problem you are trying to solve, not only the proposed solution.
