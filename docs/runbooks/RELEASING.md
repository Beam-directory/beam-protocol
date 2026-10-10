# Releasing Beam

There are three ways to ship. Pick the smallest one that covers the change.

| Path | Ships | Workflow | Who says go |
| --- | --- | --- | --- |
| Full tag release | npm SDK + CLI, directory on Fly, GitHub release | `CI` on tag `v*` (`.github/workflows/ci.yml`) | Tobias pushes the tag |
| Directory only | directory on Fly (and the GitHub release for Recover) | `Recover Tagged Release` or `Deploy Directory Hotfix` | Tobias runs the workflow |
| npm only | `beam-protocol-sdk` or `beam-protocol-cli` | `Publish npm package` (`.github/workflows/publish-npm.yml`) | Tobias approves the `npm-publish` environment |

None of these workflows run on a pull request. Agents and contributors prepare the branch and the release notes. They do not push tags, run deploy workflows, or publish to npm.

## Before any release

1. `main` is green in CI.
2. The version is the same in `package.json`, `packages/directory/package.json`, `packages/sdk-typescript/package.json` and `packages/cli/package.json`. The CLI depends on `beam-protocol-sdk` `^<version>`.
3. `CHANGELOG.md`, `packages/sdk-typescript/CHANGELOG.md` and `packages/cli/CHANGELOG.md` list the changes.
4. `reports/<version>-release-notes-draft.md` exists. The GitHub release step fails without it.

## 1. Full tag release

Use this when the SDK, CLI and directory ship together.

1. Tobias creates and pushes the tag `v<version>` from `main`.
2. `CI` runs `monorepo`, `e2e`, `docs`, `quickstart`, `mcp-container` and `mcp-pilot-evidence`.
3. `publish` publishes the SDK, then the CLI, with the `NPM_TOKEN` repository secret.
4. `deploy-directory` deploys `packages/directory` to the Fly app `beam-protocol` and checks that `/health`, `/stats` and `/release` on `https://api.beam.directory` report the version and commit.
5. `release` creates or updates the GitHub release from `reports/<version>-release-notes-draft.md`.

### Hosted MCP pilot evidence

`mcp-pilot-evidence` needs `reports/<version>-mcp-pilot-evidence.json`. An external operator produces that file from a real Grok connection to the hosted pilot (see `scripts/production/mcp-pilot-evidence-check.mjs`). Without it, the tag run stops before `publish`, and nothing ships.

The repository variable `MCP_PILOT_EVIDENCE_SCOPE` controls when the check runs:

- not set, or any value other than `mcp-changes`: every tag needs evidence. This is the default.
- `mcp-changes`: a tag skips the check when no MCP pilot file changed since the previous tag. MCP pilot files are listed in `scripts/production/mcp-pilot-evidence-scope.mjs`. They include `packages/mcp-server`, `packages/sdk-typescript` (the pilot image contains the SDK), `ops/mcp-pilot`, `ops/mcp-tenant`, the MCP and Keycloak scripts, `package-lock.json`, `LICENSE` and `ci.yml`. A change that only bumps versions does not count.

Only Tobias changes this variable (Settings > Secrets and variables > Actions > Variables). Manual `CI` runs (`workflow_dispatch`) always check evidence.

Because the SDK is part of the pilot image, a tag that changes the SDK always needs evidence. If the evidence is not ready, ship the directory and npm packages with paths 2 and 3.

### Who approves

- Tobias: pushing the tag. There is no environment approval on this path.
- External operator: the pilot evidence file, reviewed in a pull request.

## 2. Directory only

Use this for a directory fix, or when a tag run failed after tests and the directory still needs to go out. Neither workflow publishes npm packages.

### Recover Tagged Release

`.github/workflows/recover-release.yml`, input `tag` (for example `v1.8.0`).

1. Checks out the tag and checks that its version matches `package.json`.
2. Deploys the directory to Fly and checks `/health`, `/stats` and `/release` for the tag's version and commit.
3. Creates or updates the GitHub release from `reports/<version>-release-notes-draft.md`.

### Deploy Directory Hotfix

`.github/workflows/deploy-directory-hotfix.yml`, no inputs.

1. Refuses every ref except `main` of `Beam-directory/beam-protocol`.
2. Builds and tests the directory.
3. Deploys it to Fly with the root `package.json` version and the `main` commit, and checks `/health`, `/stats` and `/release`.
4. Does not create a GitHub release.

### Who approves

- Tobias: running the workflow. Anyone with write access can start these two workflows. There is no environment approval yet.

## 3. npm only

Use this to publish `beam-protocol-sdk` or `beam-protocol-cli` without a tag run, for example when the tag run stopped at `mcp-pilot-evidence`.

`.github/workflows/publish-npm.yml` takes:

| Input | Meaning |
| --- | --- |
| `package` | `sdk` or `cli` |
| `version` | `X.Y.Z`. Must equal `version` in the package's `package.json` at `ref`. |
| `ref` | A release tag `vX.Y.Z` or a full 40-character commit SHA. It must be on `main`. |
| `dry_run` | `true` by default. Stops after `npm publish --dry-run`. |

Start the workflow from `main`. It refuses other branches.

### What it does

`verify` job (no secrets):

1. Checks the inputs and that the `npm-publish` environment has a required reviewer. In a dry run a missing reviewer is only a warning.
2. Checks out `ref` and checks that it is on `main`.
3. Checks the package name and version, and that this version is not on npm yet.
4. For the CLI, checks that npm already has a `beam-protocol-sdk` version that matches the CLI's dependency.
5. Builds, runs the SDK tests (and for the CLI: typecheck and `beam --version`), runs `npm pack --dry-run`, packs the tarball and runs `npm publish --dry-run`.
6. Writes the tarball SHA-256 to the run summary.

`publish` job (only when `dry_run` is `false`):

1. Waits in the `npm-publish` environment until a required reviewer approves.
2. Checks out the same commit, rebuilds, and stops if the tarball SHA-256 differs from the verified one.
3. Runs `npm publish <tarball> --access public --provenance` with `NODE_AUTH_TOKEN` set from the `NPM_TOKEN` secret, the same way the tag release does.
4. Checks that the version is visible on npm.

### Order

Publish the SDK first, then the CLI. The CLI run fails while npm has no matching SDK version.

### Who approves

- Anyone with write access: start a dry run.
- Tobias: start the real run (`dry_run` = `false`) and approve the `npm-publish` environment.

### One-time setup (Tobias)

1. Settings > Environments > New environment `npm-publish`.
2. Required reviewers: Tobias. Leave "Prevent self-review" off if Tobias starts and approves his own runs.
3. Deployment branches and tags: Selected branches, `main` only.
4. Optional, safer: move `NPM_TOKEN` from the repository secrets into the `npm-publish` environment. Then only approved jobs can read it. The tag release `publish` job would also need `environment: npm-publish` to keep working.

## If something goes wrong

- A published npm version cannot be replaced. Publish a new patch version. Use `npm deprecate beam-protocol-sdk@<version> "<reason>"` to warn users. `npm unpublish` only works in the first 72 hours and breaks installs.
- A bad directory deploy: run Recover Tagged Release with the last good tag.
