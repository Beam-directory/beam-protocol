import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { signPayload, verifyPayload } from './crypto.js'
import { createDatabase, createDelegation, markOrgVerified, registerAgent } from './db.js'
import { createApp } from './server.js'
import { setAgentResponsiblePerson } from './trust/person-store.js'

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
  const body = await response.json() as { apiKey: string; name: string }
  assert.equal(markOrgVerified(db, body.name)?.name, 'coppen')
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
    db.prepare(`UPDATE persons SET kyc_status = 'verified' WHERE id = ?`).run(personId)
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

    db.prepare(`UPDATE agents SET visibility = 'public' WHERE beam_id = ?`).run(beamId)
    const missingIssuer = await app.request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`)
    assert.equal(missingIssuer.status, 503)
    assert.equal((await missingIssuer.json() as { errorCode: string }).errorCode, 'ISSUER_KEY_REQUIRED')

    const issuer = keypair()
    process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'] = issuer.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'] = issuer.publicKey
    const assertionResponse = await app.request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`)
    assert.equal(assertionResponse.status, 200)
    const assertion = await assertionResponse.json() as {
      person: { ref: string } | null
      mandate: { jti: string } | null
      suspended: boolean
      signature: string
      publicKey: string
    }
    assert.equal(assertion.mandate?.jti, replacement.jti)
    assert.equal(assertion.suspended, false)
    assert.equal(assertion.person?.ref, createHash('sha256').update(personId).digest('hex'))
    assert.notEqual(assertion.person?.ref, personId)
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

test('a mandate requires a KYC-verified person and a verified organization', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const response = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.62' },
      body: JSON.stringify({ name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }),
    }))
    assert.equal(response.status, 201)
    const org = await response.json() as { apiKey: string; name: string }
    const personKey = keypair()
    const created = await app.request(new Request(`http://localhost/orgs/${org.name}/people`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': org.apiKey },
      body: JSON.stringify({
        email: 'clara@coppen.de',
        displayName: 'Clara',
        role: 'Einkauf',
        publicKey: personKey.publicKey,
        rights: { actions: ['read'] },
      }),
    }))
    assert.equal(created.status, 201)
    const personId = (await created.json() as { person: { id: string } }).person.id
    const agentKey = keypair()
    const beamId = `buyer@${org.name}.beam.directory`
    registerAgent(db, { beamId, displayName: 'Buyer', capabilities: ['read'], publicKey: agentKey.publicKey, org: org.name })
    setAgentResponsiblePerson(db, beamId, personId)
    const mandate = {
      type: 'mandate' as const,
      jti: 'mandate-unverified',
      version: 1 as const,
      personId,
      agentBeamId: beamId,
      org: org.name,
      scopes: { actions: ['read'] },
      expiresAt: '2027-01-01T00:00:00.000Z',
      escalationPersonId: null,
    }
    const post = () => app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
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
    const unverifiedPerson = await post()
    assert.equal(unverifiedPerson.status, 400)
    assert.equal((await unverifiedPerson.json() as { errorCode: string }).errorCode, 'KYC_REQUIRED')
    db.prepare(`UPDATE persons SET kyc_status = 'verified' WHERE id = ?`).run(personId)
    const unverifiedOrg = await post()
    assert.equal(unverifiedOrg.status, 400)
    assert.equal((await unverifiedOrg.json() as { errorCode: string }).errorCode, 'ORG_VERIFICATION_REQUIRED')
  } finally {
    db.close()
  }
})

