import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminSession } from './admin-auth.js'
import { createApp } from './server.js'
import {
  appendIntentTraceEvent,
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

async function createHostedBetaRequest(
  app: ReturnType<typeof createApp>,
  email: string,
  company: string,
) {
  const response = await app.request(new Request('http://localhost/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      source: 'hosted-beta-page',
      company,
      agentCount: 6,
      workflowType: 'hosted-beta-partner-handoff',
      workflowSummary: 'Route purchase approvals from Acme procurement to Northwind finance with signed proof.',
    }),
  }))

  assert.equal(response.status, 201)
  return response.json() as Promise<{
    ok: boolean
    request: {
      id: number
      notificationId: number | null
    }
  }>
}

function registerProofAgents(db: ReturnType<typeof createDatabase>) {
  registerAgent(db, {
    beamId: 'procurement@acme.beam.directory',
    displayName: 'Acme Procurement',
    capabilities: ['conversation.message'],
    publicKey: 'MCowBQYDK2VwAyEAEHzHjWwTn/RZiC407+hCtk8nde/GEVUn85iOaZBH2Bw=',
    verificationTier: 'business',
    email: 'procurement@acme.example',
    emailVerified: true,
  })
  registerAgent(db, {
    beamId: 'finance@northwind.beam.directory',
    displayName: 'Northwind Finance',
    capabilities: ['conversation.message'],
    publicKey: 'MCowBQYDK2VwAyEAr+N7jwgoTnwP/02HeC88JezBI3D/FbtcWbhOOyUpM8Y=',
    verificationTier: 'verified',
    email: 'finance@northwind.example',
    emailVerified: true,
  })
}

function seedFailedIntent(
  db: ReturnType<typeof createDatabase>,
  nonce: string,
  timestamp: string,
  latencyMs = 6_200,
) {
  logIntentStart(db, {
    v: '1',
    nonce,
    from: 'procurement@acme.beam.directory',
    to: 'finance@northwind.beam.directory',
    intent: 'conversation.message',
    payload: { message: 'Approve purchase order 1042.' },
    timestamp,
  })
  appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'received',
    timestamp,
  })
  setIntentLifecycleStatus(db, { nonce, status: 'validated' })
  appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'validated',
    timestamp,
  })
  finalizeIntentLog(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    status: 'failed',
    latencyMs,
    errorCode: 'TIMEOUT',
    resultJson: JSON.stringify({ success: false, error: 'Timed out waiting for partner approval.' }),
  })
}

function seedAckedIntent(
  db: ReturnType<typeof createDatabase>,
  nonce: string,
  timestamp: string,
) {
  logIntentStart(db, {
    v: '1',
    nonce,
    from: 'procurement@acme.beam.directory',
    to: 'finance@northwind.beam.directory',
    intent: 'conversation.message',
    payload: { message: 'Can you approve the async quote?' },
    timestamp,
  })
  appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'received',
    timestamp,
    details: { channel: 'websocket' },
  })
  setIntentLifecycleStatus(db, { nonce, status: 'validated' })
  appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'validated',
    timestamp: '2026-03-31T10:15:31.000Z',
    details: { signatureVerified: true },
  })
  setIntentLifecycleStatus(db, { nonce, status: 'queued' })
  appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'queued',
    timestamp: '2026-03-31T10:15:32.000Z',
    details: { queue: 'default' },
  })
  setIntentLifecycleStatus(db, { nonce, status: 'dispatched' })
  appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'dispatched',
    timestamp: '2026-03-31T10:15:33.000Z',
    details: { transport: 'direct-http' },
  })
  setIntentLifecycleStatus(db, { nonce, status: 'delivered' })
  appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'delivered',
    timestamp: '2026-03-31T10:15:34.000Z',
    details: { route: 'direct-http' },
  })
  finalizeIntentLog(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    status: 'acked',
    latencyMs: 220,
    resultJson: JSON.stringify({ success: true }),
  })
  appendIntentTraceEvent(db, {
    nonce,
    fromBeamId: 'procurement@acme.beam.directory',
    toBeamId: 'finance@northwind.beam.directory',
    intentType: 'conversation.message',
    stage: 'acked',
    timestamp: '2026-03-31T10:15:35.000Z',
    details: { route: 'direct-http' },
  })
}

