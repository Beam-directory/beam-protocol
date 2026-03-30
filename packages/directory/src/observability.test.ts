import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createAdminSession } from './admin-auth.js'
import { createApp } from './server.js'
import {
  appendIntentTraceEvent,
  assignDirectoryRole,
  createDatabase,
  finalizeIntentLog,
  logAuditEvent,
  logIntentStart,
  registerAgent,
  setIntentLifecycleStatus,
} from './db.js'
import { getLocalDirectoryUrl } from './federation.js'
import { logShieldEvent } from './shield/audit.js'
import { recordIntentStage } from './observability-hooks.js'
import type { IntentFrame } from './types.js'

function createAdminHeaders(db: ReturnType<typeof createDatabase>, email = 'ops@example.com', role: 'admin' | 'operator' | 'viewer' = 'admin') {
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

function registerFixtureAgents(db: ReturnType<typeof createDatabase>) {
  const senderKeys = generateKeyPairSync('ed25519')
  const receiverKeys = generateKeyPairSync('ed25519')

  registerAgent(db, {
    beamId: 'sender@local.beam.directory',
    displayName: 'Sender',
    capabilities: ['demo.intent'],
    publicKey: (senderKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
    org: 'local',
  })

  registerAgent(db, {
    beamId: 'receiver@local.beam.directory',
    displayName: 'Receiver',
    capabilities: ['demo.intent'],
    publicKey: (receiverKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
    org: 'local',
  })
}

function createFrame(nonce: string, timestamp = new Date().toISOString()): IntentFrame {
  return {
    v: '1',
    from: 'sender@local.beam.directory',
    to: 'receiver@local.beam.directory',
    intent: 'demo.intent',
    payload: { ok: true },
    nonce,
    timestamp,
    signature: 'signature',
  }
}

test('observability trace endpoint returns lifecycle, audit, and shield context', async () => {
  const db = createDatabase(':memory:')
  try {
    registerFixtureAgents(db)
    const frame = createFrame('trace-nonce')

    logIntentStart(db, frame)
    appendIntentTraceEvent(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      stage: 'received',
      timestamp: frame.timestamp,
    })
    appendIntentTraceEvent(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      stage: 'validated',
    })
    appendIntentTraceEvent(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      stage: 'dispatched',
    })
    appendIntentTraceEvent(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      stage: 'delivered',
    })
    appendIntentTraceEvent(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      stage: 'acked',
    })
    setIntentLifecycleStatus(db, { nonce: frame.nonce, status: 'validated' })
    setIntentLifecycleStatus(db, { nonce: frame.nonce, status: 'dispatched' })
    setIntentLifecycleStatus(db, { nonce: frame.nonce, status: 'delivered' })
    finalizeIntentLog(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      status: 'acked',
      latencyMs: 42,
    })

    logAuditEvent(db, {
      action: 'federation.relay',
      actor: 'https://peer.example',
      target: frame.nonce,
      details: { nonce: frame.nonce, intent: frame.intent },
    })

    logShieldEvent(db, {
      nonce: frame.nonce,
      timestamp: frame.timestamp,
      senderBeamId: frame.from,
      senderTrust: 0.5,
      intentType: frame.intent,
      payloadHash: 'abc123',
      decision: 'hold',
      riskScore: 0.75,
      responseSize: 128,
      anomalyFlags: ['rapid_sender_rate'],
    })

    const app = createApp(db)
    const response = await app.request(new Request(`http://localhost/observability/intents/${encodeURIComponent(frame.nonce)}`, {
      headers: createAdminHeaders(db),
    }))

    assert.equal(response.status, 200)
    const payload = await response.json() as {
      intent: { nonce: string }
      stages: Array<{ stage: string }>
      audit: Array<{ action: string }>
      shield: Array<{ decision: string }>
    }

    assert.equal(payload.intent.nonce, frame.nonce)
    assert.deepEqual(payload.stages.map((stage) => stage.stage), ['received', 'validated', 'dispatched', 'delivered', 'acked'])
    assert.equal(payload.audit[0]?.action, 'federation.relay')
    assert.equal(payload.shield[0]?.decision, 'hold')
  } finally {
    db.close()
  }
})

