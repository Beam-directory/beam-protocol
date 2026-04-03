import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createAcl } from './acl.js'
import { createAdminSession } from './admin-auth.js'
import {
  approveOpenClawHost,
  createDatabase,
  createOpenClawEnrollmentRequest,
  createOpenClawHost,
  finalizeIntentLog,
  getIntentLogByNonce,
  listOpenClawResolvedRoutesByBeamId,
  logIntentStart,
  recordOpenClawHostHeartbeat,
  registerAgent,
  setIntentLifecycleStatus,
  syncOpenClawHostRoutes,
  assignDirectoryRole,
  updateOpenClawHost,
} from './db.js'
import { getLocalDirectoryUrl } from './federation.js'
import { createApp } from './server.js'
import { RelayError, relayIntentFromHttp } from './websocket.js'
import type { IntentFrame, OpenClawRouteSource } from './types.js'

function createAdminHeaders(
  db: ReturnType<typeof createDatabase>,
  email = 'ops@example.com',
  role: 'admin' | 'operator' | 'viewer' = 'admin',
) {
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
  assignDirectoryRole(db, {
    userId: email,
    role,
    directoryUrl: getLocalDirectoryUrl(),
  })
  const session = createAdminSession(db, { email, role })
  return {
    Authorization: `Bearer ${session.token}`,
  }
}

type FixtureAgent = {
  beamId: string
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
  publicKeyBase64: string
}

function createFixtureAgent(beamId: string): FixtureAgent {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    beamId,
    privateKey,
    publicKeyBase64: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
  }
}

function registerFixtureAgent(
  db: ReturnType<typeof createDatabase>,
  agent: FixtureAgent,
  displayName: string,
) {
  registerAgent(db, {
    beamId: agent.beamId,
    displayName,
    capabilities: ['conversation.message'],
    publicKey: agent.publicKeyBase64,
    org: 'openclaw',
  })
}

function signIntentFrame(
  frame: Omit<IntentFrame, 'signature'>,
  privateKey: FixtureAgent['privateKey'],
): IntentFrame {
  const payload = JSON.stringify({
    type: 'intent',
    from: frame.from,
    to: frame.to,
    intent: frame.intent,
    payload: frame.payload,
    timestamp: frame.timestamp,
    nonce: frame.nonce,
  })

  return {
    ...frame,
    signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  }
}

function createSignedConversationIntent(sender: FixtureAgent, to: string, nonce = randomUUID()): IntentFrame {
  return signIntentFrame({
    v: '1',
    from: sender.beamId,
    to,
    intent: 'conversation.message',
    payload: { message: 'hello from openclaw fleet test' },
    nonce,
    timestamp: new Date().toISOString(),
  }, sender.privateKey)
}

function createApprovedHostWithRoute(
  db: ReturnType<typeof createDatabase>,
  options: {
    label: string
    hostname: string
    beamId: string
    routeKey: string
    routeSource?: OpenClawRouteSource
    workspaceSlug?: string | null
    heartbeatAt?: string
  },
) {
  const enrollment = createOpenClawEnrollmentRequest(db, {
    label: options.label,
    workspaceSlug: options.workspaceSlug ?? null,
  })
  const host = createOpenClawHost(db, {
    enrollmentRequestId: enrollment.id,
    label: options.label,
    hostname: options.hostname,
    os: 'macOS',
    connectorVersion: '1.2.0-test',
    beamDirectoryUrl: 'http://127.0.0.1:43100',
    workspaceSlug: options.workspaceSlug ?? null,
  })
  const approved = approveOpenClawHost(db, {
    id: host.id,
    approvedBy: 'ops@example.com',
  })
  assert.ok(approved)
  syncOpenClawHostRoutes(db, {
    hostId: approved.host.id,
    routes: [{
      beamId: options.beamId,
      workspaceSlug: options.workspaceSlug ?? null,
      routeSource: options.routeSource ?? 'gateway-agent',
      routeKey: options.routeKey,
      runtimeType: 'openclaw:fleet',
      label: options.label,
      connectionMode: 'websocket',
      sessionKey: options.routeKey,
      reportedState: 'live',
      lastSeenAt: options.heartbeatAt ?? new Date().toISOString(),
    }],
  })
  recordOpenClawHostHeartbeat(db, {
    hostId: approved.host.id,
    routeCount: 1,
    connectorVersion: '1.2.0-test',
    heartbeatAt: options.heartbeatAt,
  })
  return approved
}

test('openclaw hosts enroll, approve, heartbeat, and inventory surface in fleet overview', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const atlas = createFixtureAgent('atlas@openclaw.beam.directory')
    registerFixtureAgent(db, atlas, 'Atlas')
    const app = createApp(db)

    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    const workspaceResponse = await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'OpenClaw Local',
        slug: 'openclaw-local',
        externalHandoffsEnabled: true,
      }),
    }))
    assert.equal(workspaceResponse.status, 201)

    const bindingResponse = await app.request(new Request('http://localhost/admin/workspaces/openclaw-local/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: atlas.beamId,
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'openclaw:gateway',
        policyProfile: 'openclaw-default',
        canInitiateExternal: true,
      }),
    }))
    assert.equal(bindingResponse.status, 201)

    const enrollmentResponse = await app.request(new Request('http://localhost/admin/openclaw/hosts/enrollment', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        label: 'OpenClaw Host Alpha',
        workspaceSlug: 'openclaw-local',
        notes: 'Local fleet alpha host',
        expiresInHours: 24,
      }),
    }))
    assert.equal(enrollmentResponse.status, 201)
    const enrollmentBody = await enrollmentResponse.json() as {
      enrollment: {
        id: number
        token: string
        status: string
        installPack: {
          directoryUrl: string
          workspaceSlug: string
          commands: {
            managedMacos: string
            status: string
          }
        }
      }
    }
    assert.equal(enrollmentBody.enrollment.status, 'issued')
    assert.equal(enrollmentBody.enrollment.installPack.directoryUrl, 'http://localhost')
    assert.equal(enrollmentBody.enrollment.installPack.workspaceSlug, 'openclaw-local')
    assert.match(enrollmentBody.enrollment.installPack.commands.managedMacos, /workspace:openclaw-host:install/)
    assert.match(enrollmentBody.enrollment.installPack.commands.managedMacos, new RegExp(enrollmentBody.enrollment.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(enrollmentBody.enrollment.installPack.commands.status, 'npm run workspace:openclaw-status')

    const enrollPendingResponse = await app.request(new Request('http://localhost/openclaw/hosts/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: enrollmentBody.enrollment.token,
        label: 'OpenClaw Host Alpha',
        hostname: 'alpha.local',
        os: 'macOS 14',
        connectorVersion: '1.2.0-test',
        beamDirectoryUrl: 'http://127.0.0.1:43100',
        workspaceSlug: 'openclaw-local',
      }),
    }))
    assert.equal(enrollPendingResponse.status, 202)
    const enrollPendingBody = await enrollPendingResponse.json() as {
      approved: boolean
      host: { id: number; status: string }
    }
    assert.equal(enrollPendingBody.approved, false)
    assert.equal(enrollPendingBody.host.status, 'pending')

    const approveResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${enrollPendingBody.host.id}/approve`, {
      method: 'POST',
      headers: createAdminHeaders(db, 'admin@example.com', 'admin'),
    }))
    assert.equal(approveResponse.status, 200)
    const approveBody = await approveResponse.json() as {
      credential: string
      host: { id: number; status: string; healthStatus: string }
    }
    assert.match(approveBody.credential, /^bh_/)
    assert.equal(approveBody.host.status, 'active')

    const heartbeatResponse = await app.request(new Request('http://localhost/openclaw/hosts/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${approveBody.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        routeCount: 1,
        connectorVersion: '1.2.0-test',
        details: { pid: 42 },
      }),
    }))
    assert.equal(heartbeatResponse.status, 200)

    const inventoryResponse = await app.request(new Request('http://localhost/openclaw/hosts/inventory', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${approveBody.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectorVersion: '1.2.0-test',
        beamDirectoryUrl: 'http://127.0.0.1:43100',
        workspaceSlug: 'openclaw-local',
        label: 'OpenClaw Host Alpha',
        hostname: 'alpha.local',
        os: 'macOS 14',
        routes: [{
          beamId: atlas.beamId,
          workspaceSlug: 'openclaw-local',
          routeSource: 'gateway-agent',
          routeKey: 'alpha-route',
          runtimeType: 'openclaw:gateway',
          label: 'Atlas',
          connectionMode: 'websocket',
          sessionKey: 'session-alpha',
          reportedState: 'live',
          metadata: { controller: 'alpha' },
        }],
      }),
    }))
    assert.equal(inventoryResponse.status, 200)

    const overviewResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewResponse.status, 200)
    const overviewBody = await overviewResponse.json() as {
      summary: {
        totalHosts: number
        activeHosts: number
        pendingHosts: number
        revokedHosts: number
        staleHosts: number
        liveRoutes: number
        staleRoutes: number
        conflictRoutes: number
        endedRoutes: number
        failedReceipts: number
        routesMissingReceipts: number
        receiptCoverageRatio: number | null
        degradedHosts: number
        latencySloBreaches: number
        rotationDueHosts: number
        recoveryRunbooksOpen: number
      duplicateIdentityConflicts: number
      pendingCredentialActions: number
      actionItems: number
      criticalItems: number
      templateDriftedWorkspaces: number
      suggestedRemediations: number
      criticalRemediations: number
      driftedHosts: number
      reconciliationCleanupRequiredHosts: number
      orphanedRoutes: number
      garbageCollectableRoutes: number
    }
      hosts: Array<{
        id: number
        healthStatus: string
        workspaceSlug: string | null
        summary: { live: number }
      }>
      conflicts: unknown[]
    }
    assert.deepEqual(overviewBody.summary, {
      totalHosts: 1,
      activeHosts: 1,
      pendingHosts: 0,
      revokedHosts: 0,
      staleHosts: 0,
      liveRoutes: 1,
      staleRoutes: 0,
      conflictRoutes: 0,
      endedRoutes: 0,
      failedReceipts: 0,
      routesMissingReceipts: 1,
      receiptCoverageRatio: 0,
      degradedHosts: 1,
      latencySloBreaches: 0,
      rotationDueHosts: 0,
      recoveryRunbooksOpen: 0,
      duplicateIdentityConflicts: 0,
      pendingCredentialActions: 0,
      actionItems: 1,
      criticalItems: 0,
      templateDriftedWorkspaces: 0,
      suggestedRemediations: 1,
      criticalRemediations: 0,
      driftedHosts: 0,
      reconciliationCleanupRequiredHosts: 0,
      orphanedRoutes: 0,
      garbageCollectableRoutes: 0,
    })
    assert.equal(overviewBody.hosts[0]?.workspaceSlug, 'openclaw-local')
    assert.equal(overviewBody.hosts[0]?.healthStatus, 'healthy')
    assert.equal(overviewBody.hosts[0]?.summary.live, 1)
    assert.equal(overviewBody.conflicts.length, 0)

    const identitiesResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${approveBody.host.id}/identities`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(identitiesResponse.status, 200)
    const identitiesBody = await identitiesResponse.json() as {
      total: number
      identities: Array<{
        beamId: string
        route: {
          hostHealth: string
          runtimeSessionState: string
          routeSource: string
        }
        bindings: Array<{ workspaceSlug: string | null }>
      }>
    }
    assert.equal(identitiesBody.total, 1)
    assert.equal(identitiesBody.identities[0]?.beamId, atlas.beamId)
    assert.equal(identitiesBody.identities[0]?.route.hostHealth, 'healthy')
    assert.equal(identitiesBody.identities[0]?.route.runtimeSessionState, 'live')
    assert.equal(identitiesBody.identities[0]?.route.routeSource, 'gateway-agent')
    assert.equal(identitiesBody.identities[0]?.bindings[0]?.workspaceSlug, 'openclaw-local')

    const workspaceIdentitiesResponse = await app.request(new Request('http://localhost/admin/workspaces/openclaw-local/identities', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(workspaceIdentitiesResponse.status, 200)
    const workspaceIdentitiesBody = await workspaceIdentitiesResponse.json() as {
      bindings: Array<{
        beamId: string
        hostId: number | null
        hostLabel: string | null
        hostHealth: string | null
        routeSource: string | null
        runtimeSessionState: string | null
      }>
    }
    assert.equal(workspaceIdentitiesBody.bindings[0]?.beamId, atlas.beamId)
    assert.equal(workspaceIdentitiesBody.bindings[0]?.hostId, approveBody.host.id)
    assert.equal(workspaceIdentitiesBody.bindings[0]?.hostLabel, 'OpenClaw Host Alpha')
    assert.equal(workspaceIdentitiesBody.bindings[0]?.hostHealth, 'healthy')
    assert.equal(workspaceIdentitiesBody.bindings[0]?.routeSource, 'gateway-agent')
    assert.equal(workspaceIdentitiesBody.bindings[0]?.runtimeSessionState, 'live')
  } finally {
    db.close()
  }
})

