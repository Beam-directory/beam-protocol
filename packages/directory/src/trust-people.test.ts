import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import test from 'node:test'
import { createAdminSession } from './admin-auth.js'
import { assignDirectoryRole, createDatabase, createDelegation, getAgent, markOrgVerified } from './db.js'
import { signPayload } from './crypto.js'
import { getLocalDirectoryUrl } from './federation.js'
import { createApp } from './server.js'
import { scopeWithin, type ScopeGrant } from './trust/scopes.js'
import { canActOnBehalf } from './websocket.js'

function publicKeyOf(keys = generateKeyPairSync('ed25519')): { publicKey: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey,
  }
}

async function createVerifiedOrg(app: ReturnType<typeof createApp>, db: ReturnType<typeof createDatabase>) {
  const response = await app.request(new Request('http://localhost/orgs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
    body: JSON.stringify({ name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }),
  }))
  assert.equal(response.status, 201)
  const body = await response.json() as { apiKey: string; name: string }
  assert.equal(markOrgVerified(db, body.name)?.name, 'coppen')
  return body.apiKey
}

test('offboarding locks the person and suspends every agent they own', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'people-test-secret'
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const manager = publicKeyOf()
    const employeeKeys = publicKeyOf()
    const createdManager = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        email: 'clara@coppen.de',
        displayName: 'Clara',
        role: 'Vertrieb',
        publicKey: manager.publicKey,
        rights: { actions: ['read', 'schedule.commit', 'order'], order: { maxAmount: '5000.00', currency: 'EUR' } },
      }),
    }))
    assert.equal(createdManager.status, 201)
    const managerId = (await createdManager.json() as { person: { id: string } }).person.id

    const invited = await app.request(new Request('http://localhost/orgs/coppen/people/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        email: 'lea@coppen.de',
        role: 'Vertrieb Telefon',
        supervisorPersonId: managerId,
        rights: { actions: ['read', 'schedule.commit'] },
      }),
    }))
    assert.equal(invited.status, 201)
    const token = (await invited.json() as { token: string }).token
    const accepted = await app.request(new Request('http://localhost/people/invitations/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, displayName: 'Lea', publicKey: employeeKeys.publicKey }),
    }))
    assert.equal(accepted.status, 201)
    const employee = (await accepted.json() as { person: { id: string; supervisorPersonId: string; kycStatus: string } }).person
    assert.equal(employee.supervisorPersonId, managerId)
    assert.equal(employee.kycStatus, 'unverified')

    const agentKey = publicKeyOf()
    const agent = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        agentName: 'lea',
        publicKey: agentKey.publicKey,
        responsiblePersonId: employee.id,
      }),
    }))
    assert.equal(agent.status, 201)
    const beamId = (await agent.json() as { beamId: string; apiKey: string }).beamId

    const kyc = await app.request(new Request(`http://localhost/orgs/coppen/people/${employee.id}/kyc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ provider: 'manual' }),
    }))
    assert.equal(kyc.status, 200)
    assert.equal((await kyc.json() as { person: { kycStatus: string } }).person.kycStatus, 'pending')

    const nextKey = publicKeyOf().publicKey
    const timestamp = new Date().toISOString()
    const personSignature = signPayload({
      action: 'keys.rotate',
      beamId,
      newPublicKey: nextKey,
      timestamp,
    }, employeeKeys.privateKey)
    const rotated = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ new_public_key: nextKey, timestamp, signature: personSignature }),
    }))
    assert.equal(rotated.status, 200)

    const offboarded = await app.request(new Request(`http://localhost/orgs/coppen/people/${employee.id}/offboard`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    }))
    assert.equal(offboarded.status, 200)
    const offboardBody = await offboarded.json() as { person: { status: string }; suspendedAgents: number }
    assert.equal(offboardBody.person.status, 'offboarded')
    assert.equal(offboardBody.suspendedAgents, 1)
    assert.ok(getAgent(db, beamId)?.suspended_at)

    const after = new Date().toISOString()
    const replacement = publicKeyOf().publicKey
    const blocked = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        new_public_key: replacement,
        timestamp: after,
        signature: signPayload({
          action: 'keys.rotate',
          beamId,
          newPublicKey: replacement,
          timestamp: after,
        }, employeeKeys.privateKey),
      }),
    }))
    assert.equal(blocked.status, 400)
    assert.equal(getAgent(db, beamId)?.public_key, nextKey)
  } finally {
    db.close()
  }
})

