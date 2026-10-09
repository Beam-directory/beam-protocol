import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import test from 'node:test'
import { createAdminSession } from './admin-auth.js'
import { signPayload } from './crypto.js'
import { assignDirectoryRole, createDatabase, markOrgVerified } from './db.js'
import { getLocalDirectoryUrl } from './federation.js'
import { createApp } from './server.js'
import { assertionSignedPayload, type TrustAssertion } from './trust/assertion.js'
import { holdConsequentialIntent } from './trust/consequential.js'

function keypair() {
  const keys = generateKeyPairSync('ed25519')
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey,
  }
}

function verifiesWith(text: string, signature: string, publicKeyBase64: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
  return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64'))
}

test('a fully wired agent carries person and mandate in its signed trust assertion', async () => {
  const db = createDatabase(':memory:')
  const previousPrivate = process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY']
  const previousPublic = process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY']
  const issuer = keypair()
  process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'] = issuer.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'] = issuer.publicKey
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'trust-chain-test-secret'
  try {
    const app = createApp(db)
    const json = (body: unknown) => JSON.stringify(body)

    const orgResponse = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.71' },
      body: json({ name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }),
    }))
    assert.equal(orgResponse.status, 201)
    const org = await orgResponse.json() as { apiKey: string; name: string }
    markOrgVerified(db, org.name)
    const orgHeaders = { 'content-type': 'application/json', 'x-api-key': org.apiKey }

    const agentResponse = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: orgHeaders,
      body: json({ agentName: 'jarvis', publicKey: keypair().publicKey }),
    }))
    assert.equal(agentResponse.status, 201)
    const beamId = (await agentResponse.json() as { beamId: string }).beamId
    assert.equal(beamId, 'jarvis@coppen.beam.directory')

    const before = await (await app.request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`, { headers: orgHeaders })).json() as TrustAssertion
    assert.equal(before.person, null)
    assert.equal(before.mandate, null)

    const personKey = keypair()
    const personResponse = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: orgHeaders,
      body: json({
        email: 'tobias@coppen.de',
        displayName: 'Tobias Kub',
        role: 'Geschäftsführer',
        publicKey: personKey.publicKey,
        rights: { actions: ['read', 'schedule.commit', 'file.send'] },
      }),
    }))
    assert.equal(personResponse.status, 201)
    const personId = (await personResponse.json() as { person: { id: string } }).person.id

    const requested = await app.request(new Request(`http://localhost/orgs/coppen/people/${personId}/kyc`, {
      method: 'POST',
      headers: orgHeaders,
      body: json({ provider: 'manual' }),
    }))
    assert.equal((await requested.json() as { person: { kycStatus: string } }).person.kycStatus, 'pending')
    assignDirectoryRole(db, { userId: 'reviewer@beam.directory', role: 'operator', directoryUrl: getLocalDirectoryUrl() })
    const session = createAdminSession(db, { email: 'reviewer@beam.directory', role: 'operator' })
    const reviewed = await app.request(new Request(`http://localhost/admin/people/${personId}/kyc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: json({ status: 'verified', note: 'Register extract and ID checked by hand.' }),
    }))
    assert.equal(reviewed.status, 200)

    const responsible = await app.request(new Request('http://localhost/orgs/coppen/agents/jarvis/responsible-person', {
      method: 'PUT',
      headers: orgHeaders,
      body: json({ responsiblePersonId: personId }),
    }))
    assert.equal(responsible.status, 200)

    const scopes = { actions: ['read', 'schedule.commit', 'file.send'] }
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    const payload = {
      type: 'mandate' as const,
      jti: 'coppen-jarvis-test',
      version: 1 as const,
      personId,
      agentBeamId: beamId,
      org: 'coppen',
      scopes,
      expiresAt,
      escalationPersonId: null,
    }
    const mandate = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ jti: payload.jti, scopes, expiresAt, escalationPersonId: null, signature: signPayload(payload, personKey.privateKey) }),
    }))
    assert.equal(mandate.status, 201)

    const assertion = await (await app.request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`, { headers: orgHeaders })).json() as TrustAssertion
    assert.equal(assertion.v, 1)
    assert.deepEqual(assertion.person, {
      ref: createHash('sha256').update(personId).digest('hex'),
      role: 'Geschäftsführer',
      kycStatus: 'verified',
    })
    assert.deepEqual(assertion.mandate, { jti: payload.jti, scopes, expiresAt, escalationPersonRef: null })
    assert.equal(JSON.stringify(assertion).includes('Tobias'), false)
    assert.equal(assertion.publicKey, issuer.publicKey)
    assert.equal(verifiesWith(assertionSignedPayload(assertion), assertion.signature, issuer.publicKey), true)
    const altered: TrustAssertion = { ...assertion, mandate: { ...assertion.mandate!, expiresAt: '2099-01-01T00:00:00.000Z' } }
    assert.equal(verifiesWith(assertionSignedPayload(altered), assertion.signature, issuer.publicKey), false)

    const frame = (intent: string, payloadBody: Record<string, unknown> = {}) => ({
      v: '1' as const,
      intent,
      from: beamId,
      to: 'shop@example.beam.directory',
      payload: payloadBody,
      nonce: randomBytes(12).toString('hex'),
      timestamp: new Date().toISOString(),
    })
    assert.equal(holdConsequentialIntent(db, frame('schedule.commit')), null)
    for (const intent of ['order.place', 'payment.submit']) {
      const held = holdConsequentialIntent(db, frame(intent, { amount: '10.00', currency: 'EUR' }))
      assert.equal(held?.kind, 'approval')
      assert.equal(held && 'reason' in held ? held.reason : null, 'outside mandate scope')
    }
  } finally {
    if (previousPrivate === undefined) delete process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY']
    else process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'] = previousPrivate
    if (previousPublic === undefined) delete process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY']
    else process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'] = previousPublic
    db.close()
  }
})
