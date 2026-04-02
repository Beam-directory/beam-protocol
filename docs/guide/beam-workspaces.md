# Beam Workspaces

Beam Workspaces are the identity and control-plane layer for teams that need more than a raw agent directory.

The goal is not to clone a generic chat workspace. The goal is to give operators one place to answer four questions:

1. Which Beam identities belong to this team?
2. Which identities are allowed to initiate external handoffs?
3. Which partner channels and policies apply to this workspace?
4. Who owns the operational state when a partner-facing workflow stalls?

## The First Data Model

The workspace foundation now adds these records to the directory:

- `workspaces`
  - named control-plane containers for a team or company workflow
- `workspace_members`
  - humans, agents, services, or partner principals attached to a workspace
- `workspace_identity_bindings`
  - Beam identities that are active inside the workspace roster
- `workspace_partner_channels`
  - explicit partner relationships reserved for later routing and health surfaces
- `workspace_threads`
  - internal-only preparation threads and external handoff threads on one operator timeline
- `workspace_thread_participants`
  - humans, agents, services, and partner identities attached to a workspace thread
- `workspace_policies`
  - the policy document for external initiation and approval rules

The current operator-facing surface now covers workspace creation, identity bindings, lifecycle state, partner channels, thread composition, timeline history, digest delivery, and policy previews.
It also supports direct operator dispatch: a blocked handoff thread can now be approved and sent as a real Beam message from the workspace surface, without waiting for a separate runtime UI.
Partner channels now also resolve back into the local control plane when the target Beam ID belongs to another Beam-managed workspace identity. That gives operators a real cross-workspace route instead of a raw external address.
Each local identity card now also exposes the explicit Beam DID, key history, a one-time local credential reissue flow, and a per-agent partner-control override. That makes it practical to bind imported OpenClaw agents, hand them a Beam identity bundle, and keep partner policy close to the specific agent that is allowed to speak externally.
The workspace page now also exposes an approval queue for manual-review bindings and blocked outbound handoff threads. Operators can approve one binding, pause it, bulk-approve several bindings, or save partner-scoped defaults for known channels without bouncing between the policy, thread, and partner panels.

## Fast local sync demo

If the quickstart stack is already running, you can create a real cross-workspace handoff with one command:

```bash
npm run workspace:sync-demo
```

The command prints:

- a dashboard magic-link login URL
- the source workspace URL
- the target workspace URL
- the trace URL
- the shared Beam nonce

The default local flow creates:

- `acme-sync-demo` as the sending workspace
- `northwind-sync-demo` as the receiving workspace
- `procurement@acme.beam.directory` as the local sender
- `echo@beam.directory` as the routed target identity

The result should be:

1. the source workspace shows a dispatched handoff thread
2. the target workspace shows the mirrored inbound handoff thread automatically
3. both pages point at the same Beam trace nonce

## Import local OpenClaw agents

Beam can now scan the local OpenClaw installation on this Mac and bind persistent agents, workspace agents, and recent subagents into one Beam workspace roster.

The shortest local install path is:

```bash
npm run workspace:openclaw-setup
```

If you want the shortest human-friendly health check after setup, run:

```bash
npm run workspace:openclaw-status
```

That prints:

- a fresh dashboard login link
- the `openclaw-local` workspace URL
- the `openclaw-fleet` URL
- whether the Beam receiver is really live
- whether the managed Beam OpenClaw host service is installed and running
- how many OpenClaw identities were imported
- which routes are currently live over Beam
- the next copy-paste command to send a local proof

That command will:

1. create `ops/quickstart/.env` if needed
2. start the local Beam quickstart stack if it is not already running
3. run the local quickstart smoke test
4. import OpenClaw agents into `openclaw-local`
5. generate missing Beam identities automatically
6. install a managed `beam-send.js` shim so OpenClaw uses the merged Beam identity file automatically
7. install the inbound Beam receiver so imported agents can receive Beam intents directly
8. install a direct `subagent_spawned` hook so fresh OpenClaw subagents sync into Beam immediately

The setup now also seeds the local development ACLs automatically, so imported OpenClaw agents can send `conversation.message` and `task.delegate` across the local fleet and to `echo@beam.directory` without manual ACL patching.
It also installs the local OpenClaw receiver service, which keeps Beam WebSocket connections open for imported identities and forwards incoming intents into the matching OpenClaw runtime session.

## OpenClaw Fleet