test('directory import offboards from a snapshot and does not call a provider', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'people-test-secret'
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const owner = publicKeyOf()
    const ownerResponse = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        email: 'otto@coppen.de',
        displayName: 'Otto',
        role: 'Einkauf',
        publicKey: owner.publicKey,
      }),
    }))
    const ownerId = (await ownerResponse.json() as { person: { id: string } }).person.id
    const agent = await app.request(new Request('http://localhost/orgs/coppen/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        agentName: 'einkauf',
        publicKey: publicKeyOf().publicKey,
        responsiblePersonId: ownerId,
      }),
    }))
    const beamId = (await agent.json() as { beamId: string }).beamId

    const imported = await app.request(new Request('http://localhost/orgs/coppen/people/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        source: 'personio',
        people: [
          {
            externalId: 'p-clara',
            email: 'clara.import@coppen.de',
            displayName: 'Clara Import',
            role: 'Leitung',
            status: 'active',
            rights: { actions: ['read'] },
          },
        ],
      }),
    }))
    assert.equal(imported.status, 200)
    const summary = await imported.json() as { imported: number; offboarded: number }
    assert.equal(summary.imported, 1)
    assert.equal(summary.offboarded, 0)
    assert.equal(getAgent(db, beamId)?.suspended_at, null)

    db.prepare(`
      UPDATE persons
      SET external_source = 'personio', external_id = 'p-otto'
      WHERE id = ?
    `).run(ownerId)
    const again = await app.request(new Request('http://localhost/orgs/coppen/people/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        source: 'personio',
        people: [
          {
            externalId: 'p-otto',
            email: 'otto@coppen.de',
            displayName: 'Otto',
            role: 'Einkauf',
            status: 'offboarded',
          },
        ],
      }),
    }))
    assert.equal(again.status, 200)
    assert.equal((await again.json() as { offboarded: number }).offboarded, 1)
    assert.ok(getAgent(db, beamId)?.suspended_at)
    const person = db.prepare('SELECT status FROM persons WHERE id = ?').get(ownerId) as { status: string }
    assert.equal(person.status, 'offboarded')

    const cycle = await app.request(new Request('http://localhost/orgs/coppen/people/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        source: 'entra',
        people: [
          { externalId: 'a', email: 'a@coppen.de', displayName: 'A', role: 'A', status: 'active', supervisorExternalId: 'b' },
          { externalId: 'b', email: 'b@coppen.de', displayName: 'B', role: 'B', status: 'active', supervisorExternalId: 'a' },
        ],
      }),
    }))
    assert.equal(cycle.status, 400)
    assert.equal((await cycle.json() as { errorCode: string }).errorCode, 'INVALID_IMPORT')
  } finally {
    db.close()
  }
})

test('manual KYC review is the only way to mark a person verified', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'people-test-secret'
    assignDirectoryRole(db, {
      userId: 'reviewer@beam.directory',
      role: 'operator',
      directoryUrl: getLocalDirectoryUrl(),
    })
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const created = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        email: 'tobias@coppen.de',
        displayName: 'Tobias',
        role: 'Geschäftsführer',
        publicKey: publicKeyOf().publicKey,
      }),
    }))
    const personId = (await created.json() as { person: { id: string; kycStatus: string } }).person.id
    const session = createAdminSession(db, { email: 'reviewer@beam.directory', role: 'operator' })
    const reviewed = await app.request(new Request(`http://localhost/admin/people/${personId}/kyc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ status: 'verified', note: 'Ausweis geprüft, ohne externen Anbieter.' }),
    }))
    assert.equal(reviewed.status, 200)
    assert.equal((await reviewed.json() as { person: { kycStatus: string; kycProvider: string } }).person.kycStatus, 'verified')

    const rightsOnly = await app.request(new Request(`http://localhost/orgs/coppen/people/${personId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ rights: { actions: ['read'] } }),
    }))
    assert.equal(rightsOnly.status, 200)
    assert.equal((await rightsOnly.json() as { person: { kycStatus: string } }).person.kycStatus, 'verified')

    const replacement = publicKeyOf()
    const swapped = await app.request(new Request(`http://localhost/orgs/coppen/people/${personId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ publicKey: replacement.publicKey }),
    }))
    assert.equal(swapped.status, 200)
    const swappedPerson = (await swapped.json() as { person: { publicKey: string; kycStatus: string; kycProvider: string | null } }).person
    assert.equal(swappedPerson.publicKey, replacement.publicKey)
    assert.equal(swappedPerson.kycStatus, 'pending')
    assert.equal(swappedPerson.kycProvider, null)

    const sameKey = await app.request(new Request(`http://localhost/orgs/coppen/people/${personId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ publicKey: replacement.publicKey, rights: { actions: ['read'] } }),
    }))
    assert.equal(sameKey.status, 200)
    assert.equal((await sameKey.json() as { person: { kycStatus: string } }).person.kycStatus, 'pending')
  } finally {
    db.close()
  }
})

