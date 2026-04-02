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
    assert.equal(createdBody.workspace.policyConfigured, false)
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
        lifecycleStatus: string
        ownershipState: string
        runtime: {
          mode: string
          connector: string | null
          connected: boolean
          deliveryMode: string | null
        }
        lastSeenAgeHours: number | null
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
    assert.equal(localBindingBody.binding.lifecycleStatus, 'healthy')
    assert.equal(localBindingBody.binding.ownershipState, 'owned')
    assert.equal(localBindingBody.binding.runtime.mode, 'runtime-backed')
    assert.equal(localBindingBody.binding.runtime.connector, 'codex')
    assert.equal(localBindingBody.binding.runtime.connected, false)
    assert.equal(localBindingBody.binding.runtime.deliveryMode, 'unavailable')
    assert.equal(typeof localBindingBody.binding.lastSeenAgeHours, 'number')
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
          did: {
            id: string
          }
        }
        workspacePolicy: {
          effective: {
            externalInitiation: string
          }
        }
      }>
    }
    assert.equal(listBody.total, 2)
    const partnerBinding = listBody.bindings.find((entry) => entry.beamId === 'finance-agent@northwind.beam.directory')
    assert.equal(partnerBinding?.identity.existsLocally, false)
    const localBinding = listBody.bindings.find((entry) => entry.beamId === 'ops-bot@beam.directory')
    assert.equal(localBinding?.identity.did.id, 'did:beam:ops-bot')
    assert.equal(localBinding?.workspacePolicy.effective.externalInitiation, 'allow')

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

