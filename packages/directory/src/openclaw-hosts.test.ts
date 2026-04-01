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
  getIntentLogByNonce,
  listOpenClawResolvedRoutesByBeamId,
  recordOpenClawHostHeartbeat,
  registerAgent,
  syncOpenClawHostRoutes,
  assignDirectoryRole,
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
      }
    }
    assert.equal(enrollmentBody.enrollment.status, 'issued')

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
        duplicateIdentityConflicts: number
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
      duplicateIdentityConflicts: 0,
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

    createApprovedHostWithRoute(db, {
      label: 'OpenClaw Host Stale',
      hostname: 'stale.local',
      beamId: receiver.beamId,
      routeKey: 'stale-route',
      heartbeatAt: '2026-03-01T00:00:00.000Z',
    })

    const nonce = randomUUID()
    await assert.rejects(
      relayIntentFromHttp(db, createSignedConversationIntent(sender, receiver.beamId, nonce), 250),
      (error: unknown) => error instanceof RelayError && error.code === 'OFFLINE' && error.message.includes('stale OpenClaw host'),
    )
    assert.equal(getIntentLogByNonce(db, nonce)?.error_code, 'HOST_STALE')
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
