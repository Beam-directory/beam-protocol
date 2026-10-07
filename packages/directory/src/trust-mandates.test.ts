import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { signPayload, verifyPayload } from './crypto.js'
import { createDatabase, registerAgent } from './db.js'
import { createApp } from './server.js'

function keypair() {
  const keys = generateKeyPairSync('ed25519')
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey,
  }
}

function signRaw(payload: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')
}

async function createVerifiedOrg(app: ReturnType<typeof createApp>, db: ReturnType<typeof createDatabase>) {
  const response = await app.request(new Request('http://localhost/orgs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.61' },
    body: JSON.stringify({ name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }),
  }))
  assert.equal(response.status, 201)
  const body = await response.json() as { apiKey: string }
  db.prepare('UPDATE orgs SET verified = 1, claim_expires_at = NULL WHERE name = ?').run('coppen')
  return body.apiKey
}

test('a mandate cannot exceed the person, and a revoked signature cannot be replayed', async () => {
  const db = createDatabase(':memory:')
  const previousPrivate = process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY']
  const previousPublic = process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY']
  delete process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY']
  delete process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY']
  try {
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const personKey = keypair()
    const created = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        email: 'clara@coppen.de',
        displayName: 'Clara',
        role: 'Einkauf',
        publicKey: personKey.publicKey,
        rights: { actions: ['read', 'order'], order: { maxAmount: '100.00', currency: 'EUR' } },
      }),
    }))
    assert.equal(created.status, 201)
    const personId = (await created.json() as { person: { id: string } }).person.id
    const agentKey = keypair()
    const agent = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'buyer', publicKey: agentKey.publicKey, responsiblePersonId: personId }),
    }))
    assert.equal(agent.status, 201)
    const beamId = (await agent.json() as { beamId: string }).beamId

    const tooWide = {
      type: 'mandate' as const,
      jti: 'mandate-too-wide',
      version: 1 as const,
      personId,
      agentBeamId: beamId,
      org: 'coppen',
      scopes: { actions: ['read', 'order'], order: { maxAmount: '500.00', currency: 'EUR' } },
      expiresAt: '2027-01-01T00:00:00.000Z',
      escalationPersonId: null,
    }
    const rejected = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: tooWide.jti,
        scopes: tooWide.scopes,
        expiresAt: tooWide.expiresAt,
        escalationPersonId: null,
        signature: signPayload(tooWide, personKey.privateKey),
      }),
    }))
    assert.equal(rejected.status, 400)
    assert.equal((await rejected.json() as { errorCode: string }).errorCode, 'MANDATE_EXCEEDS_RIGHTS')

    const within = { ...tooWide, jti: 'mandate-within', scopes: { actions: ['order'], order: { maxAmount: '40.00', currency: 'EUR' } } }
    const signed = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: within.jti,
        scopes: within.scopes,
        expiresAt: within.expiresAt,
        escalationPersonId: null,
        signature: signPayload(within, personKey.privateKey),
      }),
    }))
    assert.equal(signed.status, 201)

    const revokePayload = { type: 'mandate-revoke' as const, jti: within.jti, personId }
    const revoked = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates/${within.jti}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: signPayload(revokePayload, personKey.privateKey) }),
    }))
    assert.equal(revoked.status, 200)

    const replay = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: within.jti,
        scopes: within.scopes,
        expiresAt: within.expiresAt,
        escalationPersonId: null,
        signature: signPayload(within, personKey.privateKey),
      }),
    }))
    assert.equal(replay.status, 409)
    assert.equal((await replay.json() as { errorCode: string }).errorCode, 'MANDATE_REPLAY')
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM mandates').get() as { count: number }).count, 1)

    const replacement = {
      ...within,
      jti: 'mandate-after-revoke',
      scopes: { actions: ['read'] },
    }
    const reissued = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: replacement.jti,
        scopes: replacement.scopes,
        expiresAt: replacement.expiresAt,
        escalationPersonId: null,
        signature: signPayload(replacement, personKey.privateKey),
      }),
    }))
    assert.equal(reissued.status, 201)

    const missingIssuer = await app.request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`)
    assert.equal(missingIssuer.status, 503)
    assert.equal((await missingIssuer.json() as { errorCode: string }).errorCode, 'ISSUER_KEY_REQUIRED')

    const issuer = keypair()
    process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'] = issuer.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'] = issuer.publicKey
    const assertionResponse = await app.request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`)
    assert.equal(assertionResponse.status, 200)
    const assertion = await assertionResponse.json() as {
      mandate: { jti: string } | null
      signature: string
      publicKey: string
    }
    assert.equal(assertion.mandate?.jti, replacement.jti)
    const { signature, publicKey, ...unsigned } = assertion
    assert.equal(publicKey, issuer.publicKey)
    assert.equal(verifyPayload(unsigned, signature, publicKey), true)

    const offboarded = await app.request(new Request(`http://localhost/orgs/coppen/people/${personId}/offboard`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    }))
    assert.equal(offboarded.status, 200)
    const offboardBody = await offboarded.json() as { revokedMandates: number; suspendedAgents: number }
    assert.equal(offboardBody.revokedMandates, 1)
    assert.equal(offboardBody.suspendedAgents, 1)
    const afterOffboard = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: replacement.jti,
        scopes: replacement.scopes,
        expiresAt: replacement.expiresAt,
        escalationPersonId: null,
        signature: signPayload(replacement, personKey.privateKey),
      }),
    }))
    assert.equal(afterOffboard.status, 409)
    assert.equal((await afterOffboard.json() as { errorCode: string }).errorCode, 'MANDATE_REPLAY')
  } finally {
    if (previousPrivate === undefined) delete process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY']
    else process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'] = previousPrivate
    if (previousPublic === undefined) delete process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY']
    else process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'] = previousPublic
    db.close()
  }
})

test('replaying a revoked delegation does not create it again', async () => {
  const db = createDatabase(':memory:')
  try {
    const grantor = keypair()
    const grantee = keypair()
    const grantorBeamId = 'grantor@coppen.beam.directory'
    const granteeBeamId = 'grantee@coppen.beam.directory'
    registerAgent(db, { beamId: grantorBeamId, displayName: 'Grantor', capabilities: ['read'], publicKey: grantor.publicKey })
    registerAgent(db, { beamId: granteeBeamId, displayName: 'Grantee', capabilities: ['read'], publicKey: grantee.publicKey })
    const app = createApp(db)
    const expiresAt = Date.now() + 60_000
    const payload = JSON.stringify({
      type: 'delegation',
      grantor_beam_id: grantorBeamId,
      grantee_beam_id: granteeBeamId,
      scope: 'read',
      expires_at: expiresAt,
    })
    const body = {
      grantee_beam_id: granteeBeamId,
      scope: 'read',
      expires_at: expiresAt,
      signature: signRaw(payload, grantor.privateKey),
    }
    const created = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(grantorBeamId)}/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    assert.equal(created.status, 201)
    const id = (await created.json() as { id: number }).id
    const revokePayload = JSON.stringify({
      type: 'delegation-revoke',
      grantor_beam_id: grantorBeamId,
      delegation_id: id,
    })
    const revoked = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(grantorBeamId)}/delegations/${id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: signRaw(revokePayload, grantor.privateKey) }),
    }))
    assert.equal(revoked.status, 200)
    const replay = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(grantorBeamId)}/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    assert.equal(replay.status, 409)
    assert.equal((await replay.json() as { errorCode: string }).errorCode, 'DELEGATION_REPLAY')
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM delegations').get() as { count: number }).count, 1)
  } finally {
    db.close()
  }
})