test('workspace identities expose explicit did control, per-binding partner overrides, and local credential reissue', async () => {
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

    const app = createApp(db)

    const workspaceResponse = await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Acme Agent Control',
        slug: 'acme-agent-control',
      }),
    }))
    assert.equal(workspaceResponse.status, 201)

    const bindResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-agent-control/identities', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        beamId: 'ops-bot@beam.directory',
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'openclaw:workspace',
        canInitiateExternal: false,
      }),
    }))
    assert.equal(bindResponse.status, 201)
    const bindBody = await bindResponse.json() as {
      binding: {
        id: number
      }
    }

    const policyResponse = await app.request(new Request(`http://localhost/admin/workspaces/acme-agent-control/identities/${bindBody.binding.id}/policy`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        externalInitiation: 'allow',
        allowedPartners: ['finance@northwind.beam.directory'],
      }),
    }))
    assert.equal(policyResponse.status, 200)
    const policyBody = await policyResponse.json() as {
      rule: {
        externalInitiation: string
        allowedPartners: string[]
      } | null
      preview: {
        externalInitiation: string
        allowedPartners: string[]
      }
      binding: {
        workspacePolicy: {
          bindingRule: {
            externalInitiation: string
            allowedPartners: string[]
          } | null
        }
      }
    }
    assert.equal(policyBody.rule?.externalInitiation, 'allow')
    assert.deepEqual(policyBody.rule?.allowedPartners, ['finance@northwind.beam.directory'])
    assert.equal(policyBody.preview.externalInitiation, 'allow')
    assert.deepEqual(policyBody.preview.allowedPartners, ['finance@northwind.beam.directory'])
    assert.equal(policyBody.binding.workspacePolicy.bindingRule?.externalInitiation, 'allow')

    const reissueResponse = await app.request(new Request(`http://localhost/admin/workspaces/acme-agent-control/identities/${bindBody.binding.id}/reissue-local-credential`, {
      method: 'POST',
      headers: createAdminHeaders(db, 'admin@example.com', 'admin'),
    }))
    assert.equal(reissueResponse.status, 200)
    const reissueBody = await reissueResponse.json() as {
      binding: {
        beamId: string
        identity: {
          did: {
            id: string
            resolutionUrl: string
            keysUrl: string
          }
          keyState: {
            total: number
            active: { publicKey: string } | null
            revoked: Array<{ publicKey: string }>
          } | null
        }
      }
      credential: {
        format: string
        beamId: string
        did: string
        apiKey: string
        publicKey: string
        privateKey: string
        urls: {
          didResolution: string
          keys: string
        }
      }
    }
    assert.equal(reissueBody.binding.beamId, 'ops-bot@beam.directory')
    assert.equal(reissueBody.binding.identity.did.id, 'did:beam:ops-bot')
    assert.match(reissueBody.binding.identity.did.resolutionUrl, /\/did\//)
    assert.match(reissueBody.credential.apiKey, /^bk_/)
    assert.equal(reissueBody.credential.format, 'beam-local-identity/v1')
    assert.equal(reissueBody.credential.beamId, 'ops-bot@beam.directory')
    assert.equal(reissueBody.credential.did, 'did:beam:ops-bot')
    assert.match(reissueBody.credential.privateKey, /^[A-Za-z0-9+/=]+$/)
    assert.match(reissueBody.credential.publicKey, /^[A-Za-z0-9+/=]+$/)
    assert.match(reissueBody.credential.urls.didResolution, /\/did\//)
    assert.match(reissueBody.credential.urls.keys, /\/keys$/)
    assert.equal(reissueBody.binding.identity.keyState?.total, 2)
    assert.equal(reissueBody.binding.identity.keyState?.revoked.length, 1)
    assert.equal(reissueBody.binding.identity.keyState?.active?.publicKey, reissueBody.credential.publicKey)
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

test('workspace approval queue surfaces manual review bindings and blocked handoff threads with automation hints', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    registerAgent(db, {
      beamId: 'ops-bot@beam.directory',
      displayName: 'Ops Bot',
      capabilities: ['handoff'],
      publicKey: 'MCowBQYDK2VwAyEAw2QJY0YH7e1L2+2VQ1bH4TqL6wCnC8n9v8m8z4vPsxM=',
      personal: true,
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Acme Approval Workspace',
        slug: 'acme-approval',
        externalHandoffsEnabled: true,
      }),
    }))

    const bindingResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-approval/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: 'ops-bot@beam.directory',
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'codex:operator',
        policyProfile: 'ops-default',
        canInitiateExternal: false,
      }),
    }))
    const bindingBody = await bindingResponse.json() as { binding: { id: number } }

    await app.request(new Request('http://localhost/admin/workspaces/acme-approval/policy', {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowRules: [{
          workflowType: 'partner.review',
          requireApproval: true,
          allowedPartners: ['echo@beam.directory'],
          approvers: ['ops@example.com'],
        }],
      }),
    }))

    await app.request(new Request('http://localhost/admin/workspaces/acme-approval/partner-channels', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        partnerBeamId: 'echo@beam.directory',
        label: 'Beam Echo',
        owner: 'ops@example.com',
        status: 'active',
      }),
    }))

    await app.request(new Request('http://localhost/admin/workspaces/acme-approval/threads', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'handoff',
        title: 'Approval queue thread',
        summary: 'Blocked until the sender gets outbound approval.',
        owner: 'ops@example.com',
        workflowType: 'partner.review',
        status: 'blocked',
        draftIntentType: 'conversation.message',
        draftPayload: {
          message: 'Please confirm the approval queue path.',
          language: 'en',
        },
        participants: [
          {
            principalId: 'ops-bot@beam.directory',
            principalType: 'agent',
            beamId: 'ops-bot@beam.directory',
            workspaceBindingId: bindingBody.binding.id,
            role: 'owner',
          },
          {
            principalId: 'echo@beam.directory',
            principalType: 'partner',
            beamId: 'echo@beam.directory',
            role: 'participant',
          },
        ],
      }),
    }))

    const queueResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-approval/approval-queue', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(queueResponse.status, 200)

    const queueBody = await queueResponse.json() as {
      summary: {
        total: number
        bindingApprovals: number
        threadApprovals: number
        critical: number
      }
      items: Array<{
        id: string
        kind: 'binding' | 'thread'
        severity: 'warning' | 'critical'
        title: string
        suggestedAllowedPartners: string[]
        binding?: {
          id: number
          beamId: string
        }
        thread?: {
          id: number
          workflowType: string | null
        }
        senderBinding?: {
          beamId: string
        } | null
        partnerChannel?: {
          partnerBeamId: string
        } | null
        policyPreview?: {
          externalInitiation: string
          approvalRequired: boolean
        } | null
        dispatchReady?: boolean
        blockedReason?: string | null
      }>
    }

    assert.deepEqual(queueBody.summary, {
      total: 2,
      bindingApprovals: 1,
      threadApprovals: 1,
      critical: 1,
    })

    const bindingItem = queueBody.items.find((item) => item.kind === 'binding')
    assert.equal(bindingItem?.binding?.beamId, 'ops-bot@beam.directory')
    assert.deepEqual(bindingItem?.suggestedAllowedPartners, ['echo@beam.directory'])
    assert.equal(bindingItem?.severity, 'warning')

    const threadItem = queueBody.items.find((item) => item.kind === 'thread')
    assert.equal(threadItem?.thread?.workflowType, 'partner.review')
    assert.equal(threadItem?.senderBinding?.beamId, 'ops-bot@beam.directory')
    assert.equal(threadItem?.partnerChannel?.partnerBeamId, 'echo@beam.directory')
    assert.equal(threadItem?.policyPreview?.externalInitiation, 'deny')
    assert.equal(threadItem?.policyPreview?.approvalRequired, true)
    assert.equal(threadItem?.dispatchReady, false)
    assert.match(threadItem?.blockedReason ?? '', /policy still denies/i)
  } finally {
    db.close()
  }
})

