# Beam Workspaces

Beam Workspaces are the identity and control-plane layer for teams that need more than a raw agent directory.

The goal is not to clone a generic chat workspace. The goal is to give operators one place to answer four questions:

1. Which Beam identities belong to this team?
2. Which identities are allowed to initiate external handoffs?
3. Which partner channels and policies apply to this workspace?
4. Who owns the operational state when a partner-facing workflow stalls?

## The First Data Model

The first workspace foundation adds these records to the directory:

- `workspaces`
  - named control-plane containers for a team or company workflow
- `workspace_members`
  - humans, agents, services, or partner principals attached to a workspace
- `workspace_identity_bindings`
  - Beam identities that are active inside the workspace roster
- `workspace_partner_channels`
  - explicit partner relationships reserved for later routing and health surfaces
- `workspace_policies`
  - the future policy document for external initiation and approval rules

In the first slice, the operator-facing API focuses on workspaces and identity bindings. Partner channels, overview surfaces, and policy enforcement are reserved for the next milestone issues.

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
- `GET /admin/workspaces/:slug/identities`
- `POST /admin/workspaces/:slug/identities`
- `PATCH /admin/workspaces/:slug/identities/:id`

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

## Design Boundary

Beam Workspaces are intentionally narrower than products like OpenAgents Workspace.

Beam is not trying to be the full shared browser, shared files, runtime launcher, and collaboration surface in the first slice.

The differentiator is:

- identity ownership
- external handoff control
- auditability
- policy and operator accountability

That is why Workspaces start as a control-plane surface first.

## What Comes Next

The next issues in the workspace milestone add:

1. richer identity binding and roster behavior
2. a workspace overview API and dashboard page
3. internal vs external thread modeling
4. policy engine v1 for external initiation and approval requirements