test('scopeWithin rejects a child that drops a parent limit', () => {
  const parent: ScopeGrant = {
    actions: ['order', 'file.send'],
    order: { maxAmount: '100.00', currency: 'EUR' },
    file: { maxBytes: 1000 },
  }
  assert.equal(scopeWithin({ actions: ['order'], order: { maxAmount: '100.00', currency: 'EUR' } }, parent), true)
  assert.equal(scopeWithin({ actions: ['order'] }, parent), false)
  assert.equal(scopeWithin({ actions: ['file.send'] }, parent), false)
  assert.equal(scopeWithin({ actions: ['read'] }, { actions: ['read'] }), true)
})

test('a suspended agent cannot open a network connection or use a delegation', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'people-test-secret'
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const personKeys = publicKeyOf()
    const buyerKeys = publicKeyOf()
    const vendorKeys = publicKeyOf()
    const person = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ email: 'clara@coppen.de', displayName: 'Clara', role: 'Einkauf', publicKey: personKeys.publicKey }),
    }))
    const personId = (await person.json() as { person: { id: string } }).person.id
    const issue = async (agentName: string, publicKey: string, responsiblePersonId?: string) => {
      const response = await app.request(new Request('http://localhost/orgs/coppen/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ agentName, publicKey, ...(responsiblePersonId ? { responsiblePersonId } : {}) }),
      }))
      assert.equal(response.status, 201)
      return await response.json() as { beamId: string; apiKey: string }
    }
    const buyer = await issue('buyer', buyerKeys.publicKey, personId)
    const vendor = await issue('vendor', vendorKeys.publicKey)
    createDelegation(db, {
      grantorBeamId: vendor.beamId,
      granteeBeamId: buyer.beamId,
      scope: 'conversation.message',
      expiresAt: Date.now() + 60_000,
      payloadHash: randomBytes(16).toString('hex'),
    })
    assert.equal(canActOnBehalf(db, buyer.beamId, vendor.beamId, 'conversation.message'), true)

    const offboarded = await app.request(new Request(`http://localhost/orgs/coppen/people/${personId}/offboard`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
    }))
    assert.equal(offboarded.status, 200)
    assert.equal(canActOnBehalf(db, buyer.beamId, vendor.beamId, 'conversation.message'), false)
    assert.equal(canActOnBehalf(db, buyer.beamId, buyer.beamId, 'conversation.message'), false)

    const timestamp = new Date().toISOString()
    const nonce = `nonce-${randomBytes(12).toString('hex')}`
    const payload = {
      type: 'network.connection.request',
      requesterBeamId: buyer.beamId,
      recipientBeamId: vendor.beamId,
      message: 'hi',
      timestamp,
      nonce,
    }
    const connection = await app.request(new Request('http://localhost/network/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': buyer.apiKey },
      body: JSON.stringify({ ...payload, signature: signPayload(payload, buyerKeys.privateKey) }),
    }))
    assert.equal(connection.status, 403)
    assert.equal((await connection.json() as { errorCode: string }).errorCode, 'AGENT_SUSPENDED')
  } finally {
    db.close()
  }
})