test('workspace threads model internal discussion and external handoffs in one timeline', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    registerAgent(db, {
      beamId: 'ops-bot@beam.directory',
      displayName: 'Ops Bot',
      capabilities: ['triage', 'handoff'],
      publicKey: 'MCowBQYDK2VwAyEAyG5JwL7aQh7o4V6o8cz+Rmj4S7LnhwF4r2bp7L1fR8Q=',
      personal: true,
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Northwind Ops',
        slug: 'northwind-ops',
        externalHandoffsEnabled: true,
      }),
    }))

    const localBindingResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-ops/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: 'ops-bot@beam.directory',
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'codex',
        policyProfile: 'ops-default',
        canInitiateExternal: true,
      }),
    }))
    const localBinding = await localBindingResponse.json() as { binding: { id: number } }

    const partnerBindingResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-ops/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: 'finance@northwind.beam.directory',
        bindingType: 'partner',
        owner: 'northwind@example.com',
        policyProfile: 'partner-finance',
      }),
    }))
    const partnerBinding = await partnerBindingResponse.json() as { binding: { id: number } }

    logIntentStart(db, {
      v: '1',
      nonce: 'nonce-thread-handoff',
      from: 'ops-bot@beam.directory',
      to: 'finance@northwind.beam.directory',
      intent: 'quote.approval',
      payload: { quoteId: 'Q-77' },
      timestamp: '2026-03-31T10:00:00.000Z',
      signature: 'sig-thread',
    })
    setIntentLifecycleStatus(db, { nonce: 'nonce-thread-handoff', status: 'validated' })
    setIntentLifecycleStatus(db, { nonce: 'nonce-thread-handoff', status: 'dispatched' })
    setIntentLifecycleStatus(db, { nonce: 'nonce-thread-handoff', status: 'delivered' })
    finalizeIntentLog(db, {
      nonce: 'nonce-thread-handoff',
      fromBeamId: 'ops-bot@beam.directory',
      toBeamId: 'finance@northwind.beam.directory',
      status: 'acked',
      latencyMs: 510,
      resultJson: JSON.stringify({ approved: true }),
    })

    const internalThreadResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-ops/threads', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'internal',
        title: 'Prepare approval handoff',
        summary: 'Align buyer owner and evidence before external send.',
        owner: 'ops@example.com',
        participants: [
          {
            principalId: 'ops@example.com',
            principalType: 'human',
            displayName: 'Ops Owner',
            role: 'owner',
          },
          {
            principalId: 'ops-bot@beam.directory',
            principalType: 'agent',
            beamId: 'ops-bot@beam.directory',
            workspaceBindingId: localBinding.binding.id,
            role: 'participant',
          },
        ],
      }),
    }))
    assert.equal(internalThreadResponse.status, 201)
    const internalThreadBody = await internalThreadResponse.json() as { thread: { id: number; kind: string; trace: null } }
    assert.equal(internalThreadBody.thread.kind, 'internal')
    assert.equal(internalThreadBody.thread.trace, null)

    const blockedHandoffThreadResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-ops/threads', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'handoff',
        title: 'Await partner approval route',
        summary: 'Blocked until the runtime sends the real handoff.',
        owner: 'ops@example.com',
        workflowType: 'quote.approval',
        status: 'blocked',
        participants: [
          {
            principalId: 'ops-bot@beam.directory',
            principalType: 'agent',
            beamId: 'ops-bot@beam.directory',
            workspaceBindingId: localBinding.binding.id,
            role: 'owner',
          },
          {
            principalId: 'finance@northwind.beam.directory',
            principalType: 'partner',
            beamId: 'finance@northwind.beam.directory',
            workspaceBindingId: partnerBinding.binding.id,
            role: 'participant',
          },
        ],
      }),
    }))
    assert.equal(blockedHandoffThreadResponse.status, 201)
    const blockedHandoffThreadBody = await blockedHandoffThreadResponse.json() as {
      thread: { kind: string; status: string; linkedIntentNonce: string | null; trace: null }
    }
    assert.equal(blockedHandoffThreadBody.thread.kind, 'handoff')
    assert.equal(blockedHandoffThreadBody.thread.status, 'blocked')
    assert.equal(blockedHandoffThreadBody.thread.linkedIntentNonce, null)
    assert.equal(blockedHandoffThreadBody.thread.trace, null)

    const handoffThreadResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-ops/threads', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        kind: 'handoff',
        title: 'Quote approval handoff',
        summary: 'External finance approval with async proof.',
        owner: 'ops@example.com',
        workflowType: 'quote.approval',
        linkedIntentNonce: 'nonce-thread-handoff',
        participants: [
          {
            principalId: 'ops-bot@beam.directory',
            principalType: 'agent',
            beamId: 'ops-bot@beam.directory',
            workspaceBindingId: localBinding.binding.id,
            role: 'owner',
          },
          {
            principalId: 'finance@northwind.beam.directory',
            principalType: 'partner',
            beamId: 'finance@northwind.beam.directory',
            workspaceBindingId: partnerBinding.binding.id,
            role: 'participant',
          },
        ],
      }),
    }))
    assert.equal(handoffThreadResponse.status, 201)
    const handoffThreadBody = await handoffThreadResponse.json() as {
      thread: { id: number; kind: string; trace: { nonce: string; status: string; href: string } | null }
      participants: Array<{ beamId: string | null }>
    }
    assert.equal(handoffThreadBody.thread.kind, 'handoff')
    assert.equal(handoffThreadBody.thread.trace?.nonce, 'nonce-thread-handoff')
    assert.equal(handoffThreadBody.thread.trace?.status, 'acked')
    assert.equal(handoffThreadBody.thread.trace?.href, '/intents/nonce-thread-handoff')
    assert.equal(handoffThreadBody.participants.length, 2)

    const listResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-ops/threads', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(listResponse.status, 200)
    const listBody = await listResponse.json() as {
      total: number
      threads: Array<{ kind: string; linkedIntentNonce: string | null; participantCount: number }>
    }
    assert.equal(listBody.total, 3)
    const listedHandoffThread = listBody.threads.find((entry) => entry.kind === 'handoff' && entry.linkedIntentNonce === 'nonce-thread-handoff')
    const listedInternalThread = listBody.threads.find((entry) => entry.kind === 'internal')
    assert.equal(listedHandoffThread?.linkedIntentNonce, 'nonce-thread-handoff')
    assert.equal(listedHandoffThread?.participantCount, 2)
    assert.equal(listedInternalThread?.kind, 'internal')

    const detailResponse = await app.request(new Request(`http://localhost/admin/workspaces/northwind-ops/threads/${handoffThreadBody.thread.id}`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(detailResponse.status, 200)
    const detailBody = await detailResponse.json() as {
      thread: { kind: string; trace: { intentType: string; fromBeamId: string; toBeamId: string } | null }
      participants: Array<{ principalType: string; role: string }>
    }
    assert.equal(detailBody.thread.kind, 'handoff')
    assert.equal(detailBody.thread.trace?.intentType, 'quote.approval')
    assert.equal(detailBody.thread.trace?.fromBeamId, 'ops-bot@beam.directory')
    assert.equal(detailBody.thread.trace?.toBeamId, 'finance@northwind.beam.directory')
    assert.deepEqual(detailBody.participants.map((entry) => entry.principalType).sort(), ['agent', 'partner'])
  } finally {
    db.close()
  }
})