Beam now has a first-class OpenClaw Fleet surface for one central control plane with multiple approved hosts.

The dashboard page is:

- `http://localhost:43173/openclaw-fleet`

That fleet view is where operators can:

- issue enrollment tokens for new OpenClaw hosts
- wait for manual host approval or approve a pending host explicitly
- inspect host health, last heartbeat, route counts, and attached identities
- see duplicate identity conflicts before a route silently wins
- revoke a host and disable its routes immediately

The default local setup command now installs the unified host daemon product:

```bash
npm run workspace:openclaw-setup
```

If you want to install or remove the managed daemon explicitly, use:

```bash
npm run workspace:openclaw-host:install
npm run workspace:openclaw-host:uninstall
```

For a foreground host process, use:

```bash
npm run workspace:openclaw-host
```

For a one-command fleet smoke, use:

```bash
npm run workspace:fleet-smoke
```

For a repo-owned fleet digest and escalation summary, use:

```bash
npm run workspace:fleet-digest
```

To run the scheduled digest engine against an already running local Beam stack, use:

```bash
npm run workspace:fleet-digest:tick
```

That command hits the canonical scheduled run path, respects the configured digest schedule by default, and records persistent digest runs plus delivery history.

The fleet enrollment response now also includes a copy-paste install pack with:

- managed macOS install command
- managed Linux install command
- foreground debug command
- status command
- uninstall command

That keeps the operator path explicit: issue enrollment, hand off one command, approve the host, and then watch receipts and health in the fleet view.

The local developer path keeps convenience shortcuts for `localhost`, but the product model is still manual host approval. A non-local OpenClaw host starts as `pending`, appears in the fleet view, and only receives a reusable host credential after an operator approves it.

If you also want Beam to keep picking up newly spawned OpenClaw subagents while you work, run:

```bash
npm run workspace:openclaw-live
```

That keeps a foreground live-sync process alive and re-syncs the Beam workspace whenever:

- a new persistent agent folder appears
- a workspace agent changes
- `~/.openclaw/subagents/runs.json` gets a new subagent run

It is event-driven now. Beam watches the authoritative OpenClaw files directly instead of polling on a fixed interval.

The fleet and workspace surfaces now also show last-delivery receipts for host-backed routes, including status, error code, requested time, and a direct trace link back into Beam.

The fleet surface also gives operators explicit day-2 actions:

- rotate host credentials without reinstalling the whole host
- recover or replace a revoked or lost host with a new credential cutover
- place a host into maintenance mode or drain it before planned work, then resume it explicitly when Beam delivery is safe again
- prefer, disable, or reset route ownership when duplicate Beam identities appear
- open a guided remediation view for one duplicated Beam ID, keep the recommended owner route, and optionally disable the competing routes in one step
- deliver a fleet digest that calls out stale hosts, pending credential work, duplicate conflicts, and missing receipts
- configure one daily digest schedule with a separate escalation mailbox for critical fleet items
- inspect persistent digest run history and delivery history directly in the fleet surface
- work a dedicated credential review queue that highlights overdue rotations, open rotation windows, recovery ownership gaps, and post-recovery cleanup
- complete recovery cleanup after a successful cutover so the host drops back into the normal credential review loop
- inspect a route-health and SLO summary that rolls up missing receipts, failed receipts, latency buckets, and the exact hosts currently degrading fleet delivery
- label hosts with environment and group metadata such as `prod`, `staging`, `lab`, `edge`, or team ownership
- track connector rollout rings (`stable`, `canary`, `pinned`), desired connector versions, and drift directly on each host
- inspect one fleet-wide rollout inventory that shows version buckets, canary coverage, pinned hosts, and drift attention before a connector rollout spreads
- stage guarded bulk actions across multiple hosts before a real revoke, with an explicit confirm phrase
- clear staged revoke reviews again when a maintenance plan changes

The host detail and fleet summary now also expose the operational thresholds behind those actions:

- credential rotation interval, next due time, and the next allowed rotation window
- recovery owner, replacement host label, cutover window notes, and a cleanup-ready state after recovery completes
- maintenance owner, maintenance reason, maintenance start time, and whether Beam delivery is intentionally blocked for that host
- the connector rollout ring, desired connector version, and whether the currently reported connector version has drifted
- receipt coverage across active routes
- p50 / p95 latency, SLO bucket counts, and direct links back to the host, workspace, and latest trace that caused the warning