test('person import upserts by email and only accepts an active supervisor', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'people-test-secret'
    const app = createApp(db)
    const apiKey = await createVerifiedOrg(app, db)
    const created = await app.request(new Request('http://localhost/orgs/coppen/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        email: 'clara@coppen.de',
        displayName: 'Clara',
        role: 'Einkauf',
        publicKey: publicKeyOf().publicKey,
        rights: { actions: ['order'], order: { maxAmount: '100.00', currency: 'EUR' } },
      }),
    }))
    assert.equal(created.status, 201)
    const personId = (await created.json() as { person: { id: string; publicKey: string | null } }).person.id
    const imported = await app.request(new Request('http://localhost/orgs/coppen/people/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        source: 'personio',
        people: [{
          externalId: 'p-clara',
          email: 'clara@coppen.de',
          displayName: 'Clara',
          role: 'Einkauf',
          status: 'active',
          rights: { actions: [] },
        }],
      }),
    }))
    assert.equal(imported.status, 200)
    const stored = db.prepare('SELECT rights_json, external_id FROM persons WHERE id = ?').get(personId) as { rights_json: string; external_id: string }
    assert.equal(stored.external_id, 'p-clara')
    assert.equal(stored.rights_json, JSON.stringify({ actions: [] }))

    const replacement = publicKeyOf()
    const patched = await app.request(new Request(`http://localhost/orgs/coppen/people/${personId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ publicKey: replacement.publicKey }),
    }))
    assert.equal(patched.status, 200)
    const patchedPerson = (await patched.json() as { person: { publicKey: string; kycStatus: string } }).person
    assert.equal(patchedPerson.publicKey, replacement.publicKey)
    assert.equal(patchedPerson.kycStatus, 'pending')

    const inactive = await app.request(new Request('http://localhost/orgs/coppen/people/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        source: 'personio',
        people: [
          { externalId: 'p-clara', email: 'clara@coppen.de', displayName: 'Clara', role: 'Einkauf', status: 'offboarded' },
          { externalId: 'p-new', email: 'new@coppen.de', displayName: 'Neu', role: 'Einkauf', status: 'active', supervisorExternalId: 'p-clara' },
        ],
      }),
    }))
    assert.equal(inactive.status, 400)
    assert.equal((await inactive.json() as { errorCode: string }).errorCode, 'INVALID_IMPORT')
  } finally {
    db.close()
  }
})

test('people routes check the org key before verification and never answer 404 for a key problem', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'people-test-secret'
    const app = createApp(db)
    const claimed = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.51' },
      body: JSON.stringify({ name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }),
    }))
    assert.equal(claimed.status, 201)
    const claim = await claimed.json() as { apiKey: string; name: string; verified: boolean }
    assert.equal(claim.name, 'coppen--de')
    assert.equal(claim.verified, false)

    const other = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.52' },
      body: JSON.stringify({ name: 'example', displayName: 'Example', domain: 'example.org' }),
    }))
    assert.equal(other.status, 201)
    const otherKey = (await other.json() as { apiKey: string }).apiKey

    const person = (key?: string, path = 'coppen') => app.request(new Request(`http://localhost/orgs/${path}/people`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
      body: JSON.stringify({
        email: 'clara@coppen.de',
        displayName: 'Clara',
        role: 'Vertrieb',
        publicKey: publicKeyOf().publicKey,
      }),
    }))

    for (const path of ['coppen', 'coppen--de']) {
      const unverified = await person(claim.apiKey, path)
      assert.equal(unverified.status, 403, path)
      assert.equal((await unverified.json() as { errorCode: string }).errorCode, 'ORG_VERIFICATION_REQUIRED')
    }

    const missing = await person(undefined)
    assert.equal(missing.status, 401)
    const wrong = await person('beam_org_wrong')
    assert.equal(wrong.status, 401)
    const unknownOrg = await person('beam_org_wrong', 'does-not-exist')
    assert.equal(unknownOrg.status, 401)
    const foreign = await person(otherKey)
    assert.equal(foreign.status, 403)
    assert.equal((await foreign.json() as { errorCode: string }).errorCode, 'FORBIDDEN')

    assert.equal(markOrgVerified(db, claim.name)?.name, 'coppen')
    const created = await person(claim.apiKey)
    assert.equal(created.status, 201)
    const listed = await app.request(new Request('http://localhost/orgs/coppen/people', {
      headers: { 'x-api-key': claim.apiKey },
    }))
    assert.equal(listed.status, 200)
    assert.equal((await listed.json() as { total: number }).total, 1)
    const foreignAfterVerify = await person(otherKey)
    assert.equal(foreignAfterVerify.status, 403)
  } finally {
    db.close()
  }
})
