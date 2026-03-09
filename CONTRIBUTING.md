# Contributing to Beam Protocol

Thanks for your interest in contributing to Beam Protocol.

Beam Protocol is an open-source agent-to-agent communication protocol. This repository contains the protocol specification, SDKs, developer tools, and related project packages that help contributors build interoperable Beam-compatible software.

## Before you start

- Read the protocol spec in `spec/RFC-0001.md`.
- For protocol-level changes, start an RFC discussion before opening an implementation PR.
- Keep contributions focused and easy to review.

## Development setup

Beam Protocol uses npm workspaces with multiple packages under `packages/`.

1. Clone the repository:

   ```bash
   git clone https://github.com/beam-directory/beam-protocol.git
   cd beam-protocol
   ```

2. Install dependencies at the repository root:

   ```bash
   npm install
   ```

3. If you are working on a specific package directly, install dependencies there as needed:

   ```bash
   cd packages/<package-name>
   npm install
   ```

4. Build the workspace:

   ```bash
   npm run build
   ```

5. Run tests:

   ```bash
   npm test
   ```

## Reporting bugs

If you find a bug, please open a GitHub Issue with a clear reproduction, expected behavior, and environment details.

## Suggesting features

If you have an idea for an improvement, please open a GitHub Discussion first so the community can review the problem and proposed direction.

## Pull request guidelines

- Use Conventional Commits for commit messages.
- Keep each pull request limited to one feature or focused fix.
- Include or update tests for behavioral changes.
- Update documentation when the user-facing or developer-facing behavior changes.
- Protocol changes require RFC discussion and agreement before implementation.

## Code style and testing

- TypeScript code should remain compatible with strict mode.
- Use Vitest for tests where test coverage exists or new tests are added.
- Follow the existing project structure and naming conventions in each package.

## Questions

If you are unsure where to start, begin with the spec in `spec/RFC-0001.md`, browse open issues, or start a discussion before implementing a larger change.