test('fleet policy packs, workspace templates, and guided remediation can restore drifted workspaces', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const atlas = createFixtureAgent('atlas-template@openclaw.beam.directory')
    registerFixtureAgent(db, atlas, 'Atlas Template')

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    const workspaceResponse = await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'OpenClaw Local',
        slug: 'openclaw-local',
        description: 'Temporary workspace description',
        defaultThreadScope: 'internal',
        externalHandoffsEnabled: false,
      }),
    }))
    assert.equal(workspaceResponse.status, 201)

    const bindingResponse = await app.request(new Request('http://localhost/admin/workspaces/openclaw-local/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: atlas.beamId,
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'openclaw:gateway',
        policyProfile: 'openclaw-prod',
        canInitiateExternal: true,
      }),
    }))
    assert.equal(bindingResponse.status, 201)

    const approved = createApprovedHostWithRoute(db, {
      label: 'Template Alpha',
      hostname: 'template-alpha.local',
      beamId: atlas.beamId,
      routeKey: 'template-alpha-route',
      workspaceSlug: 'openclaw-local',
    })

    const profileResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${approved.host.id}/profile`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        environmentLabel: 'prod',
        groupLabels: ['production'],
      }),
    }))
    assert.equal(profileResponse.status, 200)

    const policyPackResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/policy-packs/prod-default', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        label: 'Production default',
        description: 'Production outbound policy',
        hostGroupLabel: 'production',
        policy: {
          defaults: {
            externalInitiation: 'deny',
            allowedPartners: ['finance@northwind.beam.directory'],
          },
          bindingRules: [
            {
              policyProfile: 'openclaw-prod',
              externalInitiation: 'allow',
              allowedPartners: ['finance@northwind.beam.directory'],
            },
          ],
          workflowRules: [
            {
              workflowType: 'quote.approval',
              requireApproval: true,
              allowedPartners: ['finance@northwind.beam.directory'],
              approvers: ['ops@example.com'],
            },
          ],
          metadata: {
            notes: 'Production hosts require named approval.',
          },
        },
      }),
    }))
    assert.equal(policyPackResponse.status, 200)

    const templateResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/workspace-templates/prod-workspace', {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        label: 'Production workspace',
        description: 'Production workspace template',
        hostGroupLabel: 'production',
        policyPackKey: 'prod-default',
        template: {
          defaultThreadScope: 'handoff',
          externalHandoffsEnabled: true,
          description: 'Production partner workspace',
        },
      }),
    }))
    assert.equal(templateResponse.status, 200)

    const listPolicyPacksResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/policy-packs', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(listPolicyPacksResponse.status, 200)
    const listPolicyPacksBody = await listPolicyPacksResponse.json() as {
      total: number
      policyPacks: Array<{
        key: string
        policy: {
          defaults: {
            externalInitiation: string
          }
        }
      }>
    }
    assert.equal(listPolicyPacksBody.total, 1)
    assert.equal(listPolicyPacksBody.policyPacks[0]?.key, 'prod-default')
    assert.equal(listPolicyPacksBody.policyPacks[0]?.policy.defaults.externalInitiation, 'deny')

    const listTemplatesResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/workspace-templates', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(listTemplatesResponse.status, 200)
    const listTemplatesBody = await listTemplatesResponse.json() as {
      total: number
      workspaceTemplates: Array<{
        key: string
        policyPackKey: string | null
        template: {
          defaultThreadScope: string
          externalHandoffsEnabled: boolean
        }
      }>
    }
    assert.equal(listTemplatesBody.total, 1)
    assert.equal(listTemplatesBody.workspaceTemplates[0]?.key, 'prod-workspace')
    assert.equal(listTemplatesBody.workspaceTemplates[0]?.policyPackKey, 'prod-default')

    const overviewBeforeResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewBeforeResponse.status, 200)
    const overviewBeforeBody = await overviewBeforeResponse.json() as {
      templates: {
        summary: {
          policyPacks: number
          workspaceTemplates: number
          templatedWorkspaces: number
          driftedWorkspaces: number
        }
        attentionWorkspaces: Array<{
          workspaceSlug: string
          expectedTemplateKey: string | null
          reason: string
        }>
      }
      remediation: {
        suggested: Array<{
          kind: string
          workspaceSlug: string | null
          templateKey: string | null
          requiresConfirmation: boolean
        }>
      }
    }
    assert.equal(overviewBeforeBody.templates.summary.policyPacks, 1)
    assert.equal(overviewBeforeBody.templates.summary.workspaceTemplates, 1)
    assert.equal(overviewBeforeBody.templates.summary.templatedWorkspaces, 0)
    assert.equal(overviewBeforeBody.templates.summary.driftedWorkspaces, 1)
    assert.equal(overviewBeforeBody.templates.attentionWorkspaces[0]?.workspaceSlug, 'openclaw-local')
    assert.equal(overviewBeforeBody.templates.attentionWorkspaces[0]?.expectedTemplateKey, 'prod-workspace')
    assert.match(overviewBeforeBody.templates.attentionWorkspaces[0]?.reason ?? '', /expected workspace template/i)
    assert.ok(overviewBeforeBody.remediation.suggested.some((item) =>
      item.kind === 'reapply_template'
      && item.workspaceSlug === 'openclaw-local'
      && item.templateKey === 'prod-workspace'
      && item.requiresConfirmation,
    ))

    const remediationResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/remediations/apply', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'reapply_template',
        workspaceSlug: 'openclaw-local',
        templateKey: 'prod-workspace',
        confirmPhrase: 'REAPPLY_TEMPLATE',
        note: 'Restore production fleet defaults',
      }),
    }))
    assert.equal(remediationResponse.status, 200)
    const remediationBody = await remediationResponse.json() as {
      ok: boolean
      kind: string
      workspace: {
        slug: string
        description: string | null
        defaultThreadScope: string
        externalHandoffsEnabled: boolean
      }
      policy: {
        defaults: {
          externalInitiation: string
          allowedPartners: string[]
        }
        workflowRules: Array<{
          workflowType: string
          requireApproval: boolean
          approvers: string[]
        }>
        metadata: {
          template: {
            templateKey: string | null
            policyPackKey: string | null
            hostGroupLabel: string | null
            appliedBy: string | null
          } | null
        }
      }
    }
    assert.equal(remediationBody.ok, true)
    assert.equal(remediationBody.kind, 'reapply_template')
    assert.equal(remediationBody.workspace.slug, 'openclaw-local')
    assert.equal(remediationBody.workspace.description, 'Production partner workspace')
    assert.equal(remediationBody.workspace.defaultThreadScope, 'handoff')
    assert.equal(remediationBody.workspace.externalHandoffsEnabled, true)
    assert.equal(remediationBody.policy.defaults.externalInitiation, 'deny')
    assert.deepEqual(remediationBody.policy.defaults.allowedPartners, ['finance@northwind.beam.directory'])
    assert.equal(remediationBody.policy.workflowRules[0]?.workflowType, 'quote.approval')
    assert.equal(remediationBody.policy.workflowRules[0]?.requireApproval, true)
    assert.deepEqual(remediationBody.policy.workflowRules[0]?.approvers, ['ops@example.com'])
    assert.equal(remediationBody.policy.metadata.template?.templateKey, 'prod-workspace')
    assert.equal(remediationBody.policy.metadata.template?.policyPackKey, 'prod-default')
    assert.equal(remediationBody.policy.metadata.template?.hostGroupLabel, 'production')
    assert.equal(remediationBody.policy.metadata.template?.appliedBy, 'admin@example.com')

    const overviewAfterResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewAfterResponse.status, 200)
    const overviewAfterBody = await overviewAfterResponse.json() as {
      templates: {
        summary: {
          templatedWorkspaces: number
          driftedWorkspaces: number
        }
      }
      remediation: {
        suggested: Array<{
          kind: string
          workspaceSlug: string | null
        }>
      }
    }
    assert.equal(overviewAfterBody.templates.summary.templatedWorkspaces, 1)
    assert.equal(overviewAfterBody.templates.summary.driftedWorkspaces, 0)
    assert.ok(!overviewAfterBody.remediation.suggested.some((item) =>
      item.kind === 'reapply_template' && item.workspaceSlug === 'openclaw-local',
    ))
  } finally {
    db.close()
  }
})

test('duplicate openclaw routes surface conflicts, block delivery, and clear after revoke', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const sender = createFixtureAgent('sender@openclaw.beam.directory')
    const receiver = createFixtureAgent('atlas@openclaw.beam.directory')
    registerFixtureAgent(db, sender, 'Sender')
    registerFixtureAgent(db, receiver, 'Atlas')
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: 'conversation.message',
      allowedFrom: sender.beamId,
    })

    const app = createApp(db)

    const hostA = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Alpha',
      hostname: 'alpha.local',
      beamId: receiver.beamId,
      routeKey: 'atlas-alpha',
      workspaceSlug: 'openclaw-local',
    })
    const hostB = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Bravo',
      hostname: 'bravo.local',
      beamId: receiver.beamId,
      routeKey: 'atlas-bravo',
      workspaceSlug: 'openclaw-local',
    })

    const overviewResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewResponse.status, 200)
    const overviewBody = await overviewResponse.json() as {
      summary: {
        duplicateIdentityConflicts: number
      }
      conflicts: Array<{
        beamId: string
        routeCount: number
      }>
    }
    assert.equal(overviewBody.summary.duplicateIdentityConflicts, 1)
    assert.equal(overviewBody.conflicts[0]?.beamId, receiver.beamId)
    assert.equal(overviewBody.conflicts[0]?.routeCount, 2)

    const conflictedRoutes = listOpenClawResolvedRoutesByBeamId(db, receiver.beamId)
    assert.equal(conflictedRoutes.length, 2)
    assert.deepEqual(conflictedRoutes.map((route) => route.runtime_session_state), ['conflict', 'conflict'])

    const nonce = randomUUID()
    await assert.rejects(
      relayIntentFromHttp(db, createSignedConversationIntent(sender, receiver.beamId, nonce), 250),
      (error: unknown) => error instanceof RelayError && error.code === 'FORBIDDEN' && error.message.includes('multiple OpenClaw hosts'),
    )
    assert.equal(getIntentLogByNonce(db, nonce)?.error_code, 'HOST_ROUTE_CONFLICT')

    const revokeResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${hostB.host.id}/revoke`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'duplicate identity conflict', confirmPhrase: 'REVOKE_HOST' }),
    }))
    assert.equal(revokeResponse.status, 200)

    const routesAfterRevoke = listOpenClawResolvedRoutesByBeamId(db, receiver.beamId)
    assert.deepEqual(
      routesAfterRevoke.map((route) => ({
        hostId: route.host_id,
        state: route.runtime_session_state,
      })),
      [
        { hostId: hostA.host.id, state: 'live' },
        { hostId: hostB.host.id, state: 'revoked' },
      ],
    )

    const overviewAfterRevokeResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewAfterRevokeResponse.status, 200)
    const overviewAfterRevokeBody = await overviewAfterRevokeResponse.json() as {
      summary: {
        revokedHosts: number
        duplicateIdentityConflicts: number
      }
      conflicts: unknown[]
    }
    assert.equal(overviewAfterRevokeBody.summary.revokedHosts, 1)
    assert.equal(overviewAfterRevokeBody.summary.duplicateIdentityConflicts, 0)
    assert.equal(overviewAfterRevokeBody.conflicts.length, 0)
  } finally {
    db.close()
  }
})

