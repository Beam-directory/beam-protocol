import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { createAdminSession } from './admin-auth.js'
import { createAcl } from './acl.js'
import { signPayload } from './crypto.js'
import { assignDirectoryRole, createDatabase, createDelegation, markOrgVerified } from './db.js'
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
  const body = await response.json() as { apiKey: string; name: string }
  assert.equal(markOrgVerified(db, body.name)?.name, 'coppen')
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
    db.prepare(`UPDATE persons SET kyc_status = 'verified' WHERE id = ?`).run(personId)
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

    const proof = {
      type: 'intent.approval' as const,
      approvalId: body.approvalId,
      decision: 'rejected' as const,
      personId,
      timestamp: new Date().toISOString(),
      nonce: `decide-${randomBytes(12).toString('hex')}`,
    }
    const decided = await app.request(new Request(`http://localhost/orgs/coppen/approvals/${body.approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ ...proof, signature: signPayload(proof, personKey.privateKey) }),
    }))
    assert.equal(decided.status, 200)
    assert.equal((await decided.json() as { status: string; executed: boolean }).executed, false)
    assert.equal((db.prepare('SELECT status FROM intent_approvals WHERE id = ?').get(body.approvalId) as { status: string }).status, 'rejected')
    const audit = db.prepare(`SELECT details FROM audit_log WHERE action = 'intent.approval.decided' ORDER BY id DESC LIMIT 1`).get() as { details: string }
    assert.equal(JSON.parse(audit.details).via, 'person')

    const nonce2 = `order-${randomBytes(12).toString('hex')}`
    const timestamp2 = new Date().toISOString()
    const sent2 = await app.request(new Request('http://localhost/intents/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: buyerId,
        to: vendorId,
        intent: 'order.place',
        payload,
        nonce: nonce2,
        timestamp: timestamp2,
        signature: signIntent(buyerKey.privateKey, { from: buyerId, to: vendorId, intent: 'order.place', payload, timestamp: timestamp2, nonce: nonce2 }),
      }),
    }))
    assert.equal(sent2.status, 202)
    const approval2 = (await sent2.json() as { approvalId: string }).approvalId
    const forged = await app.request(new Request(`http://localhost/orgs/coppen/approvals/${approval2}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        decision: 'rejected',
        signature: 'bm90LWEtcmVhbC1zaWduYXR1cmU',
        timestamp: new Date().toISOString(),
        nonce: `decide-${randomBytes(12).toString('hex')}`,
      }),
    }))
    assert.equal(forged.status, 400)
    const emergency = await app.request(new Request(`http://localhost/orgs/coppen/approvals/${approval2}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ decision: 'rejected' }),
    }))
    assert.equal(emergency.status, 200)
    const emergencyAudit = db.prepare(`SELECT details FROM audit_log WHERE action = 'intent.approval.decided' ORDER BY id DESC LIMIT 1`).get() as { details: string }
    assert.equal(JSON.parse(emergencyAudit.details).via, 'org-key')
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

    const lifted = await app.request(new Request('http://localhost/admin/orgs/coppen/unsuspend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ note: 'Die Meldungen sind abgearbeitet.' }),
    }))
    assert.equal(lifted.status, 200)
    assert.equal((db.prepare('SELECT suspended_at FROM orgs WHERE name = ?').get('coppen') as { suspended_at: string | null }).suspended_at, null)
    const unsuspendAudit = db.prepare(`SELECT action FROM audit_log WHERE action = 'org.unsuspended'`).get() as { action: string }
    assert.equal(unsuspendAudit.action, 'org.unsuspended')
  } finally {
    db.close()
  }
})

test('an organization whose name differs by one character cannot see or decide another org approval', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const apiKey = await verifiedOrg(app, db, '203.0.113.84')
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
    const personId = (await personResponse.json() as { person: { id: string } }).person.id
    db.prepare(`UPDATE persons SET kyc_status = 'verified' WHERE id = ?`).run(personId)
    const buyerKey = keypair()
    const buyer = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'buyer', publicKey: buyerKey.publicKey, responsiblePersonId: personId }),
    }))
    const vendor = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'vendor', publicKey: keypair().publicKey }),
    }))
    const buyerId = (await buyer.json() as { beamId: string }).beamId
    const vendorId = (await vendor.json() as { beamId: string }).beamId
    const mandate = {
      type: 'mandate' as const,
      jti: 'mandate-idor',
      version: 1 as const,
      personId,
      agentBeamId: buyerId,
      org: 'coppen',
      scopes: { actions: ['order'], order: { maxAmount: '100.00', currency: 'EUR' } },
      expiresAt: '2027-04-01T00:00:00.000Z',
      escalationPersonId: null,
    }
    assert.equal((await app.request(new Request(`http://localhost/agents/${encodeURIComponent(buyerId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: mandate.jti,
        scopes: mandate.scopes,
        expiresAt: mandate.expiresAt,
        escalationPersonId: null,
        signature: signPayload(mandate, personKey.privateKey),
      }),
    }))).status, 201)
    createAcl(db, { targetBeamId: vendorId, intentType: 'order.place', allowedFrom: '*' })
    const nonce = `order-${randomBytes(12).toString('hex')}`
    const timestamp = new Date().toISOString()
    const payload = { amount: '250.00', currency: 'EUR' }
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
    const approvalId = (await sent.json() as { approvalId: string }).approvalId
    const ownList = await app.request(new Request('http://localhost/orgs/coppen/approvals', { headers: { 'x-api-key': apiKey } }))
    assert.equal((await ownList.json() as { total: number }).total, 1)

    const other = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.85' },
      body: JSON.stringify({ name: 'c_ppen', displayName: 'Lookalike', domain: 'c-ppen.de' }),
    }))
    assert.equal(other.status, 201)
    const created = await other.json() as { apiKey: string; name: string }
    assert.notEqual(created.name, 'c_ppen')
    db.prepare('UPDATE orgs SET name = ? WHERE name = ?').run('c_ppen', created.name)
    const listed = await app.request(new Request('http://localhost/orgs/c_ppen/approvals', {
      headers: { 'x-api-key': created.apiKey },
    }))
    assert.equal(listed.status, 200)
    assert.equal((await listed.json() as { total: number }).total, 0)
    const decided = await app.request(new Request(`http://localhost/orgs/c_ppen/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': created.apiKey },
      body: JSON.stringify({ decision: 'approved' }),
    }))
    assert.equal(decided.status, 404)
    assert.equal((db.prepare('SELECT status FROM intent_approvals WHERE id = ?').get(approvalId) as { status: string }).status, 'pending')
  } finally {
    db.close()
  }
})

test('orders and payments share the mandate total for the UTC day', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const apiKey = await verifiedOrg(app, db, '203.0.113.86')
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
    const personId = (await personResponse.json() as { person: { id: string } }).person.id
    db.prepare(`UPDATE persons SET kyc_status = 'verified' WHERE id = ?`).run(personId)
    const buyerKey = keypair()
    const buyer = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'buyer', publicKey: buyerKey.publicKey, responsiblePersonId: personId }),
    }))
    const vendor = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'vendor', publicKey: keypair().publicKey }),
    }))
    const buyerId = (await buyer.json() as { beamId: string }).beamId
    const vendorId = (await vendor.json() as { beamId: string }).beamId
    const mandate = {
      type: 'mandate' as const,
      jti: 'mandate-daily',
      version: 1 as const,
      personId,
      agentBeamId: buyerId,
      org: 'coppen',
      scopes: { actions: ['order'], order: { maxAmount: '100.00', currency: 'EUR' } },
      expiresAt: '2027-04-01T00:00:00.000Z',
      escalationPersonId: null,
    }
    assert.equal((await app.request(new Request(`http://localhost/agents/${encodeURIComponent(buyerId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: mandate.jti,
        scopes: mandate.scopes,
        expiresAt: mandate.expiresAt,
        escalationPersonId: null,
        signature: signPayload(mandate, personKey.privateKey),
      }),
    }))).status, 201)
    createAcl(db, { targetBeamId: vendorId, intentType: 'order.place', allowedFrom: '*' })
    createAcl(db, { targetBeamId: vendorId, intentType: 'payment.submit', allowedFrom: '*' })

    async function sendMoney(intent: string, amount: string, to = vendorId) {
      const nonce = `money-${randomBytes(12).toString('hex')}`
      const timestamp = new Date().toISOString()
      const payload = { amount, currency: 'EUR' }
      const response = await app.request(new Request('http://localhost/intents/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: buyerId,
          to,
          intent,
          payload,
          nonce,
          timestamp,
          signature: signIntent(buyerKey.privateKey, { from: buyerId, to, intent, payload, timestamp, nonce }),
        }),
      }))
      return { response, body: await response.json() as { errorCode?: string; approvalId?: string; reason?: string; success?: boolean } }
    }

    const offline = await sendMoney('order.place', '60.00')
    assert.equal(offline.response.status, 503)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM mandate_order_spend').get() as { count: number }).count, 0)

    const delivered = await sendMoney('order.place', '60.00', 'echo@beam.directory')
    assert.equal(delivered.response.status, 200)
    const spent = db.prepare('SELECT day, amount_cents FROM mandate_order_spend').all() as Array<{ day: string; amount_cents: number }>
    assert.equal(spent.length, 1)
    assert.equal(spent[0]?.day, new Date().toISOString().slice(0, 10))
    assert.equal(spent[0]?.amount_cents, 6000)

    const second = await sendMoney('payment.submit', '50.00')
    assert.equal(second.response.status, 202)
    assert.equal(second.body.errorCode, 'APPROVAL_REQUIRED')
    const held = db.prepare('SELECT reason FROM intent_approvals WHERE id = ?').get(second.body.approvalId) as { reason: string }
    assert.equal(held.reason, 'daily order limit exceeded')
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM mandate_order_spend').get() as { count: number }).count, 1)
  } finally {
    db.close()
  }
})