test('operators can approve and dispatch blocked workspace handoff threads through Beam', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    registerAgent(db, {
      beamId: 'ops-bot@beam.directory',
      displayName: 'Ops Bot',
      capabilities: ['handoff'],
      publicKey: 'MCowBQYDK2VwAyEA4Qw1l2rK2LwH5FNN+1mQ2kD2mP1eJ0C8n9rPq4xS2fI=',
      personal: true,
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Acme Dispatch Workspace',
        slug: 'acme-dispatch',
        externalHandoffsEnabled: true,
      }),
    }))

    const localBindingResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-dispatch/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: 'ops-bot@beam.directory',
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'codex:operator',
        policyProfile: 'ops-default',
        canInitiateExternal: true,
      }),
    }))
    const localBinding = await localBindingResponse.json() as { binding: { id: number } }

    const policyResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-dispatch/policy', {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowRules: [{
          workflowType: 'partner.review',
          requireApproval: true,
          allowedPartners: ['echo@beam.directory'],
          approvers: ['ops@example.com'],
        }],
      }),
    }))
    assert.equal(policyResponse.status, 200)

    const channelResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-dispatch/partner-channels', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        partnerBeamId: 'echo@beam.directory',
        label: 'Beam Echo',
        owner: 'ops@example.com',
        status: 'active',
      }),
    }))
    assert.equal(channelResponse.status, 201)

    const createThreadResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-dispatch/threads', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'handoff',
        title: 'Send cross-instance approval ping',
        summary: 'Please confirm the approval lane and respond with the next action.',
        owner: 'ops@example.com',
        workflowType: 'partner.review',
        status: 'blocked',
        draftIntentType: 'task.delegate',
        draftPayload: {
          task: 'Confirm the approval lane and return the next operator action.',
          context: 'Workspace-triggered cross-instance approval dispatch.',
          priority: 'high',
        },
        participants: [
          {
            principalId: 'ops-bot@beam.directory',
            principalType: 'agent',
            beamId: 'ops-bot@beam.directory',
            workspaceBindingId: localBinding.binding.id,
            role: 'owner',
          },
          {
            principalId: 'echo@beam.directory',
            principalType: 'partner',
            beamId: 'echo@beam.directory',
            role: 'participant',
          },
        ],
      }),
    }))
    assert.equal(createThreadResponse.status, 201)
    const createdThread = await createThreadResponse.json() as { thread: { id: number } }

    const dispatchResponse = await app.request(new Request(`http://localhost/admin/workspaces/acme-dispatch/threads/${createdThread.thread.id}/dispatch`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }))
    assert.equal(dispatchResponse.status, 200)

    const dispatchBody = await dispatchResponse.json() as {
      thread: {
        status: string
        draftIntentType: string | null
        linkedIntentNonce: string | null
        trace: {
          intentType: string
          toBeamId: string
          status: string
        } | null
      }
      partnerChannel: {
        lastIntentNonce: string | null
        trace: { nonce: string } | null
      } | null
      dispatch: {
        nonce: string
        intentType: string
        success: boolean
        traceHref: string | null
      }
    }
    assert.equal(dispatchBody.dispatch.success, true)
    assert.equal(typeof dispatchBody.dispatch.nonce, 'string')
    assert.equal(dispatchBody.thread.status, 'open')
    assert.equal(dispatchBody.thread.linkedIntentNonce, dispatchBody.dispatch.nonce)
    assert.equal(dispatchBody.dispatch.intentType, 'task.delegate')
    assert.equal(dispatchBody.thread.draftIntentType, 'task.delegate')
    assert.equal(dispatchBody.thread.trace?.intentType, 'task.delegate')
    assert.equal(dispatchBody.thread.trace?.toBeamId, 'echo@beam.directory')
    assert.equal(dispatchBody.thread.trace?.status, 'acked')
    assert.equal(dispatchBody.partnerChannel?.lastIntentNonce, dispatchBody.dispatch.nonce)
    assert.equal(dispatchBody.partnerChannel?.trace?.nonce, dispatchBody.dispatch.nonce)

    const detailResponse = await app.request(new Request(`http://localhost/admin/workspaces/acme-dispatch/threads/${createdThread.thread.id}`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(detailResponse.status, 200)
    const detailBody = await detailResponse.json() as {
      thread: {
        draftIntentType: string | null
        draftPayload: Record<string, unknown> | null
        linkedIntentNonce: string | null
        trace: { nonce: string | null } | null
      }
    }
    assert.equal(detailBody.thread.draftIntentType, 'task.delegate')
    assert.equal(detailBody.thread.draftPayload?.['task'], 'Confirm the approval lane and return the next operator action.')
    assert.equal(detailBody.thread.linkedIntentNonce, dispatchBody.dispatch.nonce)
    assert.equal(detailBody.thread.trace?.nonce, dispatchBody.dispatch.nonce)

    const timelineResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-dispatch/timeline', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(timelineResponse.status, 200)
    const timelineBody = await timelineResponse.json() as {
      entries: Array<{
        action: string
        traceHref: string | null
      }>
    }
    const dispatchEntry = timelineBody.entries.find((entry) => entry.action === 'admin.workspace_thread.dispatched')
    assert.equal(dispatchEntry?.traceHref, `/intents/${dispatchBody.dispatch.nonce}`)
  } finally {
    db.close()
  }
})

