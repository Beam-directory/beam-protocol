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