test('shrinking rights revokes a mandate, and a supervisor or the organization can revoke one', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const managerKey = keypair()
    const personKey = keypair()
    const manager = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ email: 'boss@coppen.de', displayName: 'Boss', role: 'Leitung', publicKey: managerKey.publicKey }),
    }))
    const managerId = (await manager.json() as { person: { id: string } }).person.id
    const created = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        email: 'clara@coppen.de',
        displayName: 'Clara',
        role: 'Einkauf',
        publicKey: personKey.publicKey,
        supervisorPersonId: managerId,
        rights: { actions: ['order'], order: { maxAmount: '100.00', currency: 'EUR' } },
      }),
    }))
    const personId = (await created.json() as { person: { id: string } }).person.id
    db.prepare(`UPDATE persons SET kyc_status = 'verified' WHERE id IN (?, ?)`).run(managerId, personId)
    const agentKey = keypair()
    const agent = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-forwarded-for': '203.0.113.63' },
      body: JSON.stringify({ agentName: 'buyer', publicKey: agentKey.publicKey, responsiblePersonId: personId }),
    }))
    assert.equal(agent.status, 201)
    const beamId = (await agent.json() as { beamId: string }).beamId
    const signMandate = (jti: string, scopes: { actions: string[]; order?: { maxAmount: string; currency: string } }) => {
      const payload = {
        type: 'mandate' as const,
        jti,
        version: 1 as const,
        personId,
        agentBeamId: beamId,
        org: 'coppen',
        scopes,
        expiresAt: '2027-01-01T00:00:00.000Z',
        escalationPersonId: managerId,
      }
      return { payload, signature: signPayload(payload, personKey.privateKey) }
    }
    const within = signMandate('mandate-rights', { actions: ['order'], order: { maxAmount: '40.00', currency: 'EUR' } })
    const posted = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: within.payload.jti,
        scopes: within.payload.scopes,
        expiresAt: within.payload.expiresAt,
        escalationPersonId: managerId,
        signature: within.signature,
      }),
    }))
    assert.equal(posted.status, 201)
    const shrunk = await app.request(new Request(`http://localhost/orgs/coppen/people/${personId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ rights: { actions: [] } }),
    }))
    assert.equal(shrunk.status, 200)
    assert.equal((db.prepare(`SELECT status FROM mandates WHERE jti = 'mandate-rights'`).get() as { status: string }).status, 'revoked')

    db.prepare(`UPDATE persons SET rights_json = ? WHERE id = ?`).run(JSON.stringify({ actions: ['read'] }), personId)
    const readable = signMandate('mandate-supervisor', { actions: ['read'] })
    const second = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: readable.payload.jti,
        scopes: readable.payload.scopes,
        expiresAt: readable.payload.expiresAt,
        escalationPersonId: managerId,
        signature: readable.signature,
      }),
    }))
    assert.equal(second.status, 201)
    const revokePayload = { type: 'mandate-revoke' as const, jti: 'mandate-supervisor', personId }
    const bySupervisor = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates/mandate-supervisor/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signature: signPayload(revokePayload, managerKey.privateKey) }),
    }))
    assert.equal(bySupervisor.status, 200)

    const third = signMandate('mandate-org', { actions: ['read'] })
    const thirdPosted = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: third.payload.jti,
        scopes: third.payload.scopes,
        expiresAt: third.payload.expiresAt,
        escalationPersonId: managerId,
        signature: third.signature,
      }),
    }))
    assert.equal(thirdPosted.status, 201)
    const byOrg = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/mandates/mandate-org/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({}),
    }))
    assert.equal(byOrg.status, 200)
    assert.equal((db.prepare(`SELECT status FROM mandates WHERE jti = 'mandate-org'`).get() as { status: string }).status, 'revoked')
  } finally {
    db.close()
  }
})

test('acceptance rules are bound to a nonce and a monotonic version', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const agentKey = keypair()
    const agent = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-forwarded-for': '203.0.113.64' },
      body: JSON.stringify({ agentName: 'buyer', publicKey: agentKey.publicKey }),
    }))
    assert.equal(agent.status, 201)
    const beamId = (await agent.json() as { beamId: string }).beamId
    const nonce = `nonce-${randomBytes(12).toString('hex')}`
    const first = {
      type: 'acceptance' as const,
      beamId,
      allowedOrgDomains: ['coppen.de'],
      allowedScopes: ['read'],
      allowedAgents: [] as string[],
      requireKnownContact: false,
      version: 1,
      timestamp: new Date().toISOString(),
      nonce,
    }
    const put = (body: object, signature?: string) => app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/acceptance`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(signature ? {} : { 'x-api-key': apiKey }) },
      body: JSON.stringify(signature ? { ...body, signature } : body),
    }))
    const saved = await put(first, signPayload(first, agentKey.privateKey))
    assert.equal(saved.status, 200)
    const replay = await put(first, signPayload(first, agentKey.privateKey))
    assert.equal(replay.status, 409)
    assert.equal((await replay.json() as { errorCode: string }).errorCode, 'ACCEPTANCE_STALE')
    const second = { ...first, version: 2, nonce: `nonce-${randomBytes(12).toString('hex')}`, allowedScopes: ['order'] }
    const updated = await put(second, signPayload(second, agentKey.privateKey))
    assert.equal(updated.status, 200)
    assert.equal((await updated.json() as { acceptance: { version: number } }).acceptance.version, 2)
  } finally {
    db.close()
  }
})