test('openclaw host credentials rotate and recover without rebuilding workspace state', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const receiver = createFixtureAgent('atlas@openclaw.beam.directory')
    registerFixtureAgent(db, receiver, 'Atlas')
    const app = createApp(db)

    const host = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Rotate',
      hostname: 'rotate.local',
      beamId: receiver.beamId,
      routeKey: 'atlas-rotate',
      workspaceSlug: 'openclaw-local',
    })

    const rotateResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/rotate`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmPhrase: 'ROTATE_HOST' }),
    }))
    assert.equal(rotateResponse.status, 200)
    const rotateBody = await rotateResponse.json() as {
      credential: string
      host: {
        credentialState: string
      }
    }
    assert.match(rotateBody.credential, /^bh_/)
    assert.equal(rotateBody.host.credentialState, 'rotation_pending')

    const oldHeartbeatResponse = await app.request(new Request('http://localhost/openclaw/hosts/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${host.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        routeCount: 1,
        connectorVersion: '1.3.0-test',
      }),
    }))
    assert.equal(oldHeartbeatResponse.status, 401)

    const routesDuringRotate = listOpenClawResolvedRoutesByBeamId(db, receiver.beamId)
    assert.equal(routesDuringRotate[0]?.runtime_session_state, 'stale')

    const newHeartbeatResponse = await app.request(new Request('http://localhost/openclaw/hosts/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rotateBody.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        routeCount: 1,
        connectorVersion: '1.3.0-test',
      }),
    }))
    assert.equal(newHeartbeatResponse.status, 200)

    const routesAfterRotate = listOpenClawResolvedRoutesByBeamId(db, receiver.beamId)
    assert.equal(routesAfterRotate[0]?.runtime_session_state, 'live')

    const revokeResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/revoke`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'recovery drill', confirmPhrase: 'REVOKE_HOST' }),
    }))
    assert.equal(revokeResponse.status, 200)

    const recoverResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/recover`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmPhrase: 'RECOVER_HOST' }),
    }))
    assert.equal(recoverResponse.status, 200)
    const recoverBody = await recoverResponse.json() as {
      credential: string
      host: {
        status: string
        credentialState: string
        revokedAt: string | null
      }
    }
    assert.equal(recoverBody.host.status, 'active')
    assert.equal(recoverBody.host.credentialState, 'recovery_pending')
    assert.equal(recoverBody.host.revokedAt, null)

    const routesDuringRecovery = listOpenClawResolvedRoutesByBeamId(db, receiver.beamId)
    assert.equal(routesDuringRecovery[0]?.runtime_session_state, 'stale')

    const recoverInventoryResponse = await app.request(new Request('http://localhost/openclaw/hosts/inventory', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${recoverBody.credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectorVersion: '1.3.0-test',
        beamDirectoryUrl: 'http://127.0.0.1:43100',
        workspaceSlug: 'openclaw-local',
        label: 'OpenClaw Host Rotate',
        hostname: 'rotate.local',
        os: 'macOS 14',
        routes: [{
          beamId: receiver.beamId,
          workspaceSlug: 'openclaw-local',
          routeSource: 'gateway-agent',
          routeKey: 'atlas-rotate',
          runtimeType: 'openclaw:gateway',
          label: 'Atlas',
          connectionMode: 'websocket',
          sessionKey: 'session-rotate',
          reportedState: 'live',
        }],
      }),
    }))
    assert.equal(recoverInventoryResponse.status, 200)

    const routesAfterRecovery = listOpenClawResolvedRoutesByBeamId(db, receiver.beamId)
    assert.equal(routesAfterRecovery[0]?.runtime_session_state, 'live')
  } finally {
    db.close()
  }
})

test('openclaw host policy patch surfaces rotation windows and recovery runbook state', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const receiver = createFixtureAgent('atlas@openclaw.beam.directory')
    registerFixtureAgent(db, receiver, 'Atlas')

    const host = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Policy',
      hostname: 'policy.local',
      beamId: receiver.beamId,
      routeKey: 'atlas-policy',
      workspaceSlug: 'openclaw-local',
    })
    updateOpenClawHost(db, {
      id: host.host.id,
      credentialIssuedAt: new Date(Date.now() - (4 * 60 * 60 * 1000)).toISOString(),
    })

    const app = createApp(db)
    const policyResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/policy`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        rotationIntervalHours: 1,
        rotationWindowStartHour: 3,
        rotationWindowDurationHours: 2,
        recoveryOwner: 'ops@example.com',
        recoveryStatus: 'prepared',
        recoveryNotes: 'Replace chassis during the next window',
        replacementHostLabel: 'policy-replacement',
        recoveryWindowStartsAt: '2026-04-02T08:00:00.000Z',
        recoveryWindowEndsAt: '2026-04-02T10:00:00.000Z',
      }),
    }))
    assert.equal(policyResponse.status, 200)
    const policyBody = await policyResponse.json() as {
      host: {
        policy: {
          rotation: {
            intervalHours: number
            windowStartHour: number
            windowDurationHours: number
            reviewState: string
            nextRotationDueAt: string | null
            windowOpen: boolean
          }
          recovery: {
            owner: string | null
            status: string
            notes: string | null
            replacementHostLabel: string | null
            windowStartsAt: string | null
            windowEndsAt: string | null
            cleanupRecommended: boolean
          }
        }
      }
    }
    assert.equal(policyBody.host.policy.rotation.intervalHours, 1)
    assert.equal(policyBody.host.policy.rotation.windowStartHour, 3)
    assert.equal(policyBody.host.policy.rotation.windowDurationHours, 2)
    assert.equal(policyBody.host.policy.rotation.reviewState, 'overdue')
    assert.ok(policyBody.host.policy.rotation.nextRotationDueAt)
    assert.equal(typeof policyBody.host.policy.rotation.windowOpen, 'boolean')
    assert.equal(policyBody.host.policy.recovery.owner, 'ops@example.com')
    assert.equal(policyBody.host.policy.recovery.status, 'prepared')
    assert.equal(policyBody.host.policy.recovery.notes, 'Replace chassis during the next window')
    assert.equal(policyBody.host.policy.recovery.replacementHostLabel, 'policy-replacement')
    assert.equal(policyBody.host.policy.recovery.windowStartsAt, '2026-04-02T08:00:00.000Z')
    assert.equal(policyBody.host.policy.recovery.windowEndsAt, '2026-04-02T10:00:00.000Z')
    assert.equal(policyBody.host.policy.recovery.cleanupRecommended, false)

    const overviewResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewResponse.status, 200)
    const overviewBody = await overviewResponse.json() as {
      credentialPolicy: {
        counts: {
          overdue: number
          dueSoon: number
          recoveryPrepared: number
          cleanupRecommended: number
          missingRecoveryOwner: number
        }
        attentionHosts: Array<{
          hostId: number
          recoveryStatus: string
          reasons: string[]
        }>
      }
    }
    assert.equal(overviewBody.credentialPolicy.counts.overdue, 1)
    assert.equal(overviewBody.credentialPolicy.counts.dueSoon, 0)
    assert.equal(overviewBody.credentialPolicy.counts.recoveryPrepared, 1)
    assert.equal(overviewBody.credentialPolicy.counts.cleanupRecommended, 0)
    assert.equal(overviewBody.credentialPolicy.counts.missingRecoveryOwner, 0)
    assert.equal(overviewBody.credentialPolicy.attentionHosts[0]?.hostId, host.host.id)
    assert.equal(overviewBody.credentialPolicy.attentionHosts[0]?.recoveryStatus, 'prepared')
    assert.ok(overviewBody.credentialPolicy.attentionHosts[0]?.reasons.includes('credential rotation overdue'))
    assert.ok(overviewBody.credentialPolicy.attentionHosts[0]?.reasons.includes('recovery runbook prepared'))

    const digestResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/digest', {
      headers: createAdminHeaders(db, 'ops@example.com', 'operator'),
    }))
    assert.equal(digestResponse.status, 200)
    const digestBody = await digestResponse.json() as {
      summary: {
        rotationDueHosts: number
        recoveryRunbooksOpen: number
      }
      actionItems: Array<{
        title: string
        detail: string
      }>
    }
    assert.equal(digestBody.summary.rotationDueHosts, 1)
    assert.equal(digestBody.summary.recoveryRunbooksOpen, 1)
    assert.ok(digestBody.actionItems.some((item) => item.title.includes('due for credential rotation')))
    assert.ok(digestBody.actionItems.some((item) => item.detail.includes('policy-replacement')))

    updateOpenClawHost(db, {
      id: host.host.id,
      recoveryCompletedAt: new Date().toISOString(),
    })

    const completedHostResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(completedHostResponse.status, 200)
    const completedHostBody = await completedHostResponse.json() as {
      host: {
        policy: {
          recovery: {
            status: string
            cleanupRecommended: boolean
          }
        }
      }
    }
    assert.equal(completedHostBody.host.policy.recovery.status, 'completed')
    assert.equal(completedHostBody.host.policy.recovery.cleanupRecommended, true)

    const cleanupResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/recovery/cleanup`, {
      method: 'POST',
      headers: createAdminHeaders(db, 'admin@example.com', 'admin'),
    }))
    assert.equal(cleanupResponse.status, 200)
    const cleanupBody = await cleanupResponse.json() as {
      host: {
        policy: {
          recovery: {
            owner: string | null
            status: string
            notes: string | null
            replacementHostLabel: string | null
            cleanupRecommended: boolean
          }
        }
      }
    }
    assert.equal(cleanupBody.host.policy.recovery.owner, 'ops@example.com')
    assert.equal(cleanupBody.host.policy.recovery.status, 'idle')
    assert.equal(cleanupBody.host.policy.recovery.notes, null)
    assert.equal(cleanupBody.host.policy.recovery.replacementHostLabel, null)
    assert.equal(cleanupBody.host.policy.recovery.cleanupRecommended, false)
  } finally {
    db.close()
  }
})

test('fleet digest schedule persists scheduled runs and delivery history', async () => {
  const db = createDatabase(':memory:')
  const originalSmtpHost = process.env['SMTP_HOST']
  const originalSmtpPort = process.env['SMTP_PORT']
  const originalSmtpUser = process.env['SMTP_USER']
  const originalSmtpPass = process.env['SMTP_PASS']
  const originalSmtpPassword = process.env['SMTP_PASSWORD']
  const originalSmtpFrom = process.env['SMTP_FROM']
  const originalResendApiKey = process.env['RESEND_API_KEY']

  delete process.env['SMTP_HOST']
  delete process.env['SMTP_PORT']
  delete process.env['SMTP_USER']
  delete process.env['SMTP_PASS']
  delete process.env['SMTP_PASSWORD']
  delete process.env['SMTP_FROM']
  delete process.env['RESEND_API_KEY']

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const receiver = createFixtureAgent('atlas@openclaw.beam.directory')
    registerFixtureAgent(db, receiver, 'Atlas')
    const staleAt = new Date(Date.now() - (20 * 60 * 1000)).toISOString()
    createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Digest',
      hostname: 'digest.local',
      beamId: receiver.beamId,
      routeKey: 'atlas-digest',
      workspaceSlug: 'openclaw-local',
      heartbeatAt: staleAt,
    })

    const app = createApp(db)
    const now = new Date()
    const scheduleResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/digest/schedule', {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        enabled: true,
        deliveryEmail: 'ops@example.com',
        escalationEmail: 'critical@example.com',
        runHourUtc: now.getUTCHours(),
        runMinuteUtc: now.getUTCMinutes(),
        escalateOnCritical: true,
      }),
    }))
    assert.equal(scheduleResponse.status, 200)

    const runResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/digest/run', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        triggerKind: 'scheduled',
        deliver: true,
        respectSchedule: true,
      }),
    }))
    assert.equal(runResponse.status, 200)
    const runBody = await runResponse.json() as {
      ok: boolean
      skipped: boolean
      run: {
        id: number
        triggerKind: string
        deliveryState: string
      }
      deliveries: Array<{
        status: string
        errorCode: string | null
        delivery: {
          kind: string
          recipientEmail: string
        }
      }>
    }
    assert.equal(runBody.ok, true)
    assert.equal(runBody.skipped, false)
    assert.equal(runBody.run.triggerKind, 'scheduled')
    assert.equal(runBody.run.deliveryState, 'unavailable')
    assert.ok(runBody.deliveries.some((delivery) => delivery.delivery.kind === 'digest' && delivery.status === 'unavailable'))
    assert.ok(runBody.deliveries.some((delivery) => delivery.delivery.kind === 'escalation' && delivery.status === 'unavailable'))
    assert.ok(runBody.deliveries.some((delivery) => delivery.errorCode === 'EMAIL_DELIVERY_UNAVAILABLE'))

    const digestResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/digest', {
      headers: createAdminHeaders(db, 'ops@example.com', 'operator'),
    }))
    assert.equal(digestResponse.status, 200)
    const digestBody = await digestResponse.json() as {
      summary: {
        staleHosts: number
        escalations: number
      }
      schedule: {
        enabled: boolean
        deliveryEmail: string | null
        escalationEmail: string | null
        lastRunAt: string | null
        lastDeliveryAt: string | null
        lastEscalationDeliveryAt: string | null
      }
      history: {
        runs: Array<{
          id: number
          deliveryState: string
        }>
        deliveries: Array<{
          kind: string
          status: string
        }>
      }
      markdown: string
    }
    assert.equal(digestBody.summary.staleHosts, 1)
    assert.ok(digestBody.summary.escalations >= 1)
    assert.equal(digestBody.schedule.enabled, true)
    assert.equal(digestBody.schedule.deliveryEmail, 'ops@example.com')
    assert.equal(digestBody.schedule.escalationEmail, 'critical@example.com')
    assert.ok(digestBody.schedule.lastRunAt)
    assert.ok(digestBody.schedule.lastDeliveryAt)
    assert.ok(digestBody.schedule.lastEscalationDeliveryAt)
    assert.ok(digestBody.history.runs.length >= 1)
    assert.equal(digestBody.history.runs[0]?.deliveryState, 'unavailable')
    assert.ok(digestBody.history.deliveries.some((delivery) => delivery.kind === 'digest' && delivery.status === 'unavailable'))
    assert.ok(digestBody.history.deliveries.some((delivery) => delivery.kind === 'escalation' && delivery.status === 'unavailable'))
    assert.match(digestBody.markdown, /## Escalations/)
  } finally {
    if (originalSmtpHost === undefined) delete process.env['SMTP_HOST']
    else process.env['SMTP_HOST'] = originalSmtpHost
    if (originalSmtpPort === undefined) delete process.env['SMTP_PORT']
    else process.env['SMTP_PORT'] = originalSmtpPort
    if (originalSmtpUser === undefined) delete process.env['SMTP_USER']
    else process.env['SMTP_USER'] = originalSmtpUser
    if (originalSmtpPass === undefined) delete process.env['SMTP_PASS']
    else process.env['SMTP_PASS'] = originalSmtpPass
    if (originalSmtpPassword === undefined) delete process.env['SMTP_PASSWORD']
    else process.env['SMTP_PASSWORD'] = originalSmtpPassword
    if (originalSmtpFrom === undefined) delete process.env['SMTP_FROM']
    else process.env['SMTP_FROM'] = originalSmtpFrom
    if (originalResendApiKey === undefined) delete process.env['RESEND_API_KEY']
    else process.env['RESEND_API_KEY'] = originalResendApiKey
    db.close()
  }
})

test('fleet alert targets persist and test webhook deliveries', async () => {
  const db = createDatabase(':memory:')
  const originalFetch = globalThis.fetch
  let deliveredPayload: Record<string, unknown> | null = null

  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    deliveredPayload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
    return new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)

    const createResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/alerts', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        label: 'Ops webhook',
        deliveryKind: 'webhook',
        destination: 'https://hooks.example.com/openclaw',
        severityThreshold: 'warning',
        enabled: true,
        notes: 'Primary fleet webhook',
        headers: {
          Authorization: 'Bearer secret-token',
        },
      }),
    }))
    assert.equal(createResponse.status, 201)
    const createBody = await createResponse.json() as {
      target: {
        id: number
        label: string
        deliveryKind: string
        destination: string
        metadata: {
          notes: string | null
          headerCount: number
        }
      }
    }
    assert.equal(createBody.target.label, 'Ops webhook')
    assert.equal(createBody.target.deliveryKind, 'webhook')
    assert.equal(createBody.target.metadata.notes, 'Primary fleet webhook')
    assert.equal(createBody.target.metadata.headerCount, 1)

    const testResponse = await app.request(new Request(`http://localhost/admin/openclaw/fleet/alerts/${createBody.target.id}/test`, {
      method: 'POST',
      headers: createAdminHeaders(db, 'ops@example.com', 'operator'),
    }))
    assert.equal(testResponse.status, 200)
    const testBody = await testResponse.json() as {
      ok: boolean
      status: string
      delivery: {
        targetId: number
        status: string
      }
    }
    assert.equal(testBody.ok, true)
    assert.equal(testBody.status, 'delivered')
    assert.equal(testBody.delivery.targetId, createBody.target.id)
    assert.equal(testBody.delivery.status, 'delivered')
    assert.equal(deliveredPayload?.['generatedAt'] ? typeof deliveredPayload?.['generatedAt'] : null, 'string')
    assert.equal((deliveredPayload?.['target'] as { label?: string } | undefined)?.label, 'Ops webhook')

    const digestResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/digest', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(digestResponse.status, 200)
    const digestBody = await digestResponse.json() as {
      alerts: {
        targets: Array<{ id: number }>
        deliveries: Array<{ targetId: number; status: string }>
      }
    }
    assert.equal(digestBody.alerts.targets.length, 1)
    assert.ok(digestBody.alerts.deliveries.some((delivery) => delivery.targetId === createBody.target.id && delivery.status === 'delivered'))
  } finally {
    globalThis.fetch = originalFetch
    db.close()
  }
})