That means operators can treat the fleet page as the source of truth for both host health and the next required maintenance action, instead of jumping between traces and local host logs.

For the new grouping and guarded bulk actions, the normal operator flow is:

1. filter the fleet by environment or host group
2. select the affected hosts
3. apply shared labels or stage a revoke review in one guarded action
4. verify the staged review directly on the host detail before a real revoke

This keeps labels, host ownership, and revoke-review intent in Beam itself instead of spreading those decisions across local notes or machine-specific scripts.

If you have just pulled new Beam code and want the local containers rebuilt before importing again, run:

```bash
npm run workspace:openclaw-refresh
```

If you want that live sync installed as a background macOS login service, run:

```bash
npm run workspace:openclaw-live:install
```

That installs a LaunchAgent which keeps the OpenClaw-to-Beam live sync running across logins.

To remove it later:

```bash
npm run workspace:openclaw-live:uninstall
```

If you want to run the inbound Beam receiver in the foreground for debugging, use:

```bash
npm run workspace:openclaw-receiver
```

To install or remove the receiver background service explicitly:

```bash
npm run workspace:openclaw-receiver:install
npm run workspace:openclaw-receiver:uninstall
```

If you only want the direct OpenClaw hook that syncs new subagents at spawn time, use:

```bash
npm run workspace:openclaw-spawn-hook:install
```

To remove that hook again:

```bash
npm run workspace:openclaw-spawn-hook:uninstall
```

If you want to install or restore the managed OpenClaw sender explicitly, use:

```bash
npm run workspace:openclaw-beam-send:install
npm run workspace:openclaw-beam-send:uninstall
```

If you only want the import step against an already running stack, use:

```bash
npm run workspace:import-openclaw
```

This importer reads:

- `~/.openclaw/agents/*`
- `~/.openclaw/workspace/agents/*`
- `~/.openclaw/subagents/runs.json`
- `~/.openclaw/workspace/secrets/beam-identities.json`

It then:

1. creates or reuses the workspace `openclaw-local`
2. binds every discovered agent that already has a Beam identity
3. imports recent subagent runs into the same control-plane view
4. writes a generated override file plus a merged identity file for local use

If you also want local Beam identities for agents that do not have one yet, run:

```bash
npm run workspace:import-openclaw -- --register-missing
```

That second mode generates local Beam identities for the missing OpenClaw agents, registers them against the selected directory, and writes the results into:

- `~/.openclaw/workspace/secrets/beam-identities.generated.json`
- `~/.openclaw/workspace/secrets/beam-identities.merged.json`

On macOS, Beam stores generated private keys, API keys, and admin-session cache in Keychain when available. The generated identity file becomes metadata-only, while the merged runtime file is still materialized for local send/runtime compatibility with private `0600` permissions.

The merged file is the easiest local runtime handoff path:

```bash
node /Users/tobik/.openclaw/workspace/skills/beam-protocol/beam-send.js \
  --agent clara \
  --to fischer@coppen.beam.directory \
  --intent conversation.message \
  --payload '{"message":"Ping from the local Beam workspace import."}'
```

With the receiver installed, imported OpenClaw agents can also receive Beam messages directly. A simple local proof is:

```bash
node /Users/tobik/.openclaw/workspace/skills/beam-protocol/beam-send.js \
  --agent archivar \
  --to jarvis@coppen.beam.directory \
  --intent conversation.message \
  --payload '{"message":"Antworte exakt nur mit: BEAM_INBOUND_OK"}' \
  --timeout 90
```

The result should come back through Beam as a real OpenClaw-generated reply instead of the built-in echo service.

## Why Beam Needs This

Beam already has strong external handoff mechanics: identity, signatures, traces, retries, audit, and operator visibility.

What it did not have was a first-class answer to:

- which identities belong together as one operational unit
- which identity can speak for a given workflow
- which workspace is responsible for a partner-facing action

Beam Workspaces close that gap.

## Current Admin API

The first routes are all admin-authenticated and now include the controls required for partner channels, timelines, digests, and digest delivery.

