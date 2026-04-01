# Operator Digest

## Goal

The Partner Digest is the recurring briefing that keeps an operator informed about who owns which production partner thread, what is overdue, what meetings are impending, and where the queue is potentially unhealthy. It replaces spreadsheets and ad-hoc reminders with a reproducible snapshot that can be emailed, exported, or reviewed inside the dashboard.

## Concepts

- **Window:** Spotlight partner threads touched in the last `N` days (default `7`) while keeping the digest readable.
- **Action items:** Prioritized rows per partner request that factor in reminders, meetings, stage age, and next actions.
- **Owner filtering:** Narrow the digest to a specific operator before shipping it to email.
- **Redaction-safe summary:** The digest output avoids leaking internal notes or sensitive inbox links.

## Workflow

1. Query `GET /admin/partner-digest?days=7&owner=ops@example.com` to see the current queue, urgency scores, and the markdown preview.
2. Use the dashboard’s **Partner Ops** page to view the same action items, healthy/critical partner rows, and the weekly digest preview card.
3. Deliver the digest via `POST /admin/partner-digest/deliver` when the window should hit an inbox; include `days`, `owner`, and the `email` of the stakeholder who needs the reminder.
4. Operators can copy the markdown preview from the UI or download it via the `/admin/partner-digest?format=markdown` endpoint for manual sharing.

## Automated follow-ups

- When a partner thread has a **follow-up due**, **meeting soon**, or is **stale**, it appears high in the action queue and contributes to the `due now` metric.
- Each digest run records the most recent `reminderAt`, `nextMeetingAt`, and `nextAction` timestamps so owners can see why the row was flagged.
- The digest plays well with the **Operator Alert** flows—alerts now carry links to the affected partner record, so clicking from `/alerts` opens the right beta request.

## Operator readiness

Operators should add the digest delivery to their weekly cadence. The reproducible path now lives at `npm run production:digest`, which exercises the digest endpoint, records the action queue, and attempts delivery when SMTP or Resend is configured.

For release documentation, capture who owns the digest, how often it runs, and what follow-up thread or partner list it touches. The repo-visible evidence file is [reports/1.0.0-operator-digest.md](/Users/tobik/Documents/BEAM/beam-protocol/reports/1.0.0-operator-digest.md).