test('destructive host and conflict actions require explicit confirmation phrases', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const receiver = createFixtureAgent('guarded@openclaw.beam.directory')
    registerFixtureAgent(db, receiver, 'Guarded')
    const app = createApp(db)

    const rotateHost = createApprovedHostWithRoute(db, {
      label: 'Rotate Guard Host',
      hostname: 'rotate-guard.local',
      beamId: receiver.beamId,
      routeKey: 'rotate-guard',
    })

    const rotateWithoutConfirm = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${rotateHost.host.id}/rotate`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }))
    assert.equal(rotateWithoutConfirm.status, 400)
    assert.equal((await rotateWithoutConfirm.json() as { errorCode: string }).errorCode, 'CONFIRMATION_REQUIRED')

    const rotateWithConfirm = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${rotateHost.host.id}/rotate`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ confirmPhrase: 'ROTATE_HOST' }),
    }))
    assert.equal(rotateWithConfirm.status, 200)

    createApprovedHostWithRoute(db, {
      label: 'Conflict Alpha',
      hostname: 'conflict-alpha.local',
      beamId: 'duplicate@openclaw.beam.directory',
      routeKey: 'duplicate-alpha',
    })
    createApprovedHostWithRoute(db, {
      label: 'Conflict Bravo',
      hostname: 'conflict-bravo.local',
      beamId: 'duplicate@openclaw.beam.directory',
      routeKey: 'duplicate-bravo',
    })

    const detailResponse = await app.request(new Request('http://localhost/admin/openclaw/conflicts/duplicate%40openclaw.beam.directory', {
      headers: createAdminHeaders(db, 'admin@example.com', 'admin'),
    }))
    assert.equal(detailResponse.status, 200)
    const detailBody = await detailResponse.json() as {
      recommendedRouteId: number
    }

    const resolveWithoutConfirm = await app.request(new Request('http://localhost/admin/openclaw/conflicts/duplicate%40openclaw.beam.directory/resolve', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        preferredRouteId: detailBody.recommendedRouteId,
        disableCompetingRoutes: true,
      }),
    }))
    assert.equal(resolveWithoutConfirm.status, 400)
    assert.equal((await resolveWithoutConfirm.json() as { errorCode: string }).errorCode, 'CONFIRMATION_REQUIRED')

    const resolveWithConfirm = await app.request(new Request('http://localhost/admin/openclaw/conflicts/duplicate%40openclaw.beam.directory/resolve', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        preferredRouteId: detailBody.recommendedRouteId,
        disableCompetingRoutes: true,
        confirmPhrase: 'RESOLVE_CONFLICT',
      }),
    }))
    assert.equal(resolveWithConfirm.status, 200)
  } finally {
    db.close()
  }
})

