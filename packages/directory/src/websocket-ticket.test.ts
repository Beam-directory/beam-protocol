import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { createAgentApiKey, hashApiKey } from './api-key.js'
import { createDatabase, registerAgent } from './db.js'
import { webSocketTicketRouter } from './routes/websocket-ticket.js'
import {
  consumeWebSocketTicket,
  issueWebSocketTicket,
  resetWebSocketTickets,
} from './websocket-ticket.js'

afterEach(() => resetWebSocketTickets())

function setup() {
  const db = createDatabase(':memory:')
  const beamId = 'receiver@acme.beam.directory'
  const apiKey = createAgentApiKey(beamId)
  const { publicKey } = generateKeyPairSync('ed25519')
  registerAgent(db, {
    beamId,
    displayName: 'Receiver',
    capabilities: ['agent.ping'],
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    apiKeyHash: hashApiKey(apiKey),
    org: 'acme',
  })
  return { db, beamId, apiKey, app: webSocketTicketRouter(db) }
}

test('agent API key issues a no-store single-use ticket without echoing the key', async () => {
  const { db, beamId, apiKey, app } = setup()
  try {
    const response = await app.request(`/${beamId}/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json() as { ticket: string; expiresInSeconds: number }
    assert.match(body.ticket, /^bwt_[A-Za-z0-9_-]+$/)
    assert.equal(body.expiresInSeconds, 30)
    assert.equal(JSON.stringify(body).includes(apiKey), false)
    assert.equal(consumeWebSocketTicket(body.ticket, beamId), true)
    assert.equal(consumeWebSocketTicket(body.ticket, beamId), false)
  } finally {
    db.close()
  }
})

test('ticket endpoint rejects a missing or mismatched agent key', async () => {
  const { db, beamId, app } = setup()
  try {
    const response = await app.request(`/${beamId}/ws-ticket`, { method: 'POST' })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  } finally {
    db.close()
  }
})

test('ticket is bound to one Beam ID and expires after 30 seconds', () => {
  const now = Date.parse('2026-08-23T08:00:00.000Z')
  const issued = issueWebSocketTicket('receiver@acme.beam.directory', now)
  assert.equal(consumeWebSocketTicket(issued.ticket, 'other@acme.beam.directory', now + 1), false)
  assert.equal(consumeWebSocketTicket(issued.ticket, 'receiver@acme.beam.directory', now + 30_001), false)
})

test('active ticket count is bounded per agent', () => {
  const beamId = 'receiver@acme.beam.directory'
  for (let index = 0; index < 5; index += 1) {
    issueWebSocketTicket(beamId)
  }
  assert.throws(() => issueWebSocketTicket(beamId), /Too many active/)
})
