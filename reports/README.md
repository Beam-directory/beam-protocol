# Release reports

Evidence written before and after each release: dry runs, smoke checks, readiness gates, and release notes.

- `<version>-release-notes-draft.md` is the body of the GitHub release. The tag workflow in `.github/workflows/ci.yml` reads `reports/<version>-release-notes-draft.md`, so the file for the version being tagged must stay at this path.
- A tagged release also needs `reports/<version>-mcp-pilot-evidence.json` (see `npm run production:mcp-pilot`).
- `1.7.0-*.json` templates and evidence are read by the production gate scripts in `scripts/production/`.
- Most scripts under `scripts/production/` and `scripts/workspace/` write their report here by default. Pass `--output` to write somewhere else.

Reports for 0.6.0 to 1.6.0 are in [`archive/`](./archive). They describe earlier plans and are kept for reference only.