test('alerts endpoint surfaces elevated error rate and error hotspots', async () => {
  const db = createDatabase(':memory:')
  try {
    registerFixtureAgents(db)

    for (let index = 0; index < 10; index += 1) {
      const frame = createFrame(`error-${index}`)
      logIntentStart(db, frame)
      finalizeIntentLog(db, {
        nonce: frame.nonce,
        fromBeamId: frame.from,
        toBeamId: frame.to,
        status: 'failed',
        latencyMs: 3200,
        errorCode: 'TIMEOUT',
      })
    }

    const app = createApp(db)
    const response = await app.request(new Request('http://localhost/observability/alerts?hours=24', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))

    assert.equal(response.status, 200)
    const payload = await response.json() as {
      alerts: Array<{
        id: string
        thresholdExplanation: string
        links: Array<{ href: string }>
        sampleTraces: Array<{ nonce: string }>
        notificationId?: number | null
        notificationStatus?: string | null
      }>
    }

    const errorRateAlert = payload.alerts.find((alert) => alert.id === 'network-error-rate')
    const hotspotAlert = payload.alerts.find((alert) => alert.id === 'error-hotspot-timeout')

    assert.ok(errorRateAlert)
    if (!errorRateAlert) {
      throw new Error('Expected network-error-rate alert to exist')
    }
    assert.match(errorRateAlert.thresholdExplanation, /10%/)
    assert.ok(errorRateAlert.links.some((link) => link.href.includes('/intents?')))
    assert.equal(errorRateAlert.sampleTraces[0]?.nonce, 'error-9')
    assert.ok((errorRateAlert.notificationId ?? 0) > 0)
    assert.equal(errorRateAlert.notificationStatus, 'new')

    assert.ok(hotspotAlert)
    if (!hotspotAlert) {
      throw new Error('Expected error-hotspot-timeout alert to exist')
    }
    assert.ok(hotspotAlert.links.some((link) => link.href.includes('/audit?')))
    assert.ok((hotspotAlert.notificationId ?? 0) > 0)
    assert.equal(hotspotAlert.notificationStatus, 'new')

    const inboxResponse = await app.request(new Request('http://localhost/admin/operator-notifications?source=critical_alert&status=new', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(inboxResponse.status, 200)

    const inbox = await inboxResponse.json() as {
      total: number
      notifications: Array<{
        id: number
        alertId: string | null
        status: string
      }>
      summary: {
        byStatus: Record<string, number>
        bySource: Record<string, number>
      }
    }
    assert.equal(inbox.total, 2)
    assert.equal(inbox.summary.byStatus['new'], 2)
    assert.equal(inbox.summary.bySource['critical_alert'], 2)

    const errorRateNotification = inbox.notifications.find((entry) => entry.alertId === 'network-error-rate')
    const hotspotNotification = inbox.notifications.find((entry) => entry.alertId === 'error-hotspot-timeout')
    assert.ok(errorRateNotification)
    assert.ok(hotspotNotification)

    const acknowledgeResponse = await app.request(new Request(`http://localhost/admin/operator-notifications/${errorRateNotification?.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'operator@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'acknowledged' }),
    }))
    assert.equal(acknowledgeResponse.status, 200)

    const actedResponse = await app.request(new Request(`http://localhost/admin/operator-notifications/${hotspotNotification?.id}`, {
      method: 'PATCH',
      headers: {
        ...createAdminHeaders(db, 'operator@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'acted' }),
    }))
    assert.equal(actedResponse.status, 200)

    const inboxAfterUpdateResponse = await app.request(new Request('http://localhost/admin/operator-notifications?source=critical_alert', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(inboxAfterUpdateResponse.status, 200)
    const inboxAfterUpdate = await inboxAfterUpdateResponse.json() as {
      summary: {
        byStatus: Record<string, number>
      }
      notifications: Array<{
        alertId: string | null
        status: string
      }>
    }
    assert.equal(inboxAfterUpdate.summary.byStatus['acknowledged'], 1)
    assert.equal(inboxAfterUpdate.summary.byStatus['acted'], 1)
    assert.equal(inboxAfterUpdate.notifications.find((entry) => entry.alertId === 'network-error-rate')?.status, 'acknowledged')
    assert.equal(inboxAfterUpdate.notifications.find((entry) => entry.alertId === 'error-hotspot-timeout')?.status, 'acted')

    const refreshedAlertsResponse = await app.request(new Request('http://localhost/observability/alerts?hours=24', {
      headers: createAdminHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(refreshedAlertsResponse.status, 200)
    const refreshedAlerts = await refreshedAlertsResponse.json() as {
      alerts: Array<{
        id: string
        notificationStatus?: string | null
      }>
    }
    assert.equal(refreshedAlerts.alerts.find((alert) => alert.id === 'network-error-rate')?.notificationStatus, 'acknowledged')
    assert.equal(refreshedAlerts.alerts.find((alert) => alert.id === 'error-hotspot-timeout')?.notificationStatus, 'acted')
  } finally {
    db.close()
  }
})

test('prune preview returns dataset impact before destructive action', async () => {
  const db = createDatabase(':memory:')
  try {
    registerFixtureAgents(db)
    const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const frame = createFrame('preview-intent', oldTimestamp)

    logIntentStart(db, frame)
    appendIntentTraceEvent(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      stage: 'received',
      timestamp: oldTimestamp,
    })

    const app = createApp(db)
    const response = await app.request(new Request('http://localhost/observability/prune-preview?dataset=intents&olderThanDays=30', {
      headers: createAdminHeaders(db),
    }))

    assert.equal(response.status, 200)
    const payload = await response.json() as { wouldDelete: number; intents: number; traces: number }
    assert.equal(payload.intents, 1)
    assert.equal(payload.traces, 1)
    assert.equal(payload.wouldDelete, 2)
  } finally {
    db.close()
  }
})

test('prune endpoint removes aged intents and trace records', async () => {
  const db = createDatabase(':memory:')
  try {
    registerFixtureAgents(db)
    const oldTimestamp = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const frame = createFrame('old-intent', oldTimestamp)

    logIntentStart(db, frame)
    appendIntentTraceEvent(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      stage: 'received',
      timestamp: oldTimestamp,
    })

    const app = createApp(db)
    const response = await app.request(new Request('http://localhost/observability/prune', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...createAdminHeaders(db),
      },
      body: JSON.stringify({
        dataset: 'intents',
        olderThanDays: 30,
        confirmDataset: 'intents',
        confirmPhrase: 'prune intents',
      }),
    }))

    assert.equal(response.status, 200)
    const payload = await response.json() as { deleted: number; intents: number; traces: number }
    assert.equal(payload.intents, 1)
    assert.equal(payload.traces, 1)
    assert.equal(payload.deleted, 2)

    const remainingIntents = db.prepare('SELECT COUNT(*) AS count FROM intent_log').get() as { count: number }
    const remainingTraces = db.prepare('SELECT COUNT(*) AS count FROM intent_trace_events').get() as { count: number }
    assert.equal(remainingIntents.count, 0)
    assert.equal(remainingTraces.count, 0)
  } finally {
    db.close()
  }
})

test('recordIntentStage rejects out-of-order lifecycle stages', () => {
  const db = createDatabase(':memory:')
  try {
    registerFixtureAgents(db)
    const frame = createFrame('invalid-order')

    recordIntentStage(db, frame, 'received', undefined, frame.timestamp)
    recordIntentStage(db, frame, 'validated')
    recordIntentStage(db, frame, 'dispatched')
    recordIntentStage(db, frame, 'delivered')

    assert.throws(
      () => recordIntentStage(db, frame, 'validated'),
      /Invalid trace invalid-order transition from delivered to validated/,
    )
  } finally {
    db.close()
  }
})

test('prune endpoint rejects read-only sessions', async () => {
  const db = createDatabase(':memory:')
  try {
    registerFixtureAgents(db)
    const app = createApp(db)
    const response = await app.request(new Request('http://localhost/observability/prune', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...createAdminHeaders(db, 'viewer@example.com', 'viewer'),
      },
      body: JSON.stringify({
        dataset: 'intents',
        olderThanDays: 30,
        confirmDataset: 'intents',
        confirmPhrase: 'prune intents',
      }),
    }))

    assert.equal(response.status, 403)
    const payload = await response.json() as { errorCode: string }
    assert.equal(payload.errorCode, 'FORBIDDEN')
  } finally {
    db.close()
  }
})

test('prune endpoint rejects missing confirmation phrase', async () => {
  const db = createDatabase(':memory:')
  try {
    registerFixtureAgents(db)
    const app = createApp(db)
    const response = await app.request(new Request('http://localhost/observability/prune', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...createAdminHeaders(db),
      },
      body: JSON.stringify({
        dataset: 'intents',
        olderThanDays: 30,
        confirmDataset: 'intents',
        confirmPhrase: 'delete intents',
      }),
    }))

    assert.equal(response.status, 400)
    const payload = await response.json() as { errorCode: string }
    assert.equal(payload.errorCode, 'PRUNE_CONFIRMATION_REQUIRED')
  } finally {
    db.close()
  }
})