test('an unlisted trust assertion is visible to the agent and accepted contacts only', async () => {
  const db = createDatabase(':memory:')
  const previousPrivate = process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY']
  const previousPublic = process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY']
  try {
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const issuer = keypair()
    process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'] = issuer.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'] = issuer.publicKey
    const buyerKey = keypair()
    const vendorKey = keypair()
    const issue = async (agentName: string, publicKey: string) => {
      const response = await app.request(new Request('http://localhost/orgs/coppen/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-forwarded-for': '203.0.113.65' },
        body: JSON.stringify({ agentName, publicKey }),
      }))
      assert.equal(response.status, 201)
      return await response.json() as { beamId: string; apiKey: string }
    }
    const buyer = await issue('buyer', buyerKey.publicKey)
    const vendor = await issue('vendor', vendorKey.publicKey)
    const url = `http://localhost/agents/${encodeURIComponent(buyer.beamId)}/trust-assertion`
    const hidden = await app.request(url)
    assert.equal(hidden.status, 404)
    const self = await app.request(url, { headers: { 'x-api-key': buyer.apiKey } })
    assert.equal(self.status, 200)
    const stranger = await app.request(url, { headers: { 'x-api-key': vendor.apiKey } })
    assert.equal(stranger.status, 403)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO beam_connections (
        connection_id, pair_key, requester_beam_id, recipient_beam_id, status,
        requester_signature, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'accepted', 'test', ?, ?)
    `).run('conn-1', [buyer.beamId, vendor.beamId].sort().join('\n'), vendor.beamId, buyer.beamId, now, now)
    const contact = await app.request(url, { headers: { 'x-api-key': vendor.apiKey } })
    assert.equal(contact.status, 200)
    db.prepare('UPDATE agents SET suspended_at = ? WHERE beam_id = ?').run(now, buyer.beamId)
    const suspended = await app.request(url, { headers: { 'x-api-key': buyer.apiKey } })
    assert.equal(suspended.status, 200)
    assert.equal((await suspended.json() as { suspended: boolean }).suspended, true)
  } finally {
    if (previousPrivate === undefined) delete process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY']
    else process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'] = previousPrivate
    if (previousPublic === undefined) delete process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY']
    else process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'] = previousPublic
    db.close()
  }
})

test('offboarding and a new responsible person revoke mandates and delegations', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const firstKey = keypair()
    const secondKey = keypair()
    const vendorKey = keypair()
    const createPerson = async (email: string, publicKey: string) => {
      const response = await app.request(new Request('http://localhost/orgs/coppen/people', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ email, displayName: email, role: 'Einkauf', publicKey, rights: { actions: ['read'] } }),
      }))
      assert.equal(response.status, 201)
      const id = (await response.json() as { person: { id: string } }).person.id
      db.prepare(`UPDATE persons SET kyc_status = 'verified' WHERE id = ?`).run(id)
      return id
    }
    const firstId = await createPerson('clara@coppen.de', firstKey.publicKey)
    const secondId = await createPerson('tim@coppen.de', secondKey.publicKey)
    const issue = async (agentName: string, publicKey: string, responsiblePersonId: string) => {
      const response = await app.request(new Request('http://localhost/orgs/coppen/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-forwarded-for': '203.0.113.66' },
        body: JSON.stringify({ agentName, publicKey, responsiblePersonId }),
      }))
      assert.equal(response.status, 201)
      return await response.json() as { beamId: string }
    }
    const buyer = await issue('buyer', keypair().publicKey, firstId)
    const vendor = await issue('vendor', vendorKey.publicKey, secondId)
    const mandate = {
      type: 'mandate' as const,
      jti: 'mandate-handover',
      version: 1 as const,
      personId: firstId,
      agentBeamId: buyer.beamId,
      org: 'coppen',
      scopes: { actions: ['read'] },
      expiresAt: '2027-01-01T00:00:00.000Z',
      escalationPersonId: null,
    }
    const posted = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(buyer.beamId)}/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jti: mandate.jti,
        scopes: mandate.scopes,
        expiresAt: mandate.expiresAt,
        escalationPersonId: null,
        signature: signPayload(mandate, firstKey.privateKey),
      }),
    }))
    assert.equal(posted.status, 201)
    createDelegation(db, {
      grantorBeamId: buyer.beamId,
      granteeBeamId: vendor.beamId,
      scope: 'read',
      expiresAt: Date.now() + 60_000,
      payloadHash: randomBytes(16).toString('hex'),
    })
    const handed = await app.request(new Request('http://localhost/orgs/coppen/agents/buyer/responsible-person', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ responsiblePersonId: secondId }),
    }))
    assert.equal(handed.status, 200)
    const handBody = await handed.json() as { revokedMandates: number; revokedDelegations: number }
    assert.equal(handBody.revokedMandates, 1)
    assert.equal(handBody.revokedDelegations, 1)
    createDelegation(db, {
      grantorBeamId: buyer.beamId,
      granteeBeamId: vendor.beamId,
      scope: 'conversation.message',
      expiresAt: Date.now() + 60_000,
      payloadHash: randomBytes(16).toString('hex'),
    })
    const offboarded = await app.request(new Request(`http://localhost/orgs/coppen/people/${secondId}/offboard`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    }))
    assert.equal(offboarded.status, 200)
    assert.equal((await offboarded.json() as { revokedDelegations: number }).revokedDelegations, 1)
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM delegations WHERE revoked = 0').get() as { count: number }).count, 0)
  } finally {
    db.close()
  }
})
