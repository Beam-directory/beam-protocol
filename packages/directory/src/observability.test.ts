import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createApp } from './server.js'
import {
  appendIntentTraceEvent,
  createDatabase,
  finalizeIntentLog,
  logAuditEvent,
  logIntentStart,
  registerAgent,
} from './db.js'
import { logShieldEvent } from './shield/audit.js'
import type { IntentFrame } from './types.js'

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
  const previousAdminKey = process.env['BEAM_ADMIN_KEY']
  process.env['BEAM_ADMIN_KEY'] = 'test-admin'

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
      status: 'pending',
      timestamp: frame.timestamp,
    })
    appendIntentTraceEvent(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      stage: 'validated',
      status: 'success',
    })
    appendIntentTraceEvent(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      intentType: frame.intent,
      stage: 'completed',
      status: 'success',
    })
    finalizeIntentLog(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      success: true,
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
      headers: { 'x-admin-key': 'test-admin' },
    }))

    assert.equal(response.status, 200)
    const payload = await response.json() as {
      intent: { nonce: string }
      stages: Array<{ stage: string }>
      audit: Array<{ action: string }>
      shield: Array<{ decision: string }>
    }

    assert.equal(payload.intent.nonce, frame.nonce)
    assert.deepEqual(payload.stages.map((stage) => stage.stage), ['received', 'validated', 'completed'])
    assert.equal(payload.audit[0]?.action, 'federation.relay')
    assert.equal(payload.shield[0]?.decision, 'hold')
  } finally {
    process.env['BEAM_ADMIN_KEY'] = previousAdminKey
    db.close()
  }
})

test('alerts endpoint surfaces elevated error rate and error hotspots', async () => {
  const previousAdminKey = process.env['BEAM_ADMIN_KEY']
  process.env['BEAM_ADMIN_KEY'] = 'test-admin'

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
        success: false,
        latencyMs: 3200,
        errorCode: 'TIMEOUT',
      })
    }

    const app = createApp(db)
    const response = await app.request(new Request('http://localhost/observability/alerts?hours=24', {
      headers: { 'x-admin-key': 'test-admin' },
    }))

    assert.equal(response.status, 200)
    const payload = await response.json() as { alerts: Array<{ id: string }> }

    assert.ok(payload.alerts.some((alert) => alert.id === 'network-error-rate'))
    assert.ok(payload.alerts.some((alert) => alert.id === 'error-hotspot-timeout'))
  } finally {
    process.env['BEAM_ADMIN_KEY'] = previousAdminKey
    db.close()
  }
})

test('prune endpoint removes aged intents and trace records', async () => {
  const previousAdminKey = process.env['BEAM_ADMIN_KEY']
  process.env['BEAM_ADMIN_KEY'] = 'test-admin'

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
      status: 'pending',
      timestamp: oldTimestamp,
    })

    const app = createApp(db)
    const response = await app.request(new Request('http://localhost/observability/prune', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-key': 'test-admin',
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
    process.env['BEAM_ADMIN_KEY'] = previousAdminKey
    db.close()
  }
})
