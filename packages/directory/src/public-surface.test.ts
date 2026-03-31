import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminSession } from './admin-auth.js'
import { createApp } from './server.js'
import { appendIntentTraceEvent, assignDirectoryRole, createDatabase, finalizeIntentLog, logIntentStart, registerAgent, setIntentLifecycleStatus, upsertOperatorNotification } from './db.js'
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

    const docsOriginResponse = await app.request(new Request('http://localhost/health', {
      headers: { Origin: 'https://docs.beam.directory' },
    }))
    assert.equal(docsOriginResponse.headers.get('access-control-allow-origin'), 'https://docs.beam.directory')

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

test('critical operator signals can capture owner and next action through the admin API', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)
    const created = upsertOperatorNotification(db, {
      sourceType: 'critical_alert',
      sourceKey: 'critical-alert:network-error-rate',
      alertId: 'network-error-rate',
      severity: 'critical',
      title: 'Error rate exceeded threshold',
      message: '25% of completed intents failed.',
      href: '/alerts?alert=network-error-rate',
      nextAction: 'Open the latest failing trace.',
    })

    const response = await app.request(new Request(`http://localhost/admin/operator-notifications/${created.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'acknowledged',
        owner: 'ops@example.com',
        nextAction: 'Confirm the downstream route, then decide whether to requeue.',
      }),
    }))

    assert.equal(response.status, 200)
    const body = await response.json() as {
      ok: boolean
      notification: {
        status: string
        owner: string | null
        nextAction: string | null
      }
    }
    assert.equal(body.ok, true)
    assert.equal(body.notification.status, 'acknowledged')
    assert.equal(body.notification.owner, 'ops@example.com')
    assert.match(body.notification.nextAction ?? '', /requeue/i)
  } finally {
    db.close()
  }
})

test('first-party funnel analytics ingest and summary stay available through the admin API', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)

    const events = [
      {
        sessionId: 'sessionlanding123',
        pageKey: 'landing',
        eventCategory: 'page_view',
      },
      {
        sessionId: 'sessionlanding123',
        pageKey: 'landing',
        eventCategory: 'cta_click',
        ctaKey: 'landing_guided_eval_hero',
        targetPage: 'guided_evaluation',
      },
      {
        sessionId: 'sessionlanding123',
        pageKey: 'guided_evaluation',
        eventCategory: 'page_view',
      },
      {
        sessionId: 'sessionlanding123',
        pageKey: 'guided_evaluation',
        eventCategory: 'demo_milestone',
        milestoneKey: 'guided_evaluation_view',
      },
      {
        sessionId: 'sessionrequest456',
        pageKey: 'hosted_beta',
        eventCategory: 'request',
        workflowType: 'hosted-beta-partner-handoff',
        milestoneKey: 'hosted_beta_request_submitted',
      },
    ]

    for (const payload of events) {
      const response = await app.request(new Request('http://localhost/analytics/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: 'https://beam.directory',
        },
        body: JSON.stringify(payload),
      }))
      assert.equal(response.status, 202)
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://beam.directory')
    }

    const summaryResponse = await app.request(new Request('http://localhost/admin/funnel?days=30', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))

    assert.equal(summaryResponse.status, 200)
    const summary = await summaryResponse.json() as {
      summary: {
        anonymousSessions: number
        landingSessions: number
        guidedSessions: number
        requestSessions: number
        demoSessions: number
      }
      ctaClicks: Array<{ ctaKey: string; sessions: number }>
      workflows: Array<{ workflowType: string; sessions: number }>
    }

    assert.equal(summary.summary.anonymousSessions, 2)
    assert.equal(summary.summary.landingSessions, 1)
    assert.equal(summary.summary.guidedSessions, 1)
    assert.equal(summary.summary.requestSessions, 1)
    assert.equal(summary.summary.demoSessions, 1)
    assert.equal(summary.ctaClicks[0]?.ctaKey, 'landing_guided_eval_hero')
    assert.equal(summary.workflows[0]?.workflowType, 'hosted-beta-partner-handoff')
  } finally {
    db.close()
  }
})

test('partner-stage analytics and overdue follow-up reporting stay available through the funnel API', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)

    const createdIds: number[] = []
    for (const input of [
      {
        email: 'new@example.com',
        company: 'Fresh Intake',
        workflowSummary: 'New design-partner request.',
      },
      {
        email: 'reviewing@example.com',
        company: 'Qualified Buyer',
        workflowSummary: 'Operator is qualifying the workflow.',
      },
      {
        email: 'scheduled@example.com',
        company: 'Scheduled Pilot',
        workflowSummary: 'The pilot review is already booked.',
      },
      {
        email: 'closed@example.com',
        company: 'Completed Pilot',
        workflowSummary: 'The pilot finished and needs a clear rollout step.',
      },
    ]) {
      const response = await app.request(new Request('http://localhost/waitlist', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Origin: 'https://beam.directory',
        },
        body: JSON.stringify({
          ...input,
          source: 'hosted-beta-page',
          workflowType: 'hosted-beta-partner-handoff',
          agentCount: 4,
        }),
      }))
      assert.equal(response.status, 201)
      const body = await response.json() as { request: { id: number } }
      createdIds.push(body.request.id)
    }

    const [newId, reviewingId, scheduledId, closedId] = createdIds

    const reviewingResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${reviewingId}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'reviewing',
        owner: 'ops@example.com',
        nextAction: 'Qualify the workflow and confirm the pilot scope.',
      }),
    }))
    assert.equal(reviewingResponse.status, 200)

    const scheduledResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${scheduledId}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'scheduled',
        owner: 'ops@example.com',
        nextAction: 'Run the pilot review and confirm the next deployment step.',
        nextMeetingAt: '2026-04-03T09:00:00.000Z',
        reminderAt: '2026-03-30T09:00:00.000Z',
      }),
    }))
    assert.equal(scheduledResponse.status, 200)

    const closedResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${closedId}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'closed',
        owner: 'ops@example.com',
        nextAction: 'Move the completed pilot into a scoped rollout plan.',
      }),
    }))
    assert.equal(closedResponse.status, 200)

    db.prepare(`
      UPDATE waitlist
      SET stage_entered_at = ?, updated_at = ?
      WHERE id = ?
    `).run('2026-03-26T09:00:00.000Z', '2026-03-26T09:00:00.000Z', newId)

    const analyticsResponse = await app.request(new Request('http://localhost/admin/funnel?days=30', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(analyticsResponse.status, 200)

    const analytics = await analyticsResponse.json() as {
      partnerMotion: {
        summary: {
          requests: number
          qualified: number
          scheduled: number
          pilotComplete: number
          nextStepReady: number
          overdueFollowUps: number
          stalledRequests: number
          unowned: number
        }
        byStage: Array<{
          stage: string
          count: number
          stale: number
          followUpDue: number
          unowned: number
        }>
        stalled: Array<{
          id: number
          stage: string
          attentionFlags: string[]
          followUpReason: string | null
          staleReason: string | null
        }>
        weekly: Array<{
          weekStart: string
          requests: number
          qualified: number
          scheduled: number
          pilotComplete: number
          nextStepReady: number
        }>
        workflows: Array<{
          workflowType: string
          requests: number
          qualified: number
          scheduled: number
          pilotComplete: number
          overdue: number
        }>
      }
    }

    assert.equal(analytics.partnerMotion.summary.requests, 4)
    assert.equal(analytics.partnerMotion.summary.qualified, 3)
    assert.equal(analytics.partnerMotion.summary.scheduled, 2)
    assert.equal(analytics.partnerMotion.summary.pilotComplete, 1)
    assert.equal(analytics.partnerMotion.summary.nextStepReady, 3)
    assert.equal(analytics.partnerMotion.summary.overdueFollowUps, 1)
    assert.equal(analytics.partnerMotion.summary.stalledRequests, 2)
    assert.equal(analytics.partnerMotion.summary.unowned, 1)

    const newStage = analytics.partnerMotion.byStage.find((entry) => entry.stage === 'new')
    assert.equal(newStage?.count, 1)
    assert.equal(newStage?.stale, 1)
    assert.equal(newStage?.unowned, 1)

    const scheduledStage = analytics.partnerMotion.byStage.find((entry) => entry.stage === 'scheduled')
    assert.equal(scheduledStage?.count, 1)
    assert.equal(scheduledStage?.followUpDue, 1)

    assert.equal(analytics.partnerMotion.stalled.length, 2)
    assert.equal(analytics.partnerMotion.stalled[0]?.id, scheduledId)
    assert.ok(analytics.partnerMotion.stalled[0]?.attentionFlags.includes('follow_up_due'))
    assert.match(analytics.partnerMotion.stalled[0]?.followUpReason ?? '', /reminder/i)
    assert.equal(analytics.partnerMotion.stalled[1]?.id, newId)
    assert.ok(analytics.partnerMotion.stalled[1]?.attentionFlags.includes('stale'))
    assert.match(analytics.partnerMotion.stalled[1]?.staleReason ?? '', /24\+ hours/i)

    assert.ok(analytics.partnerMotion.weekly.length >= 1)
    assert.equal(analytics.partnerMotion.weekly[0]?.requests, 4)
    assert.equal(analytics.partnerMotion.weekly[0]?.qualified, 3)
    assert.equal(analytics.partnerMotion.weekly[0]?.scheduled, 2)
    assert.equal(analytics.partnerMotion.weekly[0]?.pilotComplete, 1)
    assert.equal(analytics.partnerMotion.weekly[0]?.nextStepReady, 3)

    assert.equal(analytics.partnerMotion.workflows[0]?.workflowType, 'hosted-beta-partner-handoff')
    assert.equal(analytics.partnerMotion.workflows[0]?.requests, 4)
    assert.equal(analytics.partnerMotion.workflows[0]?.qualified, 3)
    assert.equal(analytics.partnerMotion.workflows[0]?.scheduled, 2)
    assert.equal(analytics.partnerMotion.workflows[0]?.pilotComplete, 1)
    assert.equal(analytics.partnerMotion.workflows[0]?.overdue, 1)
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
        nextMeetingAt: string | null
        reminderAt: string | null
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
    assert.equal(created.request.nextMeetingAt, null)
    assert.equal(created.request.reminderAt, null)
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
        followUpDue: number
        needsAttention: number
        byStatus: Record<string, number>
      }
    }
    assert.equal(listed.total, 1)
    assert.equal(listed.summary.total, 1)
    assert.equal(listed.summary.unowned, 1)
    assert.equal(listed.summary.stale, 0)
    assert.equal(listed.summary.followUpDue, 0)
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

    const proofNonce = 'pilot-proof-demo-0001'
    registerAgent(db, {
      beamId: 'procurement@acme.beam.directory',
      displayName: 'Acme Procurement',
      capabilities: ['procurement'],
      publicKey: 'MCowBQYDK2VwAyEAEHzHjWwTn/RZiC407+hCtk8nde/GEVUn85iOaZBH2Bw=',
      verificationTier: 'business',
      email: 'procurement@acme.example',
      emailVerified: true,
    })
    registerAgent(db, {
      beamId: 'finance@northwind.beam.directory',
      displayName: 'Northwind Finance',
      capabilities: ['finance'],
      publicKey: 'MCowBQYDK2VwAyEAr+N7jwgoTnwP/02HeC88JezBI3D/FbtcWbhOOyUpM8Y=',
      verificationTier: 'verified',
      email: 'finance@northwind.example',
      emailVerified: true,
    })
    logIntentStart(db, {
      v: '1',
      nonce: proofNonce,
      from: 'procurement@acme.beam.directory',
      to: 'finance@northwind.beam.directory',
      intent: 'conversation.message',
      payload: { message: 'Can you approve the async quote?' },
      timestamp: '2026-03-30T20:15:30.000Z',
    })
    appendIntentTraceEvent(db, {
      nonce: proofNonce,
      fromBeamId: 'procurement@acme.beam.directory',
      toBeamId: 'finance@northwind.beam.directory',
      intentType: 'conversation.message',
      stage: 'received',
      timestamp: '2026-03-30T20:15:30.000Z',
      details: { channel: 'websocket' },
    })
    setIntentLifecycleStatus(db, { nonce: proofNonce, status: 'validated' })
    appendIntentTraceEvent(db, {
      nonce: proofNonce,
      fromBeamId: 'procurement@acme.beam.directory',
      toBeamId: 'finance@northwind.beam.directory',
      intentType: 'conversation.message',
      stage: 'validated',
      timestamp: '2026-03-30T20:15:31.000Z',
      details: { signatureVerified: true },
    })
    setIntentLifecycleStatus(db, { nonce: proofNonce, status: 'queued' })
    appendIntentTraceEvent(db, {
      nonce: proofNonce,
      fromBeamId: 'procurement@acme.beam.directory',
      toBeamId: 'finance@northwind.beam.directory',
      intentType: 'conversation.message',
      stage: 'queued',
      timestamp: '2026-03-30T20:15:32.000Z',
      details: { queue: 'default' },
    })
    setIntentLifecycleStatus(db, { nonce: proofNonce, status: 'dispatched' })
    appendIntentTraceEvent(db, {
      nonce: proofNonce,
      fromBeamId: 'procurement@acme.beam.directory',
      toBeamId: 'finance@northwind.beam.directory',
      intentType: 'conversation.message',
      stage: 'dispatched',
      timestamp: '2026-03-30T20:15:33.000Z',
      details: { transport: 'direct-http' },
    })
    setIntentLifecycleStatus(db, { nonce: proofNonce, status: 'delivered' })
    appendIntentTraceEvent(db, {
      nonce: proofNonce,
      fromBeamId: 'procurement@acme.beam.directory',
      toBeamId: 'finance@northwind.beam.directory',
      intentType: 'conversation.message',
      stage: 'delivered',
      timestamp: '2026-03-30T20:15:34.000Z',
      details: { route: 'direct-http' },
    })
    finalizeIntentLog(db, {
      nonce: proofNonce,
      fromBeamId: 'procurement@acme.beam.directory',
      toBeamId: 'finance@northwind.beam.directory',
      status: 'acked',
      latencyMs: 220,
      resultJson: JSON.stringify({ success: true }),
    })
    appendIntentTraceEvent(db, {
      nonce: proofNonce,
      fromBeamId: 'procurement@acme.beam.directory',
      toBeamId: 'finance@northwind.beam.directory',
      intentType: 'conversation.message',
      stage: 'acked',
      timestamp: '2026-03-30T20:15:35.000Z',
      details: { route: 'direct-http' },
    })

    const contactTimestamp = '2026-03-30T20:15:00.000Z'
    const meetingTimestamp = '2026-04-02T14:00:00.000Z'
    const reminderTimestamp = '2026-03-30T21:00:00.000Z'
    const contactResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${created.request.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'operator@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'scheduled',
        nextAction: 'Schedule a 30 minute pilot review with procurement and finance.',
        lastContactAt: contactTimestamp,
        nextMeetingAt: meetingTimestamp,
        reminderAt: reminderTimestamp,
        proofIntentNonce: proofNonce,
      }),
    }))
    assert.equal(contactResponse.status, 200)

    const contacted = await contactResponse.json() as {
      ok: boolean
      request: {
        requestStatus: string
        nextAction: string
        lastContactAt: string | null
        nextMeetingAt: string | null
        reminderAt: string | null
        proofIntentNonce: string | null
        notificationStatus: string
        attentionFlags: string[]
      }
    }
    assert.equal(contacted.ok, true)
    assert.equal(contacted.request.requestStatus, 'scheduled')
    assert.equal(contacted.request.nextAction, 'Schedule a 30 minute pilot review with procurement and finance.')
    assert.equal(contacted.request.lastContactAt, contactTimestamp)
    assert.equal(contacted.request.nextMeetingAt, meetingTimestamp)
    assert.equal(contacted.request.reminderAt, reminderTimestamp)
    assert.equal(contacted.request.proofIntentNonce, proofNonce)
    assert.equal(contacted.request.notificationStatus, 'acted')
    assert.deepEqual(contacted.request.attentionFlags, ['follow_up_due'])

    const detailResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${created.request.id}`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(detailResponse.status, 200)

    const detail = await detailResponse.json() as {
      request: {
        id: number
        stage: string
        proofIntentNonce: string | null
        notificationStatus: string | null
      }
      activity: Array<{
        title: string
        kind: string
        href: string | null
      }>
      proofSummary: {
        headline: string
        recommendation: string
        markdown: string
        identity: {
          sender: {
            beamId: string
            verificationTier: string
          }
          recipient: {
            beamId: string
            verificationTier: string
          }
        }
        delivery: {
          status: string
          latencyMs: number | null
          stages: string[]
          routeLabel: string | null
        }
        operatorVisibility: {
          signalStatus: string
          traceHref: string
          signalHref: string | null
        }
      } | null
    }
    assert.equal(detail.request.id, created.request.id)
    assert.equal(detail.request.stage, 'scheduled')
    assert.equal(detail.request.proofIntentNonce, proofNonce)
    assert.equal(detail.request.notificationStatus, 'acted')
    assert.ok(detail.activity.length >= 6)
    assert.ok(detail.activity.some((entry) => entry.title === 'Hosted beta request captured'))
    assert.ok(detail.activity.some((entry) => entry.title === 'Stage moved to Scheduled'))
    assert.ok(detail.activity.some((entry) => entry.title === 'Last contact recorded'))
    assert.ok(detail.activity.some((entry) => entry.title === 'Next meeting is scheduled'))
    assert.ok(detail.activity.some((entry) => entry.title === 'Follow-up reminder is due'))
    assert.ok(detail.activity.some((entry) => entry.title === 'Operator signal marked acted'))
    assert.ok(detail.activity.some((entry) => entry.href === `/inbox?id=${created.request.notificationId}`))
    assert.ok(detail.proofSummary)
    assert.match(detail.proofSummary?.headline ?? '', /pilot handoff .* acknowledged/i)
    assert.equal(detail.proofSummary?.identity.sender.beamId, 'procurement@acme.beam.directory')
    assert.equal(detail.proofSummary?.identity.sender.verificationTier, 'business')
    assert.equal(detail.proofSummary?.identity.recipient.beamId, 'finance@northwind.beam.directory')
    assert.equal(detail.proofSummary?.identity.recipient.verificationTier, 'verified')
    assert.equal(detail.proofSummary?.delivery.status, 'acked')
    assert.equal(detail.proofSummary?.delivery.latencyMs, 220)
    assert.deepEqual(detail.proofSummary?.delivery.stages, ['received', 'validated', 'queued', 'dispatched', 'delivered', 'acked'])
    assert.equal(detail.proofSummary?.delivery.routeLabel, 'direct-http')
    assert.equal(detail.proofSummary?.operatorVisibility.signalStatus, 'acted')
    assert.equal(detail.proofSummary?.operatorVisibility.traceHref, `/intents/${proofNonce}`)
    assert.equal(detail.proofSummary?.operatorVisibility.signalHref, `/inbox?id=${created.request.notificationId}`)
    assert.match(detail.proofSummary?.recommendation ?? '', /pilot review/i)
    assert.match(detail.proofSummary?.markdown ?? '', /Beam pilot proof summary/)

    const dueResponse = await app.request(new Request('http://localhost/admin/beta-requests?attention=follow_up_due&status=scheduled', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(dueResponse.status, 200)

    const duePayload = await dueResponse.json() as {
      total: number
      summary: {
        followUpDue: number
      }
      requests: Array<{
        id: number
        followUpDue: boolean
        followUpReason: string | null
        stageAgeHours: number
      }>
    }
    assert.equal(duePayload.total, 1)
    assert.equal(duePayload.summary.followUpDue, 1)
    assert.equal(duePayload.requests[0]?.id, created.request.id)
    assert.equal(duePayload.requests[0]?.followUpDue, true)
    assert.match(duePayload.requests[0]?.followUpReason ?? '', /reminder/i)
    assert.ok((duePayload.requests[0]?.stageAgeHours ?? 0) >= 0)

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
    assert.match(csv, /next_meeting_at/)
    assert.match(csv, /reminder_at/)
    assert.match(csv, /follow_up_due/)
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