test('partner health and alerts attribute incidents back to the affected partner request', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    const app = createApp(db)
    registerProofAgents(db)

    const created = await createHostedBetaRequest(app, 'buyer@example.com', 'Northwind Systems')

    for (let index = 0; index < 10; index += 1) {
      seedFailedIntent(db, `partner-proof-${index}`, `2026-03-31T09:${String(index).padStart(2, '0')}:00.000Z`)
    }

    const patchResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${created.request.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'ops@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'active',
        owner: 'ops@example.com',
        nextAction: 'Escalate the failing partner approval route before go-live.',
        lastContactAt: '2026-03-30T08:30:00.000Z',
        reminderAt: '2026-03-31T08:00:00.000Z',
        proofIntentNonce: 'partner-proof-9',
      }),
    }))
    assert.equal(patchResponse.status, 200)

    const alertsResponse = await app.request(new Request('http://localhost/observability/alerts?hours=24', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(alertsResponse.status, 200)
    const alertsPayload = await alertsResponse.json() as {
      alerts: Array<{
        id: string
        relatedPartnerRequests?: Array<{
          id: number
          company: string | null
          stage: string
          href: string
        }>
      }>
    }

    const errorRateAlert = alertsPayload.alerts.find((entry) => entry.id === 'network-error-rate')
    assert.ok(errorRateAlert)
    assert.equal(errorRateAlert?.relatedPartnerRequests?.[0]?.id, created.request.id)
    assert.equal(errorRateAlert?.relatedPartnerRequests?.[0]?.href, `/beta-requests?id=${created.request.id}`)

    const partnerHealthResponse = await app.request(new Request('http://localhost/admin/partner-health?days=30&hours=24', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(partnerHealthResponse.status, 200)
    const partnerHealth = await partnerHealthResponse.json() as {
      summary: {
        critical: number
        deadLetters: number
        latencyBreaches: number
      }
      requests: Array<{
        id: number
        company: string | null
        healthStatus: string
        latestIntentStatus: string | null
        latencyBreach: boolean
        links: {
          requestHref: string
          alertHref: string | null
        }
      }>
      incidents: Array<{
        requestId: number
        title: string
        alertHref: string | null
      }>
    }

    assert.equal(partnerHealth.summary.critical, 1)
    assert.equal(partnerHealth.summary.deadLetters, 0)
    assert.equal(partnerHealth.summary.latencyBreaches, 1)
    assert.equal(partnerHealth.requests[0]?.id, created.request.id)
    assert.equal(partnerHealth.requests[0]?.company, 'Northwind Systems')
    assert.equal(partnerHealth.requests[0]?.healthStatus, 'critical')
    assert.equal(partnerHealth.requests[0]?.latestIntentStatus, 'failed')
    assert.equal(partnerHealth.requests[0]?.latencyBreach, true)
    assert.equal(partnerHealth.requests[0]?.links.requestHref, `/beta-requests?id=${created.request.id}`)
    assert.ok(partnerHealth.requests[0]?.links.alertHref)
    assert.equal(partnerHealth.incidents[0]?.requestId, created.request.id)
    assert.match(partnerHealth.incidents[0]?.title ?? '', /latency|review|dead letter/i)
  } finally {
    db.close()
  }
})

test('proof pack and digest exports stay redaction-safe and expose a delivery path', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    delete process.env['SMTP_HOST']
    delete process.env['SMTP_PORT']
    delete process.env['SMTP_USER']
    delete process.env['SMTP_PASS']
    delete process.env['SMTP_PASSWORD']
    delete process.env['RESEND_API_KEY']

    const app = createApp(db)
    registerProofAgents(db)

    const created = await createHostedBetaRequest(app, 'buyer@example.com', 'Northwind Systems')
    const proofNonce = 'partner-proof-acked-1'
    seedAckedIntent(db, proofNonce, '2026-03-31T10:15:30.000Z')

    const patchResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${created.request.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'operator@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        status: 'scheduled',
        owner: 'operator@example.com',
        operatorNotes: 'Keep procurement and finance aligned before the pilot review.',
        nextAction: 'Schedule a 30 minute production readiness review.',
        lastContactAt: '2026-03-31T10:10:00.000Z',
        nextMeetingAt: '2026-04-03T14:00:00.000Z',
        reminderAt: '2026-04-01T09:00:00.000Z',
        proofIntentNonce: proofNonce,
      }),
    }))
    assert.equal(patchResponse.status, 200)

    const proofPackJsonResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${created.request.id}/proof-pack?format=json`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(proofPackJsonResponse.status, 200)
    assert.equal(proofPackJsonResponse.headers.get('content-type'), 'application/json; charset=utf-8')
    const proofPackText = await proofPackJsonResponse.text()
    const proofPack = JSON.parse(proofPackText) as {
      request: {
        company: string | null
        workflowSummary: string | null
      }
      proof: {
        deliveryStatus: string
        proofIntentNonce: string
        recommendation: string
      }
      redaction: {
        excludedFields: string[]
      }
    }
    assert.equal(proofPack.request.company, 'Northwind Systems')
    assert.equal(proofPack.proof.deliveryStatus, 'acked')
    assert.equal(proofPack.proof.proofIntentNonce, proofNonce)
    assert.match(proofPack.proof.recommendation, /pilot review/i)
    assert.ok(proofPack.redaction.excludedFields.includes('request email'))
    assert.ok(proofPack.redaction.excludedFields.includes('operator owner'))
    assert.ok(proofPack.redaction.excludedFields.includes('operator notes'))
    assert.doesNotMatch(proofPackText, /buyer@example\.com/i)
    assert.doesNotMatch(proofPackText, /operator@example\.com/i)

    const proofPackMarkdownResponse = await app.request(new Request(`http://localhost/admin/beta-requests/${created.request.id}/proof-pack?format=markdown`, {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(proofPackMarkdownResponse.status, 200)
    assert.equal(proofPackMarkdownResponse.headers.get('content-type'), 'text/markdown; charset=utf-8')
    const proofMarkdown = await proofPackMarkdownResponse.text()
    assert.match(proofMarkdown, /Beam partner proof pack/)
    assert.match(proofMarkdown, /Northwind Systems/)
    assert.match(proofMarkdown, /Trace reference: partner-proof-acked-1/)
    assert.doesNotMatch(proofMarkdown, /buyer@example\.com/i)
    assert.doesNotMatch(proofMarkdown, /operator@example\.com/i)

    const digestResponse = await app.request(new Request('http://localhost/admin/partner-digest?days=14', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(digestResponse.status, 200)
    const digest = await digestResponse.json() as {
      summary: {
        totalThreads: number
      }
      actionItems: Array<{
        requestId: number
        company: string | null
        href: string
      }>
      markdown: string
    }
    assert.equal(digest.summary.totalThreads, 1)
    assert.equal(digest.actionItems[0]?.requestId, created.request.id)
    assert.equal(digest.actionItems[0]?.company, 'Northwind Systems')
    assert.equal(digest.actionItems[0]?.href, `/beta-requests?id=${created.request.id}`)
    assert.match(digest.markdown, /Beam partner operator digest/)

    const deliverForbiddenResponse = await app.request(new Request('http://localhost/admin/partner-digest/deliver', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'operator@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'other-operator@example.com' }),
    }))
    assert.equal(deliverForbiddenResponse.status, 403)

    const deliverUnavailableResponse = await app.request(new Request('http://localhost/admin/partner-digest/deliver', {
      method: 'POST',
      headers: {
        ...createAdminHeaders(db, 'operator@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ days: 14 }),
    }))
    assert.equal(deliverUnavailableResponse.status, 503)
    const unavailablePayload = await deliverUnavailableResponse.json() as {
      errorCode: string
    }
    assert.equal(unavailablePayload.errorCode, 'EMAIL_DELIVERY_UNAVAILABLE')
  } finally {
    db.close()
  }
})