test('duplicate openclaw conflicts can be resolved by preferring one route owner', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const sender = createFixtureAgent('sender@openclaw.beam.directory')
    const receiver = createFixtureAgent('atlas@openclaw.beam.directory')
    registerFixtureAgent(db, sender, 'Sender')
    registerFixtureAgent(db, receiver, 'Atlas')
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: 'conversation.message',
      allowedFrom: sender.beamId,
    })

    const app = createApp(db)

    const hostA = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Alpha',
      hostname: 'alpha.local',
      beamId: receiver.beamId,
      routeKey: 'atlas-alpha',
      workspaceSlug: 'openclaw-local',
    })
    createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Bravo',
      hostname: 'bravo.local',
      beamId: receiver.beamId,
      routeKey: 'atlas-bravo',
      workspaceSlug: 'openclaw-local',
    })

    const conflictedRoutes = listOpenClawResolvedRoutesByBeamId(db, receiver.beamId)
    assert.deepEqual(conflictedRoutes.map((route) => route.runtime_session_state), ['conflict', 'conflict'])

    const preferResponse = await app.request(new Request(`http://localhost/admin/openclaw/routes/${conflictedRoutes[0]?.id}/prefer`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ note: 'Primary route owner' }),
    }))
    assert.equal(preferResponse.status, 200)

    const routesAfterPreference = listOpenClawResolvedRoutesByBeamId(db, receiver.beamId)
    assert.equal(routesAfterPreference.filter((route) => route.runtime_session_state === 'live').length, 1)
    assert.equal(routesAfterPreference.filter((route) => route.runtime_session_state === 'conflict').length, 1)
    assert.equal(routesAfterPreference.find((route) => route.runtime_session_state === 'live')?.host_id, hostA.host.id)

    const nonce = randomUUID()
    await assert.rejects(
      relayIntentFromHttp(db, createSignedConversationIntent(sender, receiver.beamId, nonce), 250),
      (error: unknown) => error instanceof RelayError && error.code !== 'FORBIDDEN',
    )
    assert.notEqual(getIntentLogByNonce(db, nonce)?.error_code, 'HOST_ROUTE_CONFLICT')

    const overviewResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewResponse.status, 200)
    const overviewBody = await overviewResponse.json() as {
      summary: {
        duplicateIdentityConflicts: number
      }
    }
    assert.equal(overviewBody.summary.duplicateIdentityConflicts, 0)
  } finally {
    db.close()
  }
})

test('conflict detail recommends an owner route and guided resolve can disable competing routes', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const receiver = createFixtureAgent('fleet-conflict@openclaw.beam.directory')
    registerFixtureAgent(db, receiver, 'Fleet Conflict')

    const app = createApp(db)

    createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Alpha',
      hostname: 'alpha.local',
      beamId: receiver.beamId,
      routeKey: 'fleet-conflict-alpha',
      workspaceSlug: 'openclaw-local',
    })
    createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Bravo',
      hostname: 'bravo.local',
      beamId: receiver.beamId,
      routeKey: 'fleet-conflict-bravo',
      workspaceSlug: 'openclaw-local',
    })

    const detailResponse = await app.request(new Request(`http://localhost/admin/openclaw/conflicts/${encodeURIComponent(receiver.beamId)}`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(detailResponse.status, 200)
    const detailBody = await detailResponse.json() as {
      beamId: string
      routeCount: number
      activeConflictRouteCount: number
      recommendedRouteId: number | null
      routes: Array<{
        id: number
        runtimeSessionState: string
      }>
      history: unknown[]
    }
    assert.equal(detailBody.beamId, receiver.beamId)
    assert.equal(detailBody.routeCount, 2)
    assert.equal(detailBody.activeConflictRouteCount, 2)
    assert.ok(typeof detailBody.recommendedRouteId === 'number')
    assert.equal(detailBody.history.length, 0)
    assert.deepEqual(detailBody.routes.map((route) => route.runtimeSessionState), ['conflict', 'conflict'])

    const resolveResponse = await app.request(new Request(`http://localhost/admin/openclaw/conflicts/${encodeURIComponent(receiver.beamId)}/resolve`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        preferredRouteId: detailBody.recommendedRouteId,
        disableCompetingRoutes: true,
        note: 'Guided remediation smoke test',
        confirmPhrase: 'RESOLVE_CONFLICT',
      }),
    }))
    assert.equal(resolveResponse.status, 200)
    const resolveBody = await resolveResponse.json() as {
      preferredRouteId: number
      disabledRouteIds: number[]
      conflict: {
        resolutionState: string
        activeConflictRouteCount: number
        selectedOwnerRouteId: number | null
        routes: Array<{
          id: number
          runtimeSessionState: string
          ownerResolutionState: string
        }>
        history: Array<{
          action: string
          note: string | null
        }>
      } | null
    }
    assert.equal(resolveBody.preferredRouteId, detailBody.recommendedRouteId)
    assert.equal(resolveBody.disabledRouteIds.length, 1)
    assert.equal(resolveBody.conflict?.resolutionState, 'owner_selected')
    assert.equal(resolveBody.conflict?.activeConflictRouteCount, 0)
    assert.equal(resolveBody.conflict?.selectedOwnerRouteId, detailBody.recommendedRouteId)
    assert.ok(resolveBody.conflict?.routes.some((route) => route.id === detailBody.recommendedRouteId && route.runtimeSessionState === 'live'))
    assert.ok(resolveBody.conflict?.routes.some((route) => route.id !== detailBody.recommendedRouteId && route.ownerResolutionState === 'disabled'))
    assert.ok(resolveBody.conflict?.history.some((entry) => entry.action === 'admin.openclaw_conflict.resolved' && entry.note === 'Guided remediation smoke test'))
  } finally {
    db.close()
  }
})

