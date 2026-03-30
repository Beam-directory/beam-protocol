import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminSession } from './admin-auth.js'
import { createApp } from './server.js'
import { assignDirectoryRole, createDatabase } from './db.js'
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

test('cors allows production public-site and loopback dashboard origins', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)

    const beamOriginResponse = await app.request(new Request('http://localhost/health', {
      headers: { Origin: 'https://beam.directory' },
    }))
    assert.equal(beamOriginResponse.headers.get('access-control-allow-origin'), 'https://beam.directory')

    const localOriginResponse = await app.request(new Request('http://localhost/health', {
      headers: { Origin: 'http://localhost:43173' },
    }))
    assert.equal(localOriginResponse.headers.get('access-control-allow-origin'), 'http://localhost:43173')

    const unknownOriginResponse = await app.request(new Request('http://localhost/health', {
      headers: { Origin: 'https://evil.example' },
    }))
    assert.equal(unknownOriginResponse.headers.get('access-control-allow-origin'), null)
  } finally {
    db.close()
  }
})

test('waitlist signups are idempotent by email and preserve the original created timestamp', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)

    const firstResponse = await app.request(new Request('http://localhost/waitlist', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://beam.directory',
      },
      body: JSON.stringify({
        email: 'ops@example.com',
        source: 'hosted-beta',
        company: 'Acme',
        agentCount: 8,
      }),
    }))

    assert.equal(firstResponse.status, 201)
    assert.equal(firstResponse.headers.get('access-control-allow-origin'), 'https://beam.directory')
    const first = await firstResponse.json() as {
      ok: boolean
      status: string
      request: {
        createdAt: string
        company: string
        agentCount: number
        requestStatus: string
        stage: string
        nextAction: string
        lastContactAt: string | null
        attentionFlags: string[]
        notificationStatus: string
        notificationId: number
      }
    }
    assert.equal(first.ok, true)
    assert.equal(first.status, 'registered')
    assert.equal(first.request.company, 'Acme')
    assert.equal(first.request.agentCount, 8)
    assert.equal(first.request.requestStatus, 'new')
    assert.equal(first.request.stage, 'new')
    assert.equal(first.request.lastContactAt, null)
    assert.ok(first.request.nextAction.length > 0)
    assert.deepEqual(first.request.attentionFlags, ['unowned'])
    assert.equal(first.request.notificationStatus, 'new')
    assert.ok(first.request.notificationId > 0)

    const secondResponse = await app.request(new Request('http://localhost/waitlist', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://beam.directory',
      },
      body: JSON.stringify({
        email: 'ops@example.com',
        source: 'hosted-beta-follow-up',
        company: 'Acme Renewed',
        agentCount: 14,
      }),
    }))

    assert.equal(secondResponse.status, 200)
    const second = await secondResponse.json() as {
      ok: boolean
      status: string
      request: {
        createdAt: string
        company: string
        agentCount: number
        source: string
        stage: string
        notificationStatus: string
      }
    }
    assert.equal(second.ok, true)
    assert.equal(second.status, 'already_registered')
    assert.equal(second.request.company, 'Acme Renewed')
    assert.equal(second.request.agentCount, 14)
    assert.equal(second.request.source, 'hosted-beta-follow-up')
    assert.equal(second.request.createdAt, first.request.createdAt)
    assert.equal(second.request.stage, 'new')
    assert.equal(second.request.notificationStatus, 'new')

    const row = db.prepare(`
      SELECT COUNT(*) AS count, company, agent_count, source, created_at
      FROM waitlist
      WHERE email = ?
    `).get('ops@example.com') as {
      count: number
      company: string
      agent_count: number
      source: string
      created_at: string
    }

    assert.equal(row.count, 1)
    assert.equal(row.company, 'Acme Renewed')
    assert.equal(row.agent_count, 14)
    assert.equal(row.source, 'hosted-beta-follow-up')
    assert.equal(row.created_at, first.request.createdAt)
  } finally {
    db.close()
  }
})