- `GET /admin/workspaces`
- `POST /admin/workspaces`
- `GET /admin/workspaces/:slug`
- `GET /admin/workspaces/:slug/overview`
- `GET /admin/workspaces/:slug/identities`
- `POST /admin/workspaces/:slug/identities`
- `PATCH /admin/workspaces/:slug/identities/:id`
- `PATCH /admin/workspaces/:slug/identities/:id/policy`
- `POST /admin/workspaces/:slug/identities/:id/reissue-local-credential`
- `GET /admin/workspaces/:slug/threads`
- `GET /admin/workspaces/:slug/threads/:id`
- `POST /admin/workspaces/:slug/threads`
- `POST /admin/workspaces/:slug/threads/:id/dispatch`
- `GET /admin/workspaces/:slug/policy`
- `PATCH /admin/workspaces/:slug/policy`
- `GET /admin/workspaces/:slug/partner-channels`
- `POST /admin/workspaces/:slug/partner-channels`
- `PATCH /admin/workspaces/:slug/partner-channels/:id`
- `GET /admin/workspaces/:slug/timeline`
- `GET /admin/workspaces/:slug/digest`
- `POST /admin/workspaces/:slug/digest/deliver`

### Create a workspace

```json
{
  "name": "Acme Ops Workspace",
  "slug": "acme-ops",
  "description": "Control plane for internal and partner-facing identities.",
  "defaultThreadScope": "internal",
  "externalHandoffsEnabled": true
}
```

### Bind a Beam identity

```json
{
  "beamId": "ops-bot@beam.directory",
  "bindingType": "agent",
  "owner": "ops@example.com",
  "runtimeType": "codex",
  "policyProfile": "default",
  "defaultThreadScope": "internal",
  "canInitiateExternal": true,
  "notes": "Primary internal operator agent."
}
```

### Reissue a one-time local credential bundle

Use this when a local runtime or imported OpenClaw agent needs a fresh Beam identity file, API key, and signing keypair.

```bash
curl -X POST \
  -H "Authorization: Bearer <admin-session-token>" \
  http://localhost:43100/admin/workspaces/openclaw-local/identities/12/reissue-local-credential
```

The response includes:

- `beamId`
- `did`
- `apiKey`
- `publicKey`
- `privateKey`
- `directoryUrl`
- URLs for DID resolution, agent detail, and key history

This bundle is returned only at issuance time, so copy or download it immediately from the dashboard.

### Add a per-agent partner override

Use this when one workspace identity should have a tighter or looser outbound policy than the workspace default.

```json
{
  "externalInitiation": "allow",
  "allowedPartners": [
    "finance@northwind.beam.directory",
    "*@partner.beam.directory"
  ]
}
```

### Create an internal workspace thread

```json
{
  "kind": "internal",
  "title": "Prepare approval handoff",
  "summary": "Align buyer owner and evidence before external send.",
  "owner": "ops@example.com",
  "participants": [
    {
      "principalId": "ops@example.com",
      "principalType": "human",
      "displayName": "Ops Owner",
      "role": "owner"
    },
    {
      "principalId": "ops-bot@beam.directory",
      "principalType": "agent",
      "beamId": "ops-bot@beam.directory",
      "workspaceBindingId": 12,
      "role": "participant"
    }
  ]
}
```

### Create a linked handoff thread

```json
{
  "kind": "handoff",
  "title": "Quote approval handoff",
  "summary": "External finance approval with async proof.",
  "owner": "ops@example.com",
  "workflowType": "quote.approval",
  "linkedIntentNonce": "nonce-thread-handoff",
  "participants": [
    {
      "principalId": "ops-bot@beam.directory",
      "principalType": "agent",
      "beamId": "ops-bot@beam.directory",
      "workspaceBindingId": 12,
      "role": "owner"
    },
    {
      "principalId": "finance@northwind.beam.directory",
      "principalType": "partner",
      "beamId": "finance@northwind.beam.directory",
      "workspaceBindingId": 13,
      "role": "participant"
    }
  ]
}
```

### Create a blocked handoff draft

Blocked handoff drafts are valid without a `linkedIntentNonce`. This is the control-plane representation of "the operator has staged the outbound motion, but policy or approval is still stopping it."
The draft now carries both the target Beam intent and the structured payload that should be sent once the operator approves the motion.