test('openclaw fleet groups hosts by environment and supports guarded bulk actions', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const alpha = createFixtureAgent('alpha-fleet@openclaw.beam.directory')
    const bravo = createFixtureAgent('bravo-fleet@openclaw.beam.directory')
    const charlie = createFixtureAgent('charlie-fleet@openclaw.beam.directory')
    registerFixtureAgent(db, alpha, 'Alpha Fleet')
    registerFixtureAgent(db, bravo, 'Bravo Fleet')
    registerFixtureAgent(db, charlie, 'Charlie Fleet')

    const app = createApp(db)
    const hostAlpha = createApprovedHostWithRoute(db, {
      label: 'Fleet Alpha',
      hostname: 'alpha.local',
      beamId: alpha.beamId,
      routeKey: 'alpha-prod',
      workspaceSlug: 'openclaw-local',
    })
    const hostBravo = createApprovedHostWithRoute(db, {
      label: 'Fleet Bravo',
      hostname: 'bravo.local',
      beamId: bravo.beamId,
      routeKey: 'bravo-prod',
      workspaceSlug: 'openclaw-local',
    })
    const hostCharlie = createApprovedHostWithRoute(db, {
      label: 'Fleet Charlie',
      hostname: 'charlie.local',
      beamId: charlie.beamId,
      routeKey: 'charlie-stage',
      workspaceSlug: 'openclaw-local',
    })

    const bulkLabelResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/bulk-actions', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'apply_labels',
        hostIds: [hostAlpha.host.id, hostBravo.host.id],
        environmentLabel: 'prod',
        groupLabels: ['edge', 'team-alpha', 'edge'],
        owner: 'ops@example.com',
      }),
    }))
    assert.equal(bulkLabelResponse.status, 200)

    const profileResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${hostCharlie.host.id}/profile`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        environmentLabel: 'staging',
        groupLabels: ['lab'],
      }),
    }))
    assert.equal(profileResponse.status, 200)

    const invalidStageResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/bulk-actions', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'stage_revoke_review',
        hostIds: [hostAlpha.host.id, hostBravo.host.id],
        reason: 'retire prod pair',
        confirmPhrase: 'NOPE',
      }),
    }))
    assert.equal(invalidStageResponse.status, 400)

    const stageResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/bulk-actions', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'stage_revoke_review',
        hostIds: [hostAlpha.host.id, hostBravo.host.id],
        reason: 'retire prod pair',
        confirmPhrase: 'STAGE_REVOKE',
      }),
    }))
    assert.equal(stageResponse.status, 200)
    const stageBody = await stageResponse.json() as {
      action: string
      hostIds: number[]
      hosts: Array<{
        placement: {
          revokeReviewRequestedAt: string | null
          revokeReviewRequestedBy: string | null
          revokeReviewReason: string | null
        }
      }>
    }
    assert.equal(stageBody.action, 'stage_revoke_review')
    assert.equal(stageBody.hostIds.length, 2)
    assert.ok(stageBody.hosts.every((host) => host.placement.revokeReviewRequestedBy === 'admin@example.com'))
    assert.ok(stageBody.hosts.every((host) => host.placement.revokeReviewReason === 'retire prod pair'))

    const clearStageResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/bulk-actions', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'clear_revoke_review',
        hostIds: [hostBravo.host.id],
      }),
    }))
    assert.equal(clearStageResponse.status, 200)

    const overviewResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewResponse.status, 200)
    const overviewBody = await overviewResponse.json() as {
      environments: Array<{
        label: string
        hostCount: number
      }>
      hostGroups: Array<{
        label: string
        hostCount: number
      }>
      hosts: Array<{
        id: number
        placement: {
          environmentLabel: string | null
          groupLabels: string[]
          owner: string | null
          revokeReviewRequestedAt: string | null
          revokeReviewReason: string | null
        }
      }>
    }

    assert.ok(overviewBody.environments.some((environment) => environment.label === 'prod' && environment.hostCount === 2))
    assert.ok(overviewBody.environments.some((environment) => environment.label === 'staging' && environment.hostCount === 1))
    assert.ok(overviewBody.hostGroups.some((group) => group.label === 'edge' && group.hostCount === 2))
    assert.ok(overviewBody.hostGroups.some((group) => group.label === 'team-alpha' && group.hostCount === 2))
    assert.ok(overviewBody.hostGroups.some((group) => group.label === 'lab' && group.hostCount === 1))

    const overviewAlpha = overviewBody.hosts.find((host) => host.id === hostAlpha.host.id)
    const overviewBravo = overviewBody.hosts.find((host) => host.id === hostBravo.host.id)
    const overviewCharlie = overviewBody.hosts.find((host) => host.id === hostCharlie.host.id)
    assert.equal(overviewAlpha?.placement.environmentLabel, 'prod')
    assert.deepEqual(overviewAlpha?.placement.groupLabels, ['edge', 'team-alpha'])
    assert.equal(overviewAlpha?.placement.owner, 'ops@example.com')
    assert.equal(overviewAlpha?.placement.revokeReviewReason, 'retire prod pair')
    assert.equal(overviewBravo?.placement.revokeReviewRequestedAt, null)
    assert.equal(overviewCharlie?.placement.environmentLabel, 'staging')
    assert.deepEqual(overviewCharlie?.placement.groupLabels, ['lab'])
  } finally {
    db.close()
  }
})

test('openclaw fleet overview surfaces receipt coverage and latency summaries', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const sender = createFixtureAgent('sender@openclaw.beam.directory')
    const atlas = createFixtureAgent('atlas@openclaw.beam.directory')
    const beta = createFixtureAgent('beta@openclaw.beam.directory')
    registerFixtureAgent(db, sender, 'Sender')
    registerFixtureAgent(db, atlas, 'Atlas')
    registerFixtureAgent(db, beta, 'Beta')

    const host = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Metrics',
      hostname: 'metrics.local',
      beamId: atlas.beamId,
      routeKey: 'atlas-metrics',
      workspaceSlug: 'openclaw-local',
    })

    syncOpenClawHostRoutes(db, {
      hostId: host.host.id,
      routes: [
        {
          beamId: atlas.beamId,
          workspaceSlug: 'openclaw-local',
          routeSource: 'gateway-agent',
          routeKey: 'atlas-metrics',
          runtimeType: 'openclaw:gateway',
          label: 'Atlas',
          connectionMode: 'websocket',
          sessionKey: 'session-atlas',
          reportedState: 'live',
          lastSeenAt: new Date().toISOString(),
        },
        {
          beamId: beta.beamId,
          workspaceSlug: 'openclaw-local',
          routeSource: 'gateway-agent',
          routeKey: 'beta-metrics',
          runtimeType: 'openclaw:gateway',
          label: 'Beta',
          connectionMode: 'websocket',
          sessionKey: 'session-beta',
          reportedState: 'live',
          lastSeenAt: new Date().toISOString(),
        },
      ],
    })
    recordOpenClawHostHeartbeat(db, {
      hostId: host.host.id,
      routeCount: 2,
      connectorVersion: '1.4.0-test',
    })

    for (const latency of [1800, 4200, 7200]) {
      const frame = createSignedConversationIntent(sender, atlas.beamId, randomUUID())
      logIntentStart(db, frame)
      setIntentLifecycleStatus(db, {
        nonce: frame.nonce,
        status: 'validated',
      })
      setIntentLifecycleStatus(db, {
        nonce: frame.nonce,
        status: 'dispatched',
      })
      setIntentLifecycleStatus(db, {
        nonce: frame.nonce,
        status: 'delivered',
      })
      finalizeIntentLog(db, {
        nonce: frame.nonce,
        fromBeamId: frame.from,
        toBeamId: frame.to,
        status: 'acked',
        latencyMs: latency,
      })
    }

    const app = createApp(db)
    const hostResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(hostResponse.status, 200)
    const hostBody = await hostResponse.json() as {
      host: {
        summary: {
          delivery: {
            coverage: {
              activeRoutes: number
              routesWithReceipts: number
              missingReceipts: number
              ratio: number | null
            }
            latency: {
              samples: number
              avgMs: number | null
              p50Ms: number | null
              p95Ms: number | null
              overSlo: number
              degraded: boolean
            }
          }
        }
      }
    }
    assert.equal(hostBody.host.summary.delivery.coverage.activeRoutes, 2)
    assert.equal(hostBody.host.summary.delivery.coverage.routesWithReceipts, 1)
    assert.equal(hostBody.host.summary.delivery.coverage.missingReceipts, 1)
    assert.equal(hostBody.host.summary.delivery.coverage.ratio, 0.5)
    assert.equal(hostBody.host.summary.delivery.latency.samples, 3)
    assert.equal(hostBody.host.summary.delivery.latency.avgMs, 4400)
    assert.equal(hostBody.host.summary.delivery.latency.p50Ms, 4200)
    assert.equal(hostBody.host.summary.delivery.latency.p95Ms, 7200)
    assert.equal(hostBody.host.summary.delivery.latency.overSlo, 1)
    assert.equal(hostBody.host.summary.delivery.latency.degraded, true)

    const overviewResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewResponse.status, 200)
    const overviewBody = await overviewResponse.json() as {
      summary: {
        routesMissingReceipts: number
        receiptCoverageRatio: number | null
        degradedHosts: number
        latencySloBreaches: number
      }
      routeHealth: {
        summary: {
          targetLatencyMs: number
          activeRoutes: number
          routesWithReceipts: number
          routesMissingReceipts: number
          receiptCoverageRatio: number | null
          failedReceipts: number
          degradedHosts: number
          hostsWithMissingReceipts: number
          hostsWithFailedReceipts: number
        }
        latency: {
          samples: number
          avgMs: number | null
          p50Ms: number | null
          p95Ms: number | null
          overSlo: number
          overDoubleSlo: number
          buckets: {
            withinTarget: number
            overTarget: number
            overDoubleTarget: number
          }
        }
        attentionHosts: Array<{
          hostId: number
          traceHref: string | null
          workspaceHref: string | null
          reasons: string[]
        }>
      }
    }
    assert.equal(overviewBody.summary.routesMissingReceipts, 1)
    assert.equal(overviewBody.summary.receiptCoverageRatio, 0.5)
    assert.equal(overviewBody.summary.degradedHosts, 1)
    assert.equal(overviewBody.summary.latencySloBreaches, 1)
    assert.equal(overviewBody.routeHealth.summary.targetLatencyMs, 5000)
    assert.equal(overviewBody.routeHealth.summary.activeRoutes, 2)
    assert.equal(overviewBody.routeHealth.summary.routesWithReceipts, 1)
    assert.equal(overviewBody.routeHealth.summary.routesMissingReceipts, 1)
    assert.equal(overviewBody.routeHealth.summary.receiptCoverageRatio, 0.5)
    assert.equal(overviewBody.routeHealth.summary.failedReceipts, 0)
    assert.equal(overviewBody.routeHealth.summary.degradedHosts, 1)
    assert.equal(overviewBody.routeHealth.summary.hostsWithMissingReceipts, 1)
    assert.equal(overviewBody.routeHealth.summary.hostsWithFailedReceipts, 0)
    assert.equal(overviewBody.routeHealth.latency.samples, 3)
    assert.equal(overviewBody.routeHealth.latency.avgMs, 4400)
    assert.equal(overviewBody.routeHealth.latency.p50Ms, 4200)
    assert.equal(overviewBody.routeHealth.latency.p95Ms, 7200)
    assert.equal(overviewBody.routeHealth.latency.overSlo, 1)
    assert.equal(overviewBody.routeHealth.latency.overDoubleSlo, 0)
    assert.equal(overviewBody.routeHealth.latency.buckets.withinTarget, 2)
    assert.equal(overviewBody.routeHealth.latency.buckets.overTarget, 1)
    assert.equal(overviewBody.routeHealth.latency.buckets.overDoubleTarget, 0)
    assert.equal(overviewBody.routeHealth.attentionHosts[0]?.hostId, host.host.id)
    assert.equal(overviewBody.routeHealth.attentionHosts[0]?.workspaceHref, '/workspaces?workspace=openclaw-local')
    assert.ok(overviewBody.routeHealth.attentionHosts[0]?.traceHref?.startsWith('/intents/'))
    assert.ok(overviewBody.routeHealth.attentionHosts[0]?.reasons.includes('missing receipts'))
    assert.ok(overviewBody.routeHealth.attentionHosts[0]?.reasons.includes('latency above target'))
  } finally {
    db.close()
  }
})

test('stale openclaw host routes block Beam delivery before transport dispatch', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const sender = createFixtureAgent('sender@openclaw.beam.directory')
    const receiver = createFixtureAgent('stale@openclaw.beam.directory')
    registerFixtureAgent(db, sender, 'Sender')
    registerFixtureAgent(db, receiver, 'Stale Receiver')
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: 'conversation.message',
      allowedFrom: sender.beamId,
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'ops@example.com', 'admin'),
      'content-type': 'application/json',
    }

    const workspaceResponse = await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'OpenClaw Local',
        slug: 'openclaw-local',
        externalHandoffsEnabled: true,
      }),
    }))
    assert.equal(workspaceResponse.status, 201)

    const bindingResponse = await app.request(new Request('http://localhost/admin/workspaces/openclaw-local/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: receiver.beamId,
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'openclaw:gateway',
        policyProfile: 'openclaw-default',
        canInitiateExternal: true,
      }),
    }))
    assert.equal(bindingResponse.status, 201)

    const host = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Stale',
      hostname: 'stale.local',
      beamId: receiver.beamId,
      routeKey: 'stale-route',
      workspaceSlug: 'openclaw-local',
      heartbeatAt: '2026-03-01T00:00:00.000Z',
    })

    const nonce = randomUUID()
    await assert.rejects(
      relayIntentFromHttp(db, createSignedConversationIntent(sender, receiver.beamId, nonce), 250),
      (error: unknown) => error instanceof RelayError && error.code === 'OFFLINE' && error.message.includes('stale OpenClaw host'),
    )
    assert.equal(getIntentLogByNonce(db, nonce)?.error_code, 'HOST_STALE')

    const routesResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/routes`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(routesResponse.status, 200)
    const routesBody = await routesResponse.json() as {
      host: {
        summary: {
          unavailable: number
          delivery: {
            receipts: number
            failed: number
            lastErrorCode: string | null
            coverage: {
              activeRoutes: number
              routesWithReceipts: number
              missingReceipts: number
              ratio: number | null
            }
            latency: {
              samples: number
              degraded: boolean
            }
          }
        }
      }
      routes: Array<{
        beamId: string
        lastDelivery: {
          status: string
          errorCode: string | null
          href: string
        } | null
      }>
    }
    assert.equal(routesBody.host.summary.unavailable, 1)
    assert.equal(routesBody.host.summary.delivery.receipts, 1)
    assert.equal(routesBody.host.summary.delivery.failed, 1)
    assert.equal(routesBody.host.summary.delivery.lastErrorCode, 'HOST_STALE')
    assert.equal(routesBody.host.summary.delivery.coverage.activeRoutes, 0)
    assert.equal(routesBody.host.summary.delivery.coverage.routesWithReceipts, 1)
    assert.equal(routesBody.host.summary.delivery.coverage.missingReceipts, 0)
    assert.equal(routesBody.host.summary.delivery.coverage.ratio, null)
    assert.equal(routesBody.host.summary.delivery.latency.samples, 0)
    assert.equal(routesBody.host.summary.delivery.latency.degraded, true)
    assert.equal(routesBody.routes[0]?.beamId, receiver.beamId)
    assert.equal(routesBody.routes[0]?.lastDelivery?.status, 'failed')
    assert.equal(routesBody.routes[0]?.lastDelivery?.errorCode, 'HOST_STALE')
    assert.match(routesBody.routes[0]?.lastDelivery?.href ?? '', /\/intents\//)

    const workspaceIdentitiesResponse = await app.request(new Request('http://localhost/admin/workspaces/openclaw-local/identities', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(workspaceIdentitiesResponse.status, 200)
    const workspaceIdentitiesBody = await workspaceIdentitiesResponse.json() as {
      bindings: Array<{
        beamId: string
        lastDelivery: {
          status: string
          errorCode: string | null
          href: string
        } | null
      }>
    }
    assert.equal(workspaceIdentitiesBody.bindings[0]?.beamId, receiver.beamId)
    assert.equal(workspaceIdentitiesBody.bindings[0]?.lastDelivery?.status, 'failed')
    assert.equal(workspaceIdentitiesBody.bindings[0]?.lastDelivery?.errorCode, 'HOST_STALE')
    assert.match(workspaceIdentitiesBody.bindings[0]?.lastDelivery?.href ?? '', /\/intents\//)
  } finally {
    db.close()
  }
})

test('openclaw host maintenance and drain block delivery until resume', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const sender = createFixtureAgent('sender@openclaw.beam.directory')
    const receiver = createFixtureAgent('maint@openclaw.beam.directory')
    registerFixtureAgent(db, sender, 'Sender')
    registerFixtureAgent(db, receiver, 'Maintenance Receiver')
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: 'conversation.message',
      allowedFrom: sender.beamId,
    })

    const host = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Maintenance',
      hostname: 'maint.local',
      beamId: receiver.beamId,
      routeKey: 'maint-route',
      workspaceSlug: 'openclaw-local',
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    const maintenanceResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/maintenance`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        owner: 'ops@example.com',
        reason: 'kernel update',
        confirmPhrase: 'MAINTENANCE_HOST',
      }),
    }))
    assert.equal(maintenanceResponse.status, 200)
    const maintenanceBody = await maintenanceResponse.json() as {
      host: {
        maintenance: {
          state: string
          owner: string | null
          reason: string | null
          deliveryBlocked: boolean
        }
      }
    }
    assert.equal(maintenanceBody.host.maintenance.state, 'maintenance')
    assert.equal(maintenanceBody.host.maintenance.owner, 'ops@example.com')
    assert.equal(maintenanceBody.host.maintenance.reason, 'kernel update')
    assert.equal(maintenanceBody.host.maintenance.deliveryBlocked, true)

    const maintenanceNonce = randomUUID()
    await assert.rejects(
      relayIntentFromHttp(db, createSignedConversationIntent(sender, receiver.beamId, maintenanceNonce), 250),
      (error: unknown) => error instanceof RelayError && error.code === 'FORBIDDEN' && error.message.includes('maintenance mode'),
    )
    assert.equal(getIntentLogByNonce(db, maintenanceNonce)?.error_code, 'HOST_MAINTENANCE')

    const drainResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/drain`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        owner: 'ops@example.com',
        reason: 'drain connections',
        confirmPhrase: 'DRAIN_HOST',
      }),
    }))
    assert.equal(drainResponse.status, 200)
    const drainBody = await drainResponse.json() as {
      host: {
        maintenance: {
          state: string
          reason: string | null
        }
      }
    }
    assert.equal(drainBody.host.maintenance.state, 'draining')
    assert.equal(drainBody.host.maintenance.reason, 'drain connections')

    const drainNonce = randomUUID()
    await assert.rejects(
      relayIntentFromHttp(db, createSignedConversationIntent(sender, receiver.beamId, drainNonce), 250),
      (error: unknown) => error instanceof RelayError && error.code === 'FORBIDDEN' && error.message.includes('draining OpenClaw host'),
    )
    assert.equal(getIntentLogByNonce(db, drainNonce)?.error_code, 'HOST_DRAINING')

    const resumeResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/resume`, {
      method: 'POST',
      headers: createAdminHeaders(db, 'admin@example.com', 'admin'),
    }))
    assert.equal(resumeResponse.status, 200)
    const resumeBody = await resumeResponse.json() as {
      host: {
        maintenance: {
          state: string
          reason: string | null
          deliveryBlocked: boolean
        }
      }
    }
    assert.equal(resumeBody.host.maintenance.state, 'serving')
    assert.equal(resumeBody.host.maintenance.reason, null)
    assert.equal(resumeBody.host.maintenance.deliveryBlocked, false)

    const resumedNonce = randomUUID()
    await assert.rejects(
      relayIntentFromHttp(db, createSignedConversationIntent(sender, receiver.beamId, resumedNonce), 250),
      (error: unknown) => error instanceof RelayError && error.code !== 'FORBIDDEN',
    )
    const resumedLog = getIntentLogByNonce(db, resumedNonce)
    assert.notEqual(resumedLog?.error_code, 'HOST_MAINTENANCE')
    assert.notEqual(resumedLog?.error_code, 'HOST_DRAINING')
  } finally {
    db.close()
  }
})

test('revoked openclaw host routes block Beam delivery immediately', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const sender = createFixtureAgent('sender@openclaw.beam.directory')
    const receiver = createFixtureAgent('revoked@openclaw.beam.directory')
    registerFixtureAgent(db, sender, 'Sender')
    registerFixtureAgent(db, receiver, 'Revoked Receiver')
    createAcl(db, {
      targetBeamId: receiver.beamId,
      intentType: 'conversation.message',
      allowedFrom: sender.beamId,
    })

    const host = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Revoked',
      hostname: 'revoked.local',
      beamId: receiver.beamId,
      routeKey: 'revoked-route',
    })

    const app = createApp(db)
    const revokeResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/revoke`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'host retired', confirmPhrase: 'REVOKE_HOST' }),
    }))
    assert.equal(revokeResponse.status, 200)

    const nonce = randomUUID()
    await assert.rejects(
      relayIntentFromHttp(db, createSignedConversationIntent(sender, receiver.beamId, nonce), 250),
      (error: unknown) => error instanceof RelayError && error.code === 'FORBIDDEN' && error.message.includes('revoked OpenClaw host'),
    )
    assert.equal(getIntentLogByNonce(db, nonce)?.error_code, 'HOST_REVOKED')
  } finally {
    db.close()
  }
})