test('hosted beta requests can be created publicly, reviewed by operators, and exported', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)

    const createResponse = await app.request(new Request('http://localhost/waitlist', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: 'https://beam.directory',
      },
      body: JSON.stringify({
        email: 'buyer@example.com',
        source: 'hosted-beta-page',
        company: 'Northwind Systems',
        agentCount: 6,
        workflowType: 'hosted-beta-partner-handoff',
        workflowSummary: 'Procurement asks partner operations for stock, then finance approves the async quote.',
      }),
    }))

    assert.equal(createResponse.status, 201)
    const created = await createResponse.json() as {
      ok: boolean
      request: {
        id: number
        source: string
        workflowType: string
        workflowSummary: string
        requestStatus: string
        stage: string
        notificationId: number
        notificationStatus: string
        attentionFlags: string[]
      }
      nextStep: string
    }
    assert.equal(created.ok, true)
    assert.equal(created.request.source, 'hosted-beta-page')
    assert.equal(created.request.workflowType, 'hosted-beta-partner-handoff')
    assert.match(created.request.workflowSummary, /Procurement/)
    assert.equal(created.request.requestStatus, 'new')
    assert.equal(created.request.stage, 'new')
    assert.ok(created.request.notificationId > 0)
    assert.equal(created.request.notificationStatus, 'new')
    assert.deepEqual(created.request.attentionFlags, ['unowned'])
    assert.match(created.nextStep, /review/i)

    const listResponse = await app.request(new Request('http://localhost/admin/beta-requests?status=new&attention=unowned&sort=attention', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(listResponse.status, 200)

    const listed = await listResponse.json() as {
      total: number
      requests: Array<{
        id: number
        email: string
        workflowSummary: string
        requestStatus: string
        attentionFlags: string[]
        notificationStatus: string
      }>
      summary: {
        total: number
        unowned: number
        stale: number
        needsAttention: number
        byStatus: Record<string, number>
      }
    }
    assert.equal(listed.total, 1)
    assert.equal(listed.summary.total, 1)
    assert.equal(listed.summary.unowned, 1)
    assert.equal(listed.summary.stale, 0)
    assert.equal(listed.summary.needsAttention, 1)
    assert.equal(listed.summary.byStatus['new'], 1)
    assert.equal(listed.requests[0]?.email, 'buyer@example.com')
    assert.match(listed.requests[0]?.workflowSummary ?? '', /finance approves/)
    assert.deepEqual(listed.requests[0]?.attentionFlags ?? [], ['unowned'])
    assert.equal(listed.requests[0]?.notificationStatus, 'new')

    const inboxResponse = await app.request(new Request('http://localhost/admin/operator-notifications?source=beta_request&status=new', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(inboxResponse.status, 200)

    const inboxPayload = await inboxResponse.json() as {
      total: number
      notifications: Array<{
        id: number
        betaRequestId: number | null
        status: string
        sourceType: string
      }>
      summary: {
        byStatus: Record<string, number>
        bySource: Record<string, number>
      }
    }
    assert.equal(inboxPayload.total, 1)
    assert.equal(inboxPayload.summary.byStatus['new'], 1)
    assert.equal(inboxPayload.summary.bySource['beta_request'], 1)
    assert.equal(inboxPayload.notifications[0]?.betaRequestId, created.request.id)
    assert.equal(inboxPayload.notifications[0]?.status, 'new')
    assert.equal(inboxPayload.notifications[0]?.sourceType, 'beta_request')

    const updateResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${created.request.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'operator@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'reviewing',
        owner: 'operator@example.com',
        operatorNotes: 'Intro email sent, follow-up call pending.',
      }),
    }))
    assert.equal(updateResponse.status, 200)

    const updated = await updateResponse.json() as {
      ok: boolean
      request: {
        requestStatus: string
        stage: string
        owner: string
        operatorNotes: string
        notificationStatus: string
        attentionFlags: string[]
      }
    }
    assert.equal(updated.ok, true)
    assert.equal(updated.request.requestStatus, 'reviewing')
    assert.equal(updated.request.stage, 'reviewing')
    assert.equal(updated.request.owner, 'operator@example.com')
    assert.match(updated.request.operatorNotes, /Intro email/)
    assert.equal(updated.request.notificationStatus, 'acknowledged')
    assert.deepEqual(updated.request.attentionFlags, [])

    const contactTimestamp = '2026-03-30T20:15:00.000Z'
    const contactResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${created.request.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'operator@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'contacted',
        nextAction: 'Schedule a 30 minute pilot review with procurement and finance.',
        lastContactAt: contactTimestamp,
      }),
    }))
    assert.equal(contactResponse.status, 200)

    const contacted = await contactResponse.json() as {
      ok: boolean
      request: {
        requestStatus: string
        nextAction: string
        lastContactAt: string | null
        notificationStatus: string
      }
    }
    assert.equal(contacted.ok, true)
    assert.equal(contacted.request.requestStatus, 'contacted')
    assert.equal(contacted.request.nextAction, 'Schedule a 30 minute pilot review with procurement and finance.')
    assert.equal(contacted.request.lastContactAt, contactTimestamp)
    assert.equal(contacted.request.notificationStatus, 'acted')

    const actedInboxResponse = await app.request(new Request('http://localhost/admin/operator-notifications?source=beta_request&status=acted', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(actedInboxResponse.status, 200)

    const actedInbox = await actedInboxResponse.json() as {
      total: number
      notifications: Array<{
        betaRequestId: number | null
        status: string
      }>
    }
    assert.equal(actedInbox.total, 1)
    assert.equal(actedInbox.notifications[0]?.betaRequestId, created.request.id)
    assert.equal(actedInbox.notifications[0]?.status, 'acted')

    const exportResponse = await app.request(new Request('http://localhost/admin/beta-requests/export?format=csv', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(exportResponse.status, 200)
    assert.equal(exportResponse.headers.get('content-type'), 'text/csv; charset=utf-8')
    const csv = await exportResponse.text()
    assert.match(csv, /workflow_summary/)
    assert.match(csv, /next_action/)
    assert.match(csv, /last_contact_at/)
    assert.match(csv, /notification_status/)
    assert.match(csv, /attention_flags/)
    assert.match(csv, /Northwind Systems/)
    assert.match(csv, /operator@example.com/)
    assert.match(csv, /Schedule a 30 minute pilot review/)
    assert.match(csv, /acted/)
  } finally {
    db.close()
  }
})

test('health, stats, and release endpoint expose consistent live release metadata', async () => {
  const db = createDatabase(':memory:')
  const originalVersion = process.env['BEAM_RELEASE_VERSION']
  const originalSha = process.env['BEAM_RELEASE_SHA']
  const originalDeployedAt = process.env['BEAM_DEPLOYED_AT']

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    process.env['BEAM_RELEASE_VERSION'] = '0.7.0-test'
    process.env['BEAM_RELEASE_SHA'] = 'abcdef1234567890abcdef1234567890abcdef12'
    process.env['BEAM_DEPLOYED_AT'] = '2026-03-30T19:00:00.000Z'

    const app = createApp(db)

    const [healthResponse, statsResponse, releaseResponse] = await Promise.all([
      app.request('http://localhost/health'),
      app.request('http://localhost/stats'),
      app.request('http://localhost/release'),
    ])

    assert.equal(healthResponse.status, 200)
    assert.equal(statsResponse.status, 200)
    assert.equal(releaseResponse.status, 200)

    const health = await healthResponse.json() as {
      version: string
      gitSha: string
      deployedAt: string
      release: { version: string; gitSha: string; gitShaShort: string; deployedAt: string }
    }
    const stats = await statsResponse.json() as {
      version: string
      gitSha: string
      deployedAt: string
      release: { version: string; gitSha: string; gitShaShort: string; deployedAt: string }
    }
    const release = await releaseResponse.json() as {
      release: { version: string; gitSha: string; gitShaShort: string; deployedAt: string }
    }

    assert.equal(health.version, '0.7.0-test')
    assert.equal(stats.version, '0.7.0-test')
    assert.equal(release.release.version, '0.7.0-test')
    assert.equal(health.gitSha, 'abcdef1234567890abcdef1234567890abcdef12')
    assert.equal(stats.gitSha, 'abcdef1234567890abcdef1234567890abcdef12')
    assert.equal(release.release.gitShaShort, 'abcdef1')
    assert.equal(health.deployedAt, '2026-03-30T19:00:00.000Z')
    assert.deepEqual(health.release, stats.release)
    assert.deepEqual(stats.release, release.release)
  } finally {
    if (originalVersion === undefined) delete process.env['BEAM_RELEASE_VERSION']
    else process.env['BEAM_RELEASE_VERSION'] = originalVersion

    if (originalSha === undefined) delete process.env['BEAM_RELEASE_SHA']
    else process.env['BEAM_RELEASE_SHA'] = originalSha

    if (originalDeployedAt === undefined) delete process.env['BEAM_DEPLOYED_AT']
    else process.env['BEAM_DEPLOYED_AT'] = originalDeployedAt

    db.close()
  }
})
