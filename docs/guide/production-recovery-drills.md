# Production Recovery Drills

## Purpose

Beam has to survive infrastructure failures while running a live partner workflow. Recovery drills prove backups, restores, and environment parity before a production partner goes live. This guide covers the drills that turn the directory, message bus, and dashboard from "working" to "recoverable."

## Backup and Restore

1. Stop the Directory and Message Bus services.
2. Snapshot the `beam-directory.db` and `beam-bus.sqlite` files under `ops/quickstart/volumes` (or the production path).
3. Start clean instances of the directory and bus pointing at new empty files.
4. Restore the snapshots into the new databases and validate that:
   - agents, beta requests, and operator notifications appear via the `/health` and `/admin/workspaces` endpoints,
   - the directory can replay `intent` traces, and the message bus still honors nonces.
5. Log the recovery steps and timestamps in the drill report so operators can certify the backup polarity.

## Environment Parity

1. Verify that staging, demo, and production workspaces use the same Node 20 runtime, release metadata, and config keys.
2. Generate environment snapshots by running `npm run production:parity` so the current API release truth and public status surfaces stay aligned:
   - compares schema hashes,
   - ensures release truth responses match (by hitting `/release` and `/health`),
   - checks that the public site, docs, and dashboard share the same `VITE_API_URL`.
3. Capture the parity results in `reports/1.0.0-parity-check.md` so the production partner can see what is aligned.

## Drilling cadence

- Schedule the full recovery drill once per sprint or after any schema or infrastructure change.
- Document each run in `reports/1.0.0-recovery-drill.md` including:
  - which environments were reset,
  - what backups were taken and where they are stored,
  - validation commands used (`npm run production:backup-restore`, `npm run production:parity`, `npm run release:smoke`, etc.).
- Keep the latest parity evidence beside it in `reports/1.0.0-parity-check.md`.

Add the validated drill to the `1.0.0` cut checklist as evidence for resilience.
