import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminSession } from './admin-auth.js'
import { createApp } from './server.js'
import {
  assignDirectoryRole,
  createDatabase,
  finalizeIntentLog,
  logIntentStart,
  registerAgent,
  setIntentLifecycleStatus,
} from './db.js'
import { getLocalDirectoryUrl } from './federation.js'

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

test('admins can create and inspect beam workspaces through the admin API', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)

    const createResponse = await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Acme Ops Workspace',
        slug: 'acme-ops',
        description: 'Control plane for internal and partner-facing identities.',
        externalHandoffsEnabled: true,
      }),
    }))

    assert.equal(createResponse.status, 201)
    const createdBody = await createResponse.json() as {
      workspace: {
        slug: string
        name: string
        description: string | null
        externalHandoffsEnabled: boolean
        policyConfigured: boolean
        summary: {
          identities: number
          partnerChannels: number
        }
      }
    }
    assert.equal(createdBody.workspace.slug, 'acme-ops')
    assert.equal(createdBody.workspace.name, 'Acme Ops Workspace')
    assert.match(createdBody.workspace.description ?? '', /Control plane/i)
    assert.equal(createdBody.workspace.externalHandoffsEnabled, true)
    assert.equal(createdBody.workspace.policyConfigured, true)
    assert.equal(createdBody.workspace.summary.identities, 0)
    assert.equal(createdBody.workspace.summary.partnerChannels, 0)

    const listResponse = await app.request(new Request('http://localhost/admin/workspaces', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(listResponse.status, 200)
    const listBody = await listResponse.json() as {
      total: number
      workspaces: Array<{ slug: string }>
    }
    assert.equal(listBody.total, 1)
    assert.equal(listBody.workspaces[0]?.slug, 'acme-ops')

    const detailResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-ops', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(detailResponse.status, 200)
    const detailBody = await detailResponse.json() as {
      workspace: {
        slug: string
        defaultThreadScope: string
      }
    }
    assert.equal(detailBody.workspace.slug, 'acme-ops')
    assert.equal(detailBody.workspace.defaultThreadScope, 'internal')
  } finally {
    db.close()
  }
})