test('dispatching through a routed partner channel syncs an inbound thread into the target workspace', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    registerAgent(db, {
      beamId: 'ops-bot@beam.directory',
      displayName: 'Ops Bot',
      capabilities: ['handoff'],
      publicKey: 'MCowBQYDK2VwAyEA5vDJ0M7W0h6lJ6uQ0P+GlVj9s4m1kzJ3aPj4v5n2u7o=',
      personal: true,
    })
    registerAgent(db, {
      beamId: 'echo@beam.directory',
      displayName: 'Beam Echo',
      capabilities: ['conversation.message'],
      publicKey: 'MCowBQYDK2VwAyEAwq0kQ4gJ9J5fWfT3vA7l0v3mQ9Jw1d1lR2z6b8x7lQk=',
      personal: false,
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Acme Dispatch Workspace',
        slug: 'acme-dispatch-sync',
        externalHandoffsEnabled: true,
      }),
    }))

    await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Northwind Runtime',
        slug: 'northwind-runtime-sync',
        externalHandoffsEnabled: true,
      }),
    }))

    const localBindingResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-dispatch-sync/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: 'ops-bot@beam.directory',
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'codex:operator',
        policyProfile: 'ops-default',
        canInitiateExternal: true,
      }),
    }))
    const localBinding = await localBindingResponse.json() as { binding: { id: number } }

    const targetBindingResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-runtime-sync/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: 'echo@beam.directory',
        bindingType: 'service',
        owner: 'northwind@example.com',
        runtimeType: 'builtin:echo',
        canInitiateExternal: true,
      }),
    }))
    const targetBinding = await targetBindingResponse.json() as { binding: { id: number } }

    const policyResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-dispatch-sync/policy', {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowRules: [{
          workflowType: 'partner.review',
          requireApproval: true,
          allowedPartners: ['echo@beam.directory'],
          approvers: ['ops@example.com'],
        }],
      }),
    }))
    assert.equal(policyResponse.status, 200)

    const channelResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-dispatch-sync/partner-channels', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        partnerBeamId: 'echo@beam.directory',
        label: 'Northwind Echo',
        owner: 'ops@example.com',
        status: 'active',
      }),
    }))
    assert.equal(channelResponse.status, 201)

    const createThreadResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-dispatch-sync/threads', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'handoff',
        title: 'Sync this handoff into the routed workspace',
        summary: 'The target workspace should receive an inbound mirrored thread.',
        owner: 'ops@example.com',
        workflowType: 'partner.review',
        status: 'blocked',
        draftIntentType: 'conversation.message',
        draftPayload: {
          message: 'Please confirm the inbound thread sync path.',
          language: 'en',
        },
        participants: [
          {
            principalId: 'ops-bot@beam.directory',
            principalType: 'agent',
            beamId: 'ops-bot@beam.directory',
            workspaceBindingId: localBinding.binding.id,
            role: 'owner',
          },
          {
            principalId: 'echo@beam.directory',
            principalType: 'partner',
            beamId: 'echo@beam.directory',
            role: 'participant',
          },
        ],
      }),
    }))
    assert.equal(createThreadResponse.status, 201)
    const createdThread = await createThreadResponse.json() as { thread: { id: number } }

    const dispatchResponse = await app.request(new Request(`http://localhost/admin/workspaces/acme-dispatch-sync/threads/${createdThread.thread.id}/dispatch`, {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }))
    assert.equal(dispatchResponse.status, 200)

    const dispatchBody = await dispatchResponse.json() as {
      dispatch: {
        nonce: string
        success: boolean
      }
      workspaceSync: {
        workspaceSlug: string
        workspaceName: string
        threadId: number
        disposition: string
      } | null
    }
    assert.equal(dispatchBody.dispatch.success, true)
    assert.equal(dispatchBody.workspaceSync?.workspaceSlug, 'northwind-runtime-sync')
    assert.equal(dispatchBody.workspaceSync?.workspaceName, 'Northwind Runtime')
    assert.equal(dispatchBody.workspaceSync?.disposition, 'created')

    const targetThreadResponse = await app.request(new Request(`http://localhost/admin/workspaces/northwind-runtime-sync/threads/${dispatchBody.workspaceSync?.threadId}`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(targetThreadResponse.status, 200)
    const targetThreadBody = await targetThreadResponse.json() as {
      thread: {
        kind: string
        linkedIntentNonce: string | null
        draftIntentType: string | null
        owner: string | null
      }
      participants: Array<{
        beamId: string | null
        workspaceBindingId: number | null
        principalType: string
      }>
    }
    assert.equal(targetThreadBody.thread.kind, 'handoff')
    assert.equal(targetThreadBody.thread.linkedIntentNonce, dispatchBody.dispatch.nonce)
    assert.equal(targetThreadBody.thread.draftIntentType, 'conversation.message')
    assert.equal(targetThreadBody.thread.owner, 'northwind@example.com')
    assert.ok(targetThreadBody.participants.some((participant) => participant.beamId === 'ops-bot@beam.directory' && participant.principalType === 'partner'))
    assert.ok(targetThreadBody.participants.some((participant) => participant.beamId === 'echo@beam.directory' && participant.workspaceBindingId === targetBinding.binding.id))

    const targetTimelineResponse = await app.request(new Request('http://localhost/admin/workspaces/northwind-runtime-sync/timeline?limit=20', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(targetTimelineResponse.status, 200)
    const targetTimelineBody = await targetTimelineResponse.json() as {
      entries: Array<{
        action: string
        traceHref: string | null
      }>
    }
    const syncEntry = targetTimelineBody.entries.find((entry) => entry.action === 'admin.workspace_thread.synced')
    assert.equal(syncEntry?.traceHref, `/intents/${dispatchBody.dispatch.nonce}`)
  } finally {
    db.close()
  }
})

test('workspace partner channels, timeline, and digest expose operator-ready control-plane state', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    registerAgent(db, {
      beamId: 'ops-bot@beam.directory',
      displayName: 'Ops Bot',
      capabilities: ['handoff'],
      publicKey: 'MCowBQYDK2VwAyEAw2QJY0YH7e1L2+2VQ1bH4TqL6wCnC8n9v8m8z4vPsxM=',
      personal: true,
    })
    registerAgent(db, {
      beamId: 'finance@northwind.beam.directory',
      displayName: 'Northwind Finance Bot',
      capabilities: ['invoice.review'],
      publicKey: 'MCowBQYDK2VwAyEA3n3d9X0+uB4bSv9C0L+QW6T8wdkM3Vn2QJw1bE8W2dQ=',
      personal: false,
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Acme Finance',
        slug: 'acme-finance',
        externalHandoffsEnabled: true,
      }),
    }))

    await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Northwind Runtime',
        slug: 'northwind-runtime',
        externalHandoffsEnabled: true,
      }),
    }))

    await app.request(new Request('http://localhost/admin/workspaces/northwind-runtime/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: 'finance@northwind.beam.directory',
        bindingType: 'agent',
        owner: 'northwind@example.com',
        runtimeType: 'codex:finance',
        canInitiateExternal: true,
      }),
    }))

    const bindingResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-finance/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: 'ops-bot@beam.directory',
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'codex:operator',
        policyProfile: 'finance-default',
        canInitiateExternal: false,
      }),
    }))
    const bindingBody = await bindingResponse.json() as { binding: { id: number } }

    const channelResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-finance/partner-channels', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        partnerBeamId: 'finance@northwind.beam.directory',
        label: 'Northwind Finance',
        owner: 'northwind@example.com',
        status: 'trial',
        notes: 'Trial until the first approval flow settles.',
      }),
    }))
    assert.equal(channelResponse.status, 201)
    const channelBody = await channelResponse.json() as {
      channel: {
        id: number
        status: string
        healthStatus: string
      }
    }
    assert.equal(channelBody.channel.status, 'trial')
    assert.equal(channelBody.channel.healthStatus, 'watch')

    const channelPatchResponse = await app.request(new Request(`http://localhost/admin/workspaces/acme-finance/partner-channels/${channelBody.channel.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'blocked',
        notes: 'Blocked until manual approval policy is tightened.',
      }),
    }))
    assert.equal(channelPatchResponse.status, 200)

    const blockedThreadResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-finance/threads', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        kind: 'handoff',
        title: 'Invoice approval needs operator review',
        summary: 'Waiting for approval policy before the runtime sends outward.',
        owner: 'ops@example.com',
        status: 'blocked',
        workflowType: 'invoice.review',
        participants: [
          {
            principalId: 'ops-bot@beam.directory',
            principalType: 'agent',
            beamId: 'ops-bot@beam.directory',
            workspaceBindingId: bindingBody.binding.id,
            role: 'owner',
          },
          {
            principalId: 'finance@northwind.beam.directory',
            principalType: 'partner',
            beamId: 'finance@northwind.beam.directory',
            role: 'participant',
          },
        ],
      }),
    }))
    assert.equal(blockedThreadResponse.status, 201)

    const channelsListResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-finance/partner-channels', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(channelsListResponse.status, 200)
    const channelsListBody = await channelsListResponse.json() as {
      total: number
      channels: Array<{
        status: string
        healthStatus: string
        workspaceRoute: {
          workspaceSlug: string
          workspaceName: string
          runtime: {
            mode: string
          }
        } | null
      }>
    }
    assert.equal(channelsListBody.total, 1)
    assert.equal(channelsListBody.channels[0]?.status, 'blocked')
    assert.equal(channelsListBody.channels[0]?.healthStatus, 'critical')
    assert.equal(channelsListBody.channels[0]?.workspaceRoute?.workspaceSlug, 'northwind-runtime')
    assert.equal(channelsListBody.channels[0]?.workspaceRoute?.workspaceName, 'Northwind Runtime')
    assert.equal(channelsListBody.channels[0]?.workspaceRoute?.runtime.mode, 'runtime-backed')

    const timelineResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-finance/timeline?limit=20', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(timelineResponse.status, 200)
    const timelineBody = await timelineResponse.json() as {
      total: number
      entries: Array<{
        kind: string
        action: string
      }>
    }
    assert.ok(timelineBody.total >= 4)
    assert.ok(timelineBody.entries.some((entry) => entry.kind === 'partner_channel'))
    assert.ok(timelineBody.entries.some((entry) => entry.kind === 'thread'))

    const digestResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-finance/digest', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(digestResponse.status, 200)
    const digestBody = await digestResponse.json() as {
      summary: {
        actionItems: number
        escalations: number
      }
      actionItems: Array<{
        category: string
      }>
      markdown: string
    }
    assert.ok(digestBody.summary.actionItems >= 2)
    assert.ok(digestBody.summary.escalations >= 1)
    assert.ok(digestBody.actionItems.some((item) => item.category === 'partner_channel'))
    assert.match(digestBody.markdown, /Beam workspace digest/i)

    const digestDeliveryResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-finance/digest/deliver', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }))
    assert.equal(digestDeliveryResponse.status, 503)
  } finally {
    db.close()
  }
})

test('workspace policy routes expose normalized policy and enforcement-ready binding previews', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    registerAgent(db, {
      beamId: 'ops-bot@beam.directory',
      displayName: 'Ops Bot',
      capabilities: ['handoff'],
      publicKey: 'MCowBQYDK2VwAyEAw2QJY0YH7e1L2+2VQ1bH4TqL6wCnC8n9v8m8z4vPsxM=',
      personal: true,
    })

    const app = createApp(db)
    const adminHeaders = {
      ...createAdminHeaders(db, 'admin@example.com', 'admin'),
      'content-type': 'application/json',
    }

    await app.request(new Request('http://localhost/admin/workspaces', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'Acme Finance',
        slug: 'acme-finance',
        externalHandoffsEnabled: true,
      }),
    }))

    await app.request(new Request('http://localhost/admin/workspaces/acme-finance/identities', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        beamId: 'ops-bot@beam.directory',
        bindingType: 'agent',
        owner: 'ops@example.com',
        runtimeType: 'codex',
        policyProfile: 'finance-outbound',
        canInitiateExternal: false,
      }),
    }))

    const initialPolicyResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-finance/policy', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(initialPolicyResponse.status, 200)
    const initialPolicy = await initialPolicyResponse.json() as {
      policy: {
        defaults: { externalInitiation: string }
        bindingRules: unknown[]
        workflowRules: unknown[]
      }
      previews: {
        bindings: Array<{ beamId: string; externalInitiation: string }>
      }
    }
    assert.equal(initialPolicy.policy.defaults.externalInitiation, 'binding')
    assert.equal(initialPolicy.policy.bindingRules.length, 0)
    assert.equal(initialPolicy.previews.bindings[0]?.externalInitiation, 'deny')

    const patchResponse = await app.request(new Request('http://localhost/admin/workspaces/acme-finance/policy', {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        defaults: {
          externalInitiation: 'deny',
          allowedPartners: ['*@northwind.beam.directory'],
        },
        bindingRules: [
          {
            policyProfile: 'finance-outbound',
            externalInitiation: 'allow',
            allowedPartners: ['finance@northwind.beam.directory'],
          },
        ],
        workflowRules: [
          {
            workflowType: 'quote.approval',
            requireApproval: true,
            allowedPartners: ['finance@northwind.beam.directory'],
            approvers: ['ops@example.com', 'approvals@example.com'],
          },
        ],
        metadata: {
          notes: 'Finance outbound handoffs need named approvers.',
        },
      }),
    }))
    assert.equal(patchResponse.status, 200)
    const patchBody = await patchResponse.json() as {
      updated: boolean
      updatedBy: string | null
      policy: {
        defaults: { externalInitiation: string; allowedPartners: string[] }
        bindingRules: Array<{ policyProfile: string | null; externalInitiation: string; allowedPartners: string[] }>
        workflowRules: Array<{ workflowType: string; requireApproval: boolean; approvers: string[] }>
        metadata: { notes: string | null }
      }
      previews: {
        bindings: Array<{ beamId: string; externalInitiation: string; allowedPartners: string[] }>
        workflows: Array<{
          workflowType: string
          bindings: Array<{ beamId: string; externalInitiation: string; approvalRequired: boolean; approvers: string[] }>
        }>
      }
    }
    assert.equal(patchBody.updated, true)
    assert.equal(patchBody.updatedBy, 'ops@example.com')
    assert.equal(patchBody.policy.defaults.externalInitiation, 'deny')
    assert.deepEqual(patchBody.policy.defaults.allowedPartners, ['*@northwind.beam.directory'])
    assert.equal(patchBody.policy.bindingRules[0]?.policyProfile, 'finance-outbound')
    assert.equal(patchBody.policy.bindingRules[0]?.externalInitiation, 'allow')
    assert.deepEqual(patchBody.policy.bindingRules[0]?.allowedPartners, ['finance@northwind.beam.directory'])
    assert.equal(patchBody.policy.workflowRules[0]?.workflowType, 'quote.approval')
    assert.equal(patchBody.policy.workflowRules[0]?.requireApproval, true)
    assert.deepEqual(patchBody.policy.workflowRules[0]?.approvers, ['ops@example.com', 'approvals@example.com'])
    assert.match(patchBody.policy.metadata.notes ?? '', /named approvers/i)
    assert.equal(patchBody.previews.bindings[0]?.beamId, 'ops-bot@beam.directory')
    assert.equal(patchBody.previews.bindings[0]?.externalInitiation, 'allow')
    assert.deepEqual(patchBody.previews.bindings[0]?.allowedPartners, ['*@northwind.beam.directory', 'finance@northwind.beam.directory'])
    assert.equal(patchBody.previews.workflows[0]?.workflowType, 'quote.approval')
    assert.equal(patchBody.previews.workflows[0]?.bindings[0]?.approvalRequired, true)
    assert.deepEqual(patchBody.previews.workflows[0]?.bindings[0]?.approvers, ['ops@example.com', 'approvals@example.com'])
  } finally {
    db.close()
  }
})
