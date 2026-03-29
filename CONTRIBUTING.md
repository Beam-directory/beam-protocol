# Contributing to Beam Protocol

Thanks for contributing to Beam Protocol.

## Ground Rules

- Keep changes focused and reviewable.
- Prefer docs and tests alongside behavior changes.
- Do not commit secrets, private keys, or `.beam/` identities.
- For security issues, do not open a public issue. Report privately to the maintainers.

## Development Setup

```bash
npm install
npm run build
npm test
python3 -m pip install -e packages/sdk-python
npm run test:e2e
```

For the local directory server:

```bash
npm run build --workspace=packages/directory
JWT_SECRET=local-dev-secret npm run start --workspace=packages/directory
```

## Repository Structure

- `packages/sdk-typescript` - TypeScript SDK
- `packages/sdk-python` - Python SDK
- `packages/cli` - Beam CLI
- `packages/directory` - Beam directory server
- `packages/message-bus` - persistent relay and retry service
- `examples` - runnable demos
- `docs` - documentation site

## Making Changes

1. Fork the repo and create a branch from `main`.
2. Make the smallest coherent change that solves the problem.
3. Update docs if behavior, commands, or configuration changed.
4. Run the relevant build and test commands before opening a pull request.

## Pull Requests

Include:

- what changed
- why it changed
- how you validated it
- any follow-up work or known limitations

Small PRs merge faster than broad refactors.

## Testing

At minimum, run the checks relevant to the packages you touched.

```bash
npm run build --workspace=packages/sdk-typescript
npm run test --workspace=packages/sdk-typescript

npm run build --workspace=packages/directory
npm run build --workspace=packages/message-bus
```

If you add examples or CLI changes, verify the exact commands in the updated README files.

Before cutting or approving a release branch, make sure the `e2e` GitHub Actions job is green. It is the cross-stack guard that boots the directory and message bus, then verifies registration, discovery, and `conversation.message` delivery through the TypeScript SDK, Python SDK, and CLI.

## Commit Style

There is no strict commit format requirement, but good commits are:

- scoped to one change
- written in imperative mood
- easy to understand from `git log`

## Issues

When filing bugs, include:

- the package and version
- Node.js or Python version
- operating system
- exact reproduction steps
- expected vs actual behavior
- logs, stack traces, or failing payloads when relevant

Feature requests are more useful when they explain the user problem, not only the proposed implementation.