test('guided fleet remediations align rollout, drain missing receipts, and end stale routes', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const alpha = createFixtureAgent('alpha-remediation@openclaw.beam.directory')
    const bravo = createFixtureAgent('bravo-remediation@openclaw.beam.directory')
    registerFixtureAgent(db, alpha, 'Alpha Remediation')
    registerFixtureAgent(db, bravo, 'Bravo Remediation')

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    const workspaceResponse = await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'OpenClaw Local',
        slug: 'openclaw-local',
        externalHandoffsEnabled: true,
      }),
    }))
    assert.equal(workspaceResponse.status, 201)

    const alphaHost = createApprovedHostWithRoute(db, {
      label: 'Alpha Remediation Host',
      hostname: 'alpha-remediation.local',
      beamId: alpha.beamId,
      routeKey: 'alpha-remediation-route',
      workspaceSlug: 'openclaw-local',
    })
    const bravoHost = createApprovedHostWithRoute(db, {
      label: 'Bravo Remediation Host',
      hostname: 'bravo-remediation.local',
      beamId: bravo.beamId,
      routeKey: 'bravo-remediation-route',
      routeSource: 'subagent-run',
      workspaceSlug: 'openclaw-local',
      heartbeatAt: new Date(Date.now() - (45 * 60 * 1000)).toISOString(),
    })

    const rolloutResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${alphaHost.host.id}/rollout`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        ring: 'pinned',
        desiredConnectorVersion: '9.9.9-test',
        notes: 'intentional rollout drift',
      }),
    }))
    assert.equal(rolloutResponse.status, 200)

    const overviewBeforeResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewBeforeResponse.status, 200)
    const overviewBeforeBody = await overviewBeforeResponse.json() as {
      remediation: {
        suggested: Array<{
          kind: string
          hostId: number | null
          requiresConfirmation: boolean
        }>
      }
    }
    assert.ok(overviewBeforeBody.remediation.suggested.some((item) =>
      item.kind === 'align_rollout' && item.hostId === alphaHost.host.id && item.requiresConfirmation === false,
    ))
    assert.ok(overviewBeforeBody.remediation.suggested.some((item) =>
      item.kind === 'drain_missing_receipts' && item.hostId === alphaHost.host.id && item.requiresConfirmation,
    ))
    assert.ok(overviewBeforeBody.remediation.suggested.some((item) =>
      item.kind === 'end_stale_routes' && item.hostId === bravoHost.host.id && item.requiresConfirmation === false,
    ))

    const alignResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/remediations/apply', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'align_rollout',
        hostId: alphaHost.host.id,
        note: 'Adopt current connector target',
      }),
    }))
    assert.equal(alignResponse.status, 200)
    const alignBody = await alignResponse.json() as {
      ok: boolean
      host: {
        rollout: {
          desiredConnectorVersion: string | null
          versionState: string
        }
      }
    }
    assert.equal(alignBody.ok, true)
    assert.equal(alignBody.host.rollout.desiredConnectorVersion, '1.2.0-test')
    assert.equal(alignBody.host.rollout.versionState, 'current')

    const drainResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/remediations/apply', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'drain_missing_receipts',
        hostId: alphaHost.host.id,
        confirmPhrase: 'DRAIN_HOST',
        note: 'Drain host with missing receipts',
      }),
    }))
    assert.equal(drainResponse.status, 200)
    const drainBody = await drainResponse.json() as {
      ok: boolean
      host: {
        maintenance: {
          state: string
          owner: string | null
        }
      }
    }
    assert.equal(drainBody.ok, true)
    assert.equal(drainBody.host.maintenance.state, 'draining')
    assert.equal(drainBody.host.maintenance.owner, 'admin@example.com')

    const endStaleResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/remediations/apply', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'end_stale_routes',
        hostId: bravoHost.host.id,
        note: 'End stale routes after heartbeat timeout',
      }),
    }))
    assert.equal(endStaleResponse.status, 200)
    const endStaleBody = await endStaleResponse.json() as {
      ok: boolean
      routes: Array<{
        beamId: string
        runtimeSessionState: string
      }>
    }
    assert.equal(endStaleBody.ok, true)
    assert.equal(endStaleBody.routes[0]?.beamId, bravo.beamId)
    assert.equal(endStaleBody.routes[0]?.runtimeSessionState, 'ended')
    assert.equal(listOpenClawResolvedRoutesByBeamId(db, bravo.beamId)[0]?.runtime_session_state, 'ended')

    const overviewAfterResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewAfterResponse.status, 200)
    const overviewAfterBody = await overviewAfterResponse.json() as {
      remediation: {
        suggested: Array<{
          kind: string
          hostId: number | null
        }>
      }
    }
    assert.ok(!overviewAfterBody.remediation.suggested.some((item) =>
      item.kind === 'align_rollout' && item.hostId === alphaHost.host.id,
    ))
    assert.ok(!overviewAfterBody.remediation.suggested.some((item) =>
      item.kind === 'drain_missing_receipts' && item.hostId === alphaHost.host.id,
    ))
    assert.ok(!overviewAfterBody.remediation.suggested.some((item) =>
      item.kind === 'end_stale_routes' && item.hostId === bravoHost.host.id,
    ))
  } finally {
    db.close()
  }
})

test('fleet reconciliation summarizes stale route drift and garbage-collects eligible stale subagent routes', async () => {
  const db = createDatabase(':memory:')

  try {
    const agent = createFixtureAgent('reconcile@openclaw.beam.directory')
    registerFixtureAgent(db, agent, 'Reconcile Agent')

    const host = createApprovedHostWithRoute(db, {
      label: 'Reconciliation Host',
      hostname: 'reconciliation.local',
      beamId: agent.beamId,
      routeKey: 'reconciliation-route',
      routeSource: 'subagent-run',
      workspaceSlug: 'openclaw-local',
      heartbeatAt: new Date(Date.now() - (45 * 60 * 1000)).toISOString(),
    })

    const app = createApp(db)
    const viewerHeaders = createAdminHeaders(db, 'viewer@example.com', 'viewer')
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    const reconciliationBeforeResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/reconciliation', {
      headers: viewerHeaders,
    }))
    assert.equal(reconciliationBeforeResponse.status, 200)
    const reconciliationBeforeBody = await reconciliationBeforeResponse.json() as {
      summary: {
        driftedHosts: number
        staleRoutes: number
        garbageCollectableRoutes: number
      }
      attentionHosts: Array<{
        hostId: number
        state: string
      }>
      attentionRoutes: Array<{
        routeId: number
        classification: string
        garbageCollectable: boolean
      }>
    }
    assert.equal(reconciliationBeforeBody.summary.driftedHosts, 1)
    assert.equal(reconciliationBeforeBody.summary.staleRoutes, 1)
    assert.equal(reconciliationBeforeBody.summary.garbageCollectableRoutes, 1)
    assert.equal(reconciliationBeforeBody.attentionHosts[0]?.hostId, host.host.id)
    assert.equal(reconciliationBeforeBody.attentionHosts[0]?.state, 'cleanup_required')

    const routeBefore = listOpenClawResolvedRoutesByBeamId(db, agent.beamId)[0]
    assert.ok(routeBefore)
    assert.equal(reconciliationBeforeBody.attentionRoutes[0]?.routeId, routeBefore.id)
    assert.equal(reconciliationBeforeBody.attentionRoutes[0]?.classification, 'stale')
    assert.equal(reconciliationBeforeBody.attentionRoutes[0]?.garbageCollectable, true)

    const runResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/reconciliation/run', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        hostId: host.host.id,
        staleGraceMinutes: 0,
        orphanedGraceMinutes: 0,
        note: 'Force reconciliation cleanup during test',
      }),
    }))
    assert.equal(runResponse.status, 200)
    const runBody = await runResponse.json() as {
      ok: boolean
      hostId: number | null
      endedRouteIds: number[]
      deletedRouteIds: number[]
      deletedCount: number
      reconciliation: {
        summary: {
          staleRoutes: number
          garbageCollectableRoutes: number
        }
      }
    }
    assert.equal(runBody.ok, true)
    assert.equal(runBody.hostId, host.host.id)
    assert.deepEqual(runBody.endedRouteIds, [routeBefore.id])
    assert.deepEqual(runBody.deletedRouteIds, [routeBefore.id])
    assert.equal(runBody.deletedCount, 1)
    assert.equal(runBody.reconciliation.summary.staleRoutes, 0)
    assert.equal(runBody.reconciliation.summary.garbageCollectableRoutes, 0)

    const routeAfter = listOpenClawResolvedRoutesByBeamId(db, agent.beamId)[0]
    assert.equal(routeAfter, undefined)
  } finally {
    db.close()
  }
})

test('fleet digest summarizes stale hosts, duplicate conflicts, and failed deliveries', async () => {
  const db = createDatabase(':memory:')

  try {
    const sender = createFixtureAgent('sender@openclaw.beam.directory')
    const alpha = createFixtureAgent('atlas@openclaw.beam.directory')
    const gamma = createFixtureAgent('gamma@openclaw.beam.directory')
    const delta = createFixtureAgent('delta@openclaw.beam.directory')
    registerFixtureAgent(db, sender, 'Sender')
    registerFixtureAgent(db, alpha, 'Atlas')
    registerFixtureAgent(db, gamma, 'Gamma')
    registerFixtureAgent(db, delta, 'Delta')

    createAcl(db, {
      targetBeamId: alpha.beamId,
      intentType: 'conversation.message',
      allowedFrom: '*@openclaw.beam.directory',
    })
    createAcl(db, {
      targetBeamId: gamma.beamId,
      intentType: 'conversation.message',
      allowedFrom: '*@openclaw.beam.directory',
    })
    createAcl(db, {
      targetBeamId: delta.beamId,
      intentType: 'conversation.message',
      allowedFrom: '*@openclaw.beam.directory',
    })

    const hostAlpha = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Alpha',
      hostname: 'alpha.local',
      beamId: alpha.beamId,
      routeKey: 'alpha-primary',
      workspaceSlug: 'openclaw-local',
    })
    createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Beta',
      hostname: 'beta.local',
      beamId: alpha.beamId,
      routeKey: 'alpha-duplicate',
      routeSource: 'subagent-run',
      workspaceSlug: 'openclaw-local',
    })
    const hostGamma = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Gamma',
      hostname: 'gamma.local',
      beamId: gamma.beamId,
      routeKey: 'gamma-primary',
      workspaceSlug: 'openclaw-local',
    })
    createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Delta',
      hostname: 'delta.local',
      beamId: delta.beamId,
      routeKey: 'delta-stale',
      workspaceSlug: 'openclaw-local',
      heartbeatAt: new Date(Date.now() - (10 * 60 * 1000)).toISOString(),
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'ops@example.com', 'admin'),
      'content-type': 'application/json',
    }

    const revokeResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${hostGamma.host.id}/revoke`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ reason: 'digest drill revoke', confirmPhrase: 'REVOKE_HOST' }),
    }))
    assert.equal(revokeResponse.status, 200)

    await assert.rejects(
      () => relayIntentFromHttp(db, createSignedConversationIntent(sender, gamma.beamId)),
      (error: unknown) => {
        assert.ok(error instanceof RelayError)
        assert.equal(error.code, 'FORBIDDEN')
        return true
      },
    )

    const digestResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/digest', {
      headers: createAdminHeaders(db, 'ops@example.com', 'operator'),
    }))
    assert.equal(digestResponse.status, 200)
    const digestBody = await digestResponse.json() as {
      summary: {
        staleHosts: number
        duplicateIdentityConflicts: number
        failedReceipts: number
        actionItems: number
        criticalItems: number
      }
      actionItems: Array<{
        category: string
        title: string
        nextAction: string
        traceHref: string | null
      }>
      markdown: string
    }

    assert.ok(digestBody.summary.staleHosts >= 1)
    assert.equal(digestBody.summary.duplicateIdentityConflicts, 1)
    assert.ok(digestBody.summary.failedReceipts >= 1)
    assert.ok(digestBody.summary.actionItems >= 3)
    assert.ok(digestBody.summary.criticalItems >= 2)
    assert.ok(digestBody.actionItems.some((item) => item.category === 'conflict'))
    assert.ok(digestBody.actionItems.some((item) => item.category === 'host'))
    assert.ok(digestBody.actionItems.some((item) => item.category === 'delivery' && item.traceHref))
    assert.match(digestBody.markdown, /Beam OpenClaw fleet digest/i)

    const deliverForbidden = await app.request(new Request('http://localhost/admin/openclaw/fleet/digest/deliver', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'viewer@example.com', 'viewer'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'ops+override@example.com' }),
    }))
    assert.equal(deliverForbidden.status, 403)

    const deliverUnavailable = await app.request(new Request('http://localhost/admin/openclaw/fleet/digest/deliver', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }))
    assert.equal(deliverUnavailable.status, 503)
  } finally {
    db.close()
  }
})

