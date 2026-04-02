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
      body: JSON.stringify({ reason: 'duplicate identity conflict' }),
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
      headers: createAdminHeaders(db, 'admin@example.com', 'admin'),
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
      body: JSON.stringify({ reason: 'recovery drill' }),
    }))
    assert.equal(revokeResponse.status, 200)

    const recoverResponse = await app.request(new Request(`http://localhost/admin/openclaw/hosts/${host.host.id}/recover`, {
      method: 'POST',
      headers: createAdminHeaders(db, 'admin@example.com', 'admin'),
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
          }
          recovery: {
            owner: string | null
            status: string
            notes: string | null
            replacementHostLabel: string | null
            windowStartsAt: string | null
            windowEndsAt: string | null
          }
        }
      }
    }
    assert.equal(policyBody.host.policy.rotation.intervalHours, 1)
    assert.equal(policyBody.host.policy.rotation.windowStartHour, 3)
    assert.equal(policyBody.host.policy.rotation.windowDurationHours, 2)
    assert.equal(policyBody.host.policy.rotation.reviewState, 'overdue')
    assert.ok(policyBody.host.policy.rotation.nextRotationDueAt)
    assert.equal(policyBody.host.policy.recovery.owner, 'ops@example.com')
    assert.equal(policyBody.host.policy.recovery.status, 'prepared')
    assert.equal(policyBody.host.policy.recovery.notes, 'Replace chassis during the next window')
    assert.equal(policyBody.host.policy.recovery.replacementHostLabel, 'policy-replacement')
    assert.equal(policyBody.host.policy.recovery.windowStartsAt, '2026-04-02T08:00:00.000Z')
    assert.equal(policyBody.host.policy.recovery.windowEndsAt, '2026-04-02T10:00:00.000Z')

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
    }
    assert.equal(overviewBody.summary.routesMissingReceipts, 1)
    assert.equal(overviewBody.summary.receiptCoverageRatio, 0.5)
    assert.equal(overviewBody.summary.degradedHosts, 1)
    assert.equal(overviewBody.summary.latencySloBreaches, 1)
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
      body: JSON.stringify({ reason: 'host retired' }),
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
      body: JSON.stringify({ reason: 'digest drill revoke' }),
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