test('workspace identity bindings can be created, listed, and updated through the admin API', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    registerAgent(db, {
      beamId: 'ops-bot@beam.directory',
      displayName: 'Ops Bot',
      capabilities: ['triage', 'handoff'],
      publicKey: 'MCowBQYDK2VwAyEAEHzHjWwTn/RZiC407+hCtk8nde/GEVUn85iOaZBH2Bw=',
      personal: true,
    })

    const app = createApp(db)

    const workspaceResponse = await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Northwind Partner Ops',
        slug: 'northwind-partner-ops',
      }),
    }))
    assert.equal(workspaceResponse.status, 201)

    const bindLocalResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-partner-ops/identities', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        beamId: 'ops-bot@beam.directory',
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'codex',
        policyProfile: 'default',
        canInitiateExternal: true,
        notes: 'Primary internal operator agent.',
      }),
    }))
    assert.equal(bindLocalResponse.status, 201)
    const localBindingBody = await bindLocalResponse.json() as {
      binding: {
        id: number
        owner: string | null
        canInitiateExternal: boolean
        identity: {
          existsLocally: boolean
          displayName: string | null
          keyState: {
            active: { beamId: string } | null
          } | null
        }
      }
    }
    assert.equal(localBindingBody.binding.owner, 'ops@example.com')
    assert.equal(localBindingBody.binding.canInitiateExternal, true)
    assert.equal(localBindingBody.binding.identity.existsLocally, true)
    assert.equal(localBindingBody.binding.identity.displayName, 'Ops Bot')
    assert.equal(localBindingBody.binding.identity.keyState?.active?.beamId, 'ops-bot@beam.directory')

    const bindPartnerResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-partner-ops/identities', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        beamId: 'finance-agent@northwind.beam.directory',
        bindingType: 'partner',
        owner: 'bizops@example.com',
        policyProfile: 'partner-finance',
      }),
    }))
    assert.equal(bindPartnerResponse.status, 201)

    const listResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-partner-ops/identities', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(listResponse.status, 200)
    const listBody = await listResponse.json() as {
      total: number
      bindings: Array<{
        id: number
        beamId: string
        status: string
        identity: {
          existsLocally: boolean
        }
      }>
    }
    assert.equal(listBody.total, 2)
    const partnerBinding = listBody.bindings.find((entry) => entry.beamId === 'finance-agent@northwind.beam.directory')
    assert.equal(partnerBinding?.identity.existsLocally, false)

    const patchResponse = await app.request(new Request(`http://localhost/admin/workspaces/northwind-partner-ops/identities/${localBindingBody.binding.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'paused',
        canInitiateExternal: false,
        notes: 'Paused pending policy review.',
      }),
    }))
    assert.equal(patchResponse.status, 200)
    const patchBody = await patchResponse.json() as {
      binding: {
        status: string
        canInitiateExternal: boolean
        notes: string | null
      }
    }
    assert.equal(patchBody.binding.status, 'paused')
    assert.equal(patchBody.binding.canInitiateExternal, false)
    assert.match(patchBody.binding.notes ?? '', /policy review/i)
  } finally {
    db.close()
  }
})

test('workspace overview surfaces stale identities, blocked external motion, and recent external handoffs', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    registerAgent(db, {
      beamId: 'ops-bot@beam.directory',
      displayName: 'Ops Bot',
      capabilities: ['triage', 'handoff'],
      publicKey: 'MCowBQYDK2VwAyEAzJmQH9I0mL6MZzQ1+Qv6cMo5+2dH6+f8A6m2nYJ7rVY=',
      personal: true,
    })
    registerAgent(db, {
      beamId: 'triage-bot@beam.directory',
      displayName: 'Triage Bot',
      capabilities: ['triage'],
      publicKey: 'MCowBQYDK2VwAyEATlqf7UPv1sX7aHqL13FQ+V6u6XgX+9x+4quAhzV8J8c=',
      personal: true,
    })

    db.prepare('UPDATE agents SET last_seen = ? WHERE beam_id = ?').run(
      '2026-03-29T08:00:00.000Z',
      'triage-bot@beam.directory',
    )

    const app = createApp(db)

    const workspaceResponse = await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Acme Ops Workspace',
        slug: 'acme-ops',
        description: 'Workspace for the first Beam production motion.',
        externalHandoffsEnabled: true,
      }),
    }))
    assert.equal(workspaceResponse.status, 201)

    const createBinding = async (payload: Record<string, unknown>) => app.request(new Request('http://localhost/admin/workspaces/acme-ops/identities', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }))

    assert.equal((await createBinding({
      beamId: 'ops-bot@beam.directory',
      bindingType: 'agent',
      owner: 'ops@example.com',
      runtimeType: 'codex',
      policyProfile: 'default',
      canInitiateExternal: false,
      notes: 'Primary operator identity.',
    })).status, 201)

    assert.equal((await createBinding({
      beamId: 'triage-bot@beam.directory',
      bindingType: 'service',
      owner: 'ops@example.com',
      runtimeType: 'worker',
      policyProfile: 'triage',
      canInitiateExternal: true,
      status: 'paused',
      notes: 'Paused after a stale health signal.',
    })).status, 201)

    assert.equal((await createBinding({
      beamId: 'finance-agent@northwind.beam.directory',
      bindingType: 'partner',
      owner: 'northwind@example.com',
      policyProfile: 'partner-finance',
    })).status, 201)

    logIntentStart(db, {
      v: '1',
      nonce: 'nonce-workspace-outbound',
      from: 'ops-bot@beam.directory',
      to: 'finance-agent@northwind.beam.directory',
      intent: 'invoice.review',
      payload: { invoiceId: 'INV-44' },
      timestamp: '2026-03-31T09:00:00.000Z',
      signature: 'sig-outbound',
    })
    setIntentLifecycleStatus(db, { nonce: 'nonce-workspace-outbound', status: 'validated' })
    setIntentLifecycleStatus(db, { nonce: 'nonce-workspace-outbound', status: 'dispatched' })
    setIntentLifecycleStatus(db, { nonce: 'nonce-workspace-outbound', status: 'delivered' })
    finalizeIntentLog(db, {
      nonce: 'nonce-workspace-outbound',
      fromBeamId: 'ops-bot@beam.directory',
      toBeamId: 'finance-agent@northwind.beam.directory',
      status: 'acked',
      latencyMs: 420,
      resultJson: JSON.stringify({ ok: true }),
    })

    logIntentStart(db, {
      v: '1',
      nonce: 'nonce-workspace-inbound',
      from: 'seller-bot@outside.beam.directory',
      to: 'ops-bot@beam.directory',
      intent: 'partner.update',
      payload: { orderId: 'ORD-91' },
      timestamp: '2026-03-31T08:00:00.000Z',
      signature: 'sig-inbound',
    })
    finalizeIntentLog(db, {
      nonce: 'nonce-workspace-inbound',
      fromBeamId: 'seller-bot@outside.beam.directory',
      toBeamId: 'ops-bot@beam.directory',
      status: 'failed',
      latencyMs: 980,
      errorCode: 'RECIPIENT_OFFLINE',
    })

    const overviewResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-ops/overview', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(overviewResponse.status, 200)

    const overviewBody = await overviewResponse.json() as {
      workspace: { slug: string }
      staleAfterHours: number
      summary: {
        totalIdentities: number
        activeIdentities: number
        localIdentities: number
        partnerIdentities: number
        externalReadyIdentities: number
        staleIdentities: number
        pendingApprovals: number
        blockedExternalMotion: number
        recentExternalHandoffs: number
      }
      staleBindings: Array<{
        reasonCode: string
        binding: {
          beamId: string
        }
      }>
      blockedExternalMotion: Array<{
        reasonCode: string
        binding: {
          beamId: string
        }
      }>
      recentExternalHandoffs: Array<{
        nonce: string
        direction: string
        workspaceSide: { beamId: string }
        counterparty: { beamId: string; inWorkspace: boolean }
      }>
    }

    assert.equal(overviewBody.workspace.slug, 'acme-ops')
    assert.equal(overviewBody.staleAfterHours, 24)
    assert.deepEqual(overviewBody.summary, {
      totalIdentities: 3,
      activeIdentities: 2,
      localIdentities: 2,
      partnerIdentities: 1,
      externalReadyIdentities: 0,
      staleIdentities: 1,
      pendingApprovals: 1,
      blockedExternalMotion: 2,
      recentExternalHandoffs: 2,
    })
    assert.equal(overviewBody.staleBindings[0]?.binding.beamId, 'triage-bot@beam.directory')
    assert.equal(overviewBody.staleBindings[0]?.reasonCode, 'stale_check_in')
    assert.deepEqual(
      overviewBody.blockedExternalMotion.map((entry) => entry.reasonCode).sort(),
      ['binding_paused', 'manual_review_required'],
    )
    assert.deepEqual(
      overviewBody.blockedExternalMotion.map((entry) => entry.binding.beamId).sort(),
      ['ops-bot@beam.directory', 'triage-bot@beam.directory'],
    )
    assert.equal(overviewBody.recentExternalHandoffs[0]?.nonce, 'nonce-workspace-outbound')
    assert.equal(overviewBody.recentExternalHandoffs[0]?.direction, 'outbound')
    assert.equal(overviewBody.recentExternalHandoffs[0]?.workspaceSide.beamId, 'ops-bot@beam.directory')
    assert.equal(overviewBody.recentExternalHandoffs[0]?.counterparty.beamId, 'finance-agent@northwind.beam.directory')
    assert.equal(overviewBody.recentExternalHandoffs[0]?.counterparty.inWorkspace, true)
    assert.equal(overviewBody.recentExternalHandoffs[1]?.nonce, 'nonce-workspace-inbound')
    assert.equal(overviewBody.recentExternalHandoffs[1]?.direction, 'inbound')
    assert.equal(overviewBody.recentExternalHandoffs[1]?.counterparty.beamId, 'seller-bot@outside.beam.directory')
    assert.equal(overviewBody.recentExternalHandoffs[1]?.counterparty.inWorkspace, false)
  } finally {
    db.close()
  }
})
