import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { createAdminSession } from './admin-auth.js'
import { createAcl } from './acl.js'
import { signPayload } from './crypto.js'
import { assignDirectoryRole, createDatabase } from './db.js'
import { getLocalDirectoryUrl } from './federation.js'
import { createApp } from './server.js'

function keypair() {
  const keys = generateKeyPairSync('ed25519')
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey,
  }
}

function signIntent(privateKey: KeyObject, frame: {
  from: string
  to: string
  intent: string
  payload: Record<string, unknown>
  timestamp: string
  nonce: string
}): string {
  const payload = JSON.stringify({
    type: 'intent',
    from: frame.from,
    to: frame.to,
    intent: frame.intent,
    payload: frame.payload,
    timestamp: frame.timestamp,
    nonce: frame.nonce,
  })
  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')
}

async function verifiedOrg(app: ReturnType<typeof createApp>, db: ReturnType<typeof createDatabase>, forwardedFor: string) {
  const response = await app.request(new Request('http://localhost/orgs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
    body: JSON.stringify({ name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }),
  }))
  assert.equal(response.status, 201)
  const body = await response.json() as { apiKey: string }
  db.prepare('UPDATE orgs SET verified = 1, claim_expires_at = NULL WHERE name = ?').run('coppen')
  return body.apiKey
}

test('an intent over the mandate limit is held for approval and not delivered', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const apiKey = await verifiedOrg(app, db, '203.0.113.81')
    const personKey = keypair()
    const personResponse = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        email: 'clara@coppen.de',
        displayName: 'Clara',
        role: 'Einkauf',
        publicKey: personKey.publicKey,
        rights: { actions: ['order'], order: { maxAmount: '100.00', currency: 'EUR' } },
      }),
    }))
    assert.equal(personResponse.status, 201)
    const personId = (await personResponse.json() as { person: { id: string } }).person.id
    const buyerKey = keypair()
    const vendorKey = keypair()
    const buyer = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'buyer', publicKey: buyerKey.publicKey, responsiblePersonId: personId }),
    }))
    const vendor = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'vendor', publicKey: vendorKey.publicKey }),
    }))
    assert.equal(buyer.status, 201)
    assert.equal(vendor.status, 201)
    const buyerId = (await buyer.json() as { beamId: string }).beamId
    const vendorId = (await vendor.json() as { beamId: string }).beamId
    const mandate = {
      type: 'mandate' as const,
      jti: 'mandate-order-100',
      version: 1 as const,
      personId,
      agentBeamId: buyerId,
      org: 'coppen',
      scopes: { actions: ['order'], order: { maxAmount: '100.00', currency: 'EUR' } },
      expiresAt: '2027-04-01T00:00:00.000Z',
      escalationPersonId: null,
    }
    const signedMandate = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(buyerId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: mandate.jti,
        scopes: mandate.scopes,
        expiresAt: mandate.expiresAt,
        escalationPersonId: null,
        signature: signPayload(mandate, personKey.privateKey),
      }),
    }))
    assert.equal(signedMandate.status, 201)
    createAcl(db, { targetBeamId: vendorId, intentType: 'order.place', allowedFrom: '*' })

    const nonce = `order-${randomBytes(12).toString('hex')}`
    const timestamp = new Date().toISOString()
    const payload = { amount: '250.00', currency: 'EUR', reference: 'po-9' }
    const sent = await app.request(new Request('http://localhost/intents/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: buyerId,
        to: vendorId,
        intent: 'order.place',
        payload,
        nonce,
        timestamp,
        signature: signIntent(buyerKey.privateKey, { from: buyerId, to: vendorId, intent: 'order.place', payload, timestamp, nonce }),
      }),
    }))
    assert.equal(sent.status, 202)
    const body = await sent.json() as { errorCode: string; executed: boolean; approvalId: string }
    assert.equal(body.errorCode, 'APPROVAL_REQUIRED')
    assert.equal(body.executed, false)
    const approval = db.prepare('SELECT status, reason FROM intent_approvals WHERE id = ?').get(body.approvalId) as { status: string; reason: string }
    assert.equal(approval.status, 'pending')
    assert.equal(approval.reason, 'order limit exceeded')
    const delivered = db.prepare(`SELECT COUNT(*) AS count FROM intent_log WHERE nonce = ?`).get(nonce) as { count: number }
    assert.equal(delivered.count, 0)
  } finally {
    db.close()
  }
})