test('fleet overview surfaces maintenance counts and rollout inventory', async () => {
  const db = createDatabase(':memory:')

  try {
    const alpha = createFixtureAgent('atlas@openclaw.beam.directory')
    const beta = createFixtureAgent('bravo@openclaw.beam.directory')
    const gamma = createFixtureAgent('charlie@openclaw.beam.directory')
    registerFixtureAgent(db, alpha, 'Atlas')
    registerFixtureAgent(db, beta, 'Bravo')
    registerFixtureAgent(db, gamma, 'Charlie')

    const hostAlpha = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Alpha',
      hostname: 'alpha.local',
      beamId: alpha.beamId,
      routeKey: 'alpha-route',
      workspaceSlug: 'openclaw-local',
    })
    const hostBravo = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Bravo',
      hostname: 'bravo.local',
      beamId: beta.beamId,
      routeKey: 'bravo-route',
      workspaceSlug: 'openclaw-local',
    })
    const hostCharlie = createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Charlie',
      hostname: 'charlie.local',
      beamId: gamma.beamId,
      routeKey: 'charlie-route',
      workspaceSlug: 'openclaw-local',
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    const maintenanceResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${hostBravo.host.id}/maintenance`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        owner: 'ops@example.com',
        reason: 'planned maintenance',
        confirmPhrase: 'MAINTENANCE_HOST',
      }),
    }))
    assert.equal(maintenanceResponse.status, 200)

    const canaryResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${hostAlpha.host.id}/rollout`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        ring: 'canary',
        desiredConnectorVersion: '1.2.0-test',
        notes: 'canary cohort',
      }),
    }))
    assert.equal(canaryResponse.status, 200)

    const driftResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${hostCharlie.host.id}/rollout`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({
        ring: 'pinned',
        desiredConnectorVersion: '9.9.9-test',
        notes: 'hold back rollout',
      }),
    }))
    assert.equal(driftResponse.status, 200)
    const driftBody = await driftResponse.json() as {
      host: {
        rollout: {
          ring: string
          desiredConnectorVersion: string | null
          versionState: string
        }
      }
    }
    assert.equal(driftBody.host.rollout.ring, 'pinned')
    assert.equal(driftBody.host.rollout.desiredConnectorVersion, '9.9.9-test')
    assert.equal(driftBody.host.rollout.versionState, 'drifted')

    const overviewResponse = await app.request(new Request('http://localhost/admin/openclaw/fleet/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewResponse.status, 200)
    const overviewBody = await overviewResponse.json() as {
      maintenance: {
        counts: {
          maintenance: number
          draining: number
          blocked: number
        }
        attentionHosts: Array<{
          hostId: number
          state: string
          reasons: string[]
        }>
      }
      rollout: {
        summary: {
          versions: number
          canaryHosts: number
          driftHosts: number
          unmanagedHosts: number
        }
        versions: Array<{
          version: string
          hostCount: number
          canaryHosts: number
          driftHosts: number
        }>
        rings: Array<{
          ring: string
          hostCount: number
          canaryHosts: number
          driftHosts: number
        }>
        attentionHosts: Array<{
          hostId: number
          ring: string
          versionState: string
          reasons: string[]
        }>
      }
    }

    assert.equal(overviewBody.maintenance.counts.maintenance, 1)
    assert.equal(overviewBody.maintenance.counts.draining, 0)
    assert.equal(overviewBody.maintenance.counts.blocked, 1)
    assert.equal(overviewBody.maintenance.attentionHosts[0]?.hostId, hostBravo.host.id)
    assert.equal(overviewBody.maintenance.attentionHosts[0]?.state, 'maintenance')
    assert.ok(overviewBody.maintenance.attentionHosts[0]?.reasons.includes('planned maintenance'))

    assert.equal(overviewBody.rollout.summary.versions, 1)
    assert.equal(overviewBody.rollout.summary.canaryHosts, 1)
    assert.equal(overviewBody.rollout.summary.driftHosts, 1)
    assert.equal(overviewBody.rollout.summary.unmanagedHosts, 1)
    assert.equal(overviewBody.rollout.versions[0]?.version, '1.2.0-test')
    assert.equal(overviewBody.rollout.versions[0]?.hostCount, 3)
    assert.equal(overviewBody.rollout.versions[0]?.canaryHosts, 1)
    assert.equal(overviewBody.rollout.versions[0]?.driftHosts, 1)
    assert.equal(overviewBody.rollout.rings.find((entry) => entry.ring === 'canary')?.hostCount, 1)
    assert.equal(overviewBody.rollout.rings.find((entry) => entry.ring === 'pinned')?.hostCount, 1)
    assert.equal(overviewBody.rollout.attentionHosts.find((entry) => entry.hostId === hostAlpha.host.id)?.ring, 'canary')
    assert.equal(overviewBody.rollout.attentionHosts.find((entry) => entry.hostId === hostCharlie.host.id)?.versionState, 'drifted')
    assert.ok(overviewBody.rollout.attentionHosts.find((entry) => entry.hostId === hostCharlie.host.id)?.reasons.some((reason) => reason.includes('expected 9.9.9-test')))
  } finally {
    db.close()
  }
})
