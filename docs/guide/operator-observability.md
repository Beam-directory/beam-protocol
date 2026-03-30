# Operator Observability

This guide is for Beam operators who need to respond to incidents without reading the source code first.

It covers:

- admin setup and login
- the alert -> trace -> audit workflow
- exports and retention controls
- expected operational guardrails

## Roles

Beam uses short-lived admin sessions for the dashboard and observability APIs.

- `admin`: full read/write access, including prune
- `operator`: read-only observability access
- `viewer`: read-only access for audits, traces, and dashboards

Bootstrap roles with environment variables on the directory:

```bash
BEAM_ADMIN_EMAILS=ops@example.com
BEAM_OPERATOR_EMAILS=incident@example.com
BEAM_VIEWER_EMAILS=stakeholder@example.com
```

## Required Admin Setup

The directory must know how to issue and verify admin sessions:

```bash
JWT_SECRET=replace-me
BEAM_DASHBOARD_URL=https://dashboard.example.com
```

For production magic-link delivery, configure either SMTP or Resend:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=beam
SMTP_PASS=replace-me
SMTP_FROM=beam@example.com
```

or:

```bash
RESEND_API_KEY=re_xxx
```

Local development can skip SMTP and Resend. On `localhost`, the directory returns the dev callback URL directly after a magic-link request.

## Sign In

Open the dashboard login page and request a magic link for an authorized email:

```bash
POST /admin/auth/magic-link
```

The dashboard exchanges the token through:

```bash
POST /admin/auth/verify
GET /admin/auth/session
POST /admin/auth/logout
```

The browser stores only the short-lived session token. The old static pasted admin key flow is no longer used.

## Incident Workflow

### 1. Start From Alerts

Use the `Alerts` page first. Each card now shows:

- current metric value
- threshold value
- why Beam raised the alert
- why the current severity is `warning` or `critical`
- direct investigation links

### 2. Jump Into A Trace

Every alert exposes at least one investigation path inside the dashboard:

- filtered intent feed
- direct sample trace
- matching audit history
- specialized dashboards such as `Errors` or `Federation`

The trace page is the fastest way to answer:

- what happened to this nonce
- which lifecycle stage it reached
- whether Shield intervened
- whether related audit events exist

### 3. Confirm With Audit History

Use the `Audit` page when you need control-plane context:

- federation relay actions
- admin and operator actions
- prune history
- role or control changes

Deep links from alerts and traces open the audit view with the relevant nonce, target, or query already applied.

## Exports

Exports are read-only snapshots. Use them when you need to:

- hand off an incident to another team
- preserve evidence before cleanup
- compare windows offline

Available datasets:

- `intents`
- `audit`
- `errors`
- `federation`
- `alerts`

Formats:

- `json`
- `csv`
- `ndjson`

Exports respect the selected alert window and never mutate retained data.

## Retention And Prune

Retention is controlled from the `Alerts` page.

Prune is intentionally guarded:

1. choose the dataset
2. choose the day threshold
3. run an admin-only preview
4. type the dataset name
5. type the exact confirmation phrase
6. prune

The API enforces the confirmation fields server-side, not just in the browser UI.

Important behavior:

- pruning `intents` also removes matching `traces`
- prune is irreversible
- export first if you need a handoff artifact
- every successful prune is written to the audit log as `observability.prune`

## Message Bus Dead Letters

If you want dead-letter operations in the dashboard, configure the message bus in `Settings`:

- Bus URL
- `BEAM_BUS_API_KEY`

This enables:

- dead-letter inspection
- requeue actions
- queue health visibility

## Operational Expectations

Use Beam observability as a triage surface, not just a chart wall.

The normal operator loop is:

1. open alert
2. inspect trace
3. confirm audit history
4. export if needed
5. prune only after evidence is preserved

If you need a full local environment, start with the [Hosted Quickstart](/guide/hosted-quickstart).
