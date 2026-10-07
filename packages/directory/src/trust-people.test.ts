import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { createAdminSession } from './admin-auth.js'
import { assignDirectoryRole, createDatabase, getAgent, markOrgVerified } from './db.js'
import { signPayload } from './crypto.js'
import { getLocalDirectoryUrl } from './federation.js'
import { createApp } from './server.js'

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
  } finally {
    db.close()
  }
})
