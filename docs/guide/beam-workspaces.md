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

The current operator-facing surface now covers workspace creation, identity bindings, overview metrics, thread timelines, and policy previews.

## Why Beam Needs This

Beam already has strong external handoff mechanics: identity, signatures, traces, retries, audit, and operator visibility.

What it did not have was a first-class answer to:

- which identities belong together as one operational unit
- which identity can speak for a given workflow
- which workspace is responsible for a partner-facing action

Beam Workspaces close that gap.

## Current Admin API

The first routes are all admin-authenticated:

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
- `GET /admin/workspaces/:slug/policy`
- `PATCH /admin/workspaces/:slug/policy`

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

1. workspace overview metrics for stale identities, manual review, and blocked outbound motion
2. internal and external workspace threads on one page, with direct trace links for handoff threads
3. policy previews showing which bindings can initiate external motion and which workflows require approvals

This keeps Beam Workspace focused on identity ownership, policy, and cross-company control instead of drifting into a generic collaboration product.