```json
{
  "kind": "handoff",
  "title": "Quote approval draft",
  "summary": "Blocked until the named approver confirms the partner route.",
  "owner": "ops@example.com",
  "status": "blocked",
  "workflowType": "quote.approval",
  "draftIntentType": "task.delegate",
  "draftPayload": {
    "task": "Confirm the approval lane and return the next operator action.",
    "context": "Workspace-triggered cross-instance approval dispatch.",
    "priority": "high"
  },
  "participants": [
    {
      "principalId": "ops-bot@beam.directory",
      "principalType": "agent",
      "beamId": "ops-bot@beam.directory",
      "workspaceBindingId": 12,
      "role": "owner"
    },
    {
      "principalId": "finance@northwind.beam.directory",
      "principalType": "partner",
      "beamId": "finance@northwind.beam.directory",
      "workspaceBindingId": 13,
      "role": "participant"
    }
  ]
}
```

### Dispatch a blocked handoff thread through Beam

This is the approval-path action. The workspace thread remains the operator record, but Beam generates the real cross-instance trace and links it back to the thread.

If the thread already stores a draft intent and draft payload, the dispatch body can be empty:

```json
{}
```

You can also override the stored draft and dispatch a specific intent explicitly:

```json
{
  "intentType": "quote.request",
  "payload": {
    "sku": "INV-APPROVAL",
    "quantity": 1,
    "shipTo": "Acme HQ"
  }
}
```

The dispatch route now sends the selected Beam intent, persists the draft on the thread, and attaches workspace, thread, partner-channel, and approval context automatically:

- under `payload.context.beam` for `conversation.message`
- under `payload.beamContext` for all other intents

If the selected partner channel resolves to another local Beam-managed workspace identity, dispatch also mirrors the handoff into that target workspace as an inbound thread. The dispatch response then includes a `workspaceSync` block with the target workspace slug and thread id.
That local routed handoff runs under workspace policy, so operators do not need to duplicate the same trust edge again as a separate low-level intent ACL between the two local identities.

### Create a partner channel

```json
{
  "partnerBeamId": "finance@northwind.beam.directory",
  "label": "Northwind Finance",
  "owner": "ops@example.com",
  "status": "trial",
  "notes": "Primary finance route for invoice approvals."
}
```

When you fetch partner channels, each channel may now include a `workspaceRoute` block. This appears when the target `partnerBeamId` is also bound as a non-partner identity inside another Beam workspace. The dashboard uses that to surface "routes into workspace X" instead of showing only a bare Beam ID.

### Patch a workspace policy

```json
{
  "defaults": {
    "externalInitiation": "deny",
    "allowedPartners": ["*@northwind.beam.directory"]
  },
  "bindingRules": [
    {
      "policyProfile": "finance-outbound",
      "externalInitiation": "allow",
      "allowedPartners": ["finance@northwind.beam.directory"]
    }
  ],
  "workflowRules": [
    {
      "workflowType": "quote.approval",
      "requireApproval": true,
      "allowedPartners": ["finance@northwind.beam.directory"],
      "approvers": ["ops@example.com", "approvals@example.com"]
    }
  ],
  "metadata": {
    "notes": "Finance outbound handoffs need named approvers."
  }
}
```

### Deliver a workspace digest

```json
{
  "days": 7,
  "email": "ops@example.com"
}
```

The digest summarizes:

- blocked external motion
- stale or unowned identities
- degraded or blocked partner channels
- blocked or ownerless threads
- recent timeline entries that explain what changed

## Design Boundary

Beam Workspaces are intentionally narrower than products like OpenAgents Workspace.

Beam is not trying to be the full shared browser, shared files, runtime launcher, and collaboration surface in the first slice.

The differentiator is:

- identity ownership
- external handoff control
- auditability
- policy and operator accountability

That is why Workspaces start as a control-plane surface first.

## Current Operator View

The dashboard now surfaces:

1. workspace overview metrics for stale identities, manual review, blocked outbound motion, and the digest queue with overdue action items
2. internal and external workspace threads on one page, covering blocked handoff drafts, direct `approve and send` actions, linked handoff threads with trace links, and policy-driven workflows
3. partner channel health plus partner-channel ownership controls that can trial, unblock, or escalate a partner relationship
4. runtime-backed identity visibility that now distinguishes live WebSocket presence, HTTP endpoints, and effective delivery mode for each local binding
4. identity lifecycle cards showing `lastSeenAgeHours`, ownership state, and controls for pausing or toggling outbound permission
5. the timeline drawer that collapses partner, policy, identity, thread, and digest events so the operator sees a unified audit trail
6. the digest delivery panel that bottles action items, escalations, and summary stats and can deliver markdown to the operator mailbox

This keeps Beam Workspace focused on identity ownership, policy, partner health, and cross-company control instead of drifting into a generic collaboration product.
