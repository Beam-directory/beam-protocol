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
    const payload = await response.json() as { alerts: Array<{ id: string }> }

    assert.ok(payload.alerts.some((alert) => alert.id === 'network-error-rate'))
    assert.ok(payload.alerts.some((alert) => alert.id === 'error-hotspot-timeout'))
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
      body: JSON.stringify({ dataset: 'intents', olderThanDays: 30 }),
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
      body: JSON.stringify({ dataset: 'intents', olderThanDays: 30 }),
    }))

    assert.equal(response.status, 403)
    const payload = await response.json() as { errorCode: string }
    assert.equal(payload.errorCode, 'FORBIDDEN')
  } finally {
    db.close()
  }
})