test('blocking an agent revokes its mandates and delegations and can be lifted', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'injection-test-secret'
    assignDirectoryRole(db, {
      userId: 'reviewer@beam.directory',
      role: 'operator',
      directoryUrl: getLocalDirectoryUrl(),
    })
    const app = createApp(db)
    const apiKey = await verifiedOrg(app, db, '203.0.113.87')
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
    const personId = (await personResponse.json() as { person: { id: string } }).person.id
    db.prepare(`UPDATE persons SET kyc_status = 'verified' WHERE id = ?`).run(personId)
    const buyer = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'buyer', publicKey: keypair().publicKey, responsiblePersonId: personId }),
    }))
    const helper = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'helper', publicKey: keypair().publicKey }),
    }))
    const buyerId = (await buyer.json() as { beamId: string }).beamId
    const helperId = (await helper.json() as { beamId: string }).beamId
    const mandate = {
      type: 'mandate' as const,
      jti: 'mandate-block',
      version: 1 as const,
      personId,
      agentBeamId: buyerId,
      org: 'coppen',
      scopes: { actions: ['order'], order: { maxAmount: '100.00', currency: 'EUR' } },
      expiresAt: '2027-04-01T00:00:00.000Z',
      escalationPersonId: null,
    }
    assert.equal((await app.request(new Request(`http://localhost/agents/${encodeURIComponent(buyerId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: mandate.jti,
        scopes: mandate.scopes,
        expiresAt: mandate.expiresAt,
        escalationPersonId: null,
        signature: signPayload(mandate, personKey.privateKey),
      }),
    }))).status, 201)
    createDelegation(db, {
      grantorBeamId: buyerId,
      granteeBeamId: helperId,
      scope: 'order',
      expiresAt: Date.now() + 86_400_000,
      payloadHash: randomBytes(16).toString('hex'),
    })
    const reportId = 'abuse-block-agent'
    db.prepare(`
      INSERT INTO abuse_reports (
        id, reporter_beam_id, target_beam_id, intent_nonce, reason, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(reportId, helperId, buyerId, `nonce-${randomBytes(8).toString('hex')}`, 'Injection in the order text', new Date().toISOString())
    const session = createAdminSession(db, { email: 'reviewer@beam.directory', role: 'operator' })
    const reviewed = await app.request(new Request(`http://localhost/admin/abuse/${reportId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ decision: 'block_agent', note: 'Der Agent bleibt gesperrt.' }),
    }))
    assert.equal(reviewed.status, 200)
    assert.equal((db.prepare(`SELECT status FROM mandates WHERE jti = 'mandate-block'`).get() as { status: string }).status, 'revoked')
    assert.equal((db.prepare('SELECT revoked FROM delegations WHERE grantor_beam_id = ?').get(buyerId) as { revoked: number }).revoked, 1)
    assert.ok((db.prepare('SELECT suspended_at FROM agents WHERE beam_id = ?').get(buyerId) as { suspended_at: string | null }).suspended_at)
    const lifted = await app.request(new Request(`http://localhost/admin/agents/${encodeURIComponent(buyerId)}/unsuspend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ note: 'Die Sperre ist aufgehoben.' }),
    }))
    assert.equal(lifted.status, 200)
    assert.equal((db.prepare('SELECT suspended_at FROM agents WHERE beam_id = ?').get(buyerId) as { suspended_at: string | null }).suspended_at, null)
    assert.ok(db.prepare(`SELECT action FROM audit_log WHERE action = 'agent.unsuspended'`).get())
  } finally {
    db.close()
  }
})
