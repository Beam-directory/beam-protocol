# Production Fire Drill

## Objective

A fire drill simulates a production incident while running the named partner workflow. The goal is to stress the operator investigation path, force handoff recovery, and ensure everything from alerts to proof export works under pressure.

## Steps

1. Seed the partner workflow into the digest queue using `npm run production:fire-drill`.
2. Trigger a deliberate anomaly (dead letter, failed intent, latency spike) by updating intent status via the directory admin API.
3. Observe that:
   - the partner health table highlights the affected request as `critical`,
   - the alert surfaces in `/alerts` with related partner records linked,
   - the Operator Inbox shows the notification so an operator can own it.
4. Walk through the proof export flow, download the markdown proof pack, and confirm it is redaction-safe.
5. Run the backup/restore drill in parallel to prove the incident can be recovered on demand.

## Post-drill deliverables

- File `reports/1.0.0-fire-drill.md` describing the incident, timeline, and lessons.
- Update the operator digest to show the queue state after the drill—critical `Partner Health` statuses should correlate to the triggered anomaly.
- Include the fire drill in the release checklist as part of the `Cut Control` gate.

Do not run this drill on the live production partner without a maintenance window; use the quickstart stack or a staging lane.