test('an unknown sender is queued for the responsible person and not the agent', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const apiKey = await verifiedOrg(app, db, '203.0.113.82')
    const personKey = keypair()
    const personResponse = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        email: 'clara@coppen.de',
        displayName: 'Clara',
        role: 'Einkauf',
        publicKey: personKey.publicKey,
      }),
    }))
    const personId = (await personResponse.json() as { person: { id: string } }).person.id
    const senderKey = keypair()
    const recipientKey = keypair()
    const senderResponse = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'sender', publicKey: senderKey.publicKey }),
    }))
    const recipientResponse = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'inbox', publicKey: recipientKey.publicKey, responsiblePersonId: personId }),
    }))
    const sender = await senderResponse.json() as { beamId: string; apiKey: string }
    const recipient = await recipientResponse.json() as { beamId: string; apiKey: string }
    const timestamp = new Date().toISOString()
    const nonce = randomBytes(16).toString('base64url')
    const proof = {
      type: 'network.connection.request' as const,
      requesterBeamId: sender.beamId,
      recipientBeamId: recipient.beamId,
      message: 'Bitte um Kontakt',
      timestamp,
      nonce,
    }
    const requested = await app.request(new Request('http://localhost/network/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': sender.apiKey },
      body: JSON.stringify({
        recipientBeamId: recipient.beamId,
        message: proof.message,
        timestamp,
        nonce,
        signature: signPayload(proof, senderKey.privateKey),
      }),
    }))
    assert.equal(requested.status, 201)

    const inbox = await app.request(new Request('http://localhost/network/connections', {
      headers: { 'x-api-key': recipient.apiKey },
    }))
    assert.equal(inbox.status, 200)
    assert.equal((await inbox.json() as { total: number }).total, 0)

    const held = await app.request(new Request(`http://localhost/orgs/coppen/people/${personId}/contact-requests`, {
      headers: { 'x-api-key': apiKey },
    }))
    assert.equal(held.status, 200)
    const requests = await held.json() as { total: number; requests: Array<{ requesterBeamId: string }> }
    assert.equal(requests.total, 1)
    assert.equal(requests.requests[0]?.requesterBeamId, sender.beamId)
  } finally {
    db.close()
  }
})

test('a suspended organization can no longer send', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'injection-test-secret'
    assignDirectoryRole(db, {
      userId: 'reviewer@beam.directory',
      role: 'operator',
      directoryUrl: getLocalDirectoryUrl(),
    })
    const app = createApp(db)
    const apiKey = await verifiedOrg(app, db, '203.0.113.83')
    const agentKey = keypair()
    const created = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'buyer', publicKey: agentKey.publicKey }),
    }))
    assert.equal(created.status, 201)
    const beamId = (await created.json() as { beamId: string }).beamId
    const session = createAdminSession(db, { email: 'reviewer@beam.directory', role: 'operator' })
    const suspended = await app.request(new Request('http://localhost/admin/orgs/coppen/suspension', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ note: 'Injection-Meldungen gegen die Organisation.' }),
    }))
    assert.equal(suspended.status, 200)

    const nonce = `ping-${randomBytes(8).toString('hex')}`
    const timestamp = new Date().toISOString()
    const payload = { message: 'ping' }
    const sent = await app.request(new Request('http://localhost/intents/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: beamId,
        to: 'vendor@coppen.beam.directory',
        intent: 'agent.ping',
        payload,
        nonce,
        timestamp,
        signature: signIntent(agentKey.privateKey, {
          from: beamId,
          to: 'vendor@coppen.beam.directory',
          intent: 'agent.ping',
          payload,
          timestamp,
          nonce,
        }),
      }),
    }))
    assert.equal(sent.status, 403)
    assert.equal((await sent.json() as { errorCode: string }).errorCode, 'ORG_SUSPENDED')
    const delivered = db.prepare('SELECT COUNT(*) AS count FROM intent_log WHERE from_beam_id = ?').get(beamId) as { count: number }
    assert.equal(delivered.count, 0)
  } finally {
    db.close()
  }
})
