import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import test from 'node:test'
import { createAgentApiKey, hashApiKey } from './api-key.js'
import { signPayload } from './crypto.js'
import { createDatabase, registerAgent } from './db.js'
import { createApp } from './server.js'
import type { BeamIdentityKind } from './types.js'

type TestIdentity = {
  beamId: string
  apiKey: string
  privateKey: KeyObject
}

function createIdentity(
  db: ReturnType<typeof createDatabase>,
  input: {
    beamId: string
    displayName: string
    identityKind: BeamIdentityKind
    visibility?: 'public' | 'unlisted'
    org?: string | null
  },
): TestIdentity {
  const keys = generateKeyPairSync('ed25519')
  const apiKey = createAgentApiKey(input.beamId)
  const isPerson = input.identityKind === 'person'
  registerAgent(db, {
    beamId: input.beamId,
    displayName: input.displayName,
    capabilities: ['identity.network'],
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    apiKeyHash: hashApiKey(apiKey),
    identityKind: input.identityKind,
    personal: isPerson,
    org: input.org ?? (isPerson ? 'personal' : null),
    email: isPerson ? `${input.beamId.split('@')[0]}@example.com` : null,
    emailVerified: isPerson,
    verificationTier: isPerson ? 'basic' : 'business',
    visibility: input.visibility ?? 'unlisted',
  })

  return { beamId: input.beamId, apiKey, privateKey: keys.privateKey }
}

function authHeaders(identity: TestIdentity): Record<string, string> {
  return {
    authorization: `Bearer ${identity.apiKey}`,
    'content-type': 'application/json',
  }
}

function signedRequestBody(
  requester: TestIdentity,
  recipientBeamId: string,
  message: string,
  nonce = randomUUID(),
): Record<string, string> {
  const timestamp = new Date().toISOString()
  const payload = {
    type: 'network.connection.request',
    requesterBeamId: requester.beamId,
    recipientBeamId,
    message,
    timestamp,
    nonce,
  }
  return { ...payload, signature: signPayload(payload, requester.privateKey) }
}

function signedResponseBody(
  actor: TestIdentity,
  connectionId: string,
  decision: 'accepted' | 'declined' | 'blocked',
): Record<string, string> {
  const timestamp = new Date().toISOString()
  const nonce = randomUUID()
  const payload = {
    type: 'network.connection.respond',
    connectionId,
    actorBeamId: actor.beamId,
    decision,
    timestamp,
    nonce,
  }
  return { ...payload, signature: signPayload(payload, actor.privateKey) }
}

function signedRemoveBody(actor: TestIdentity, connectionId: string): Record<string, string> {
  const timestamp = new Date().toISOString()
  const nonce = randomUUID()
  const payload = {
    type: 'network.connection.remove',
    connectionId,
    actorBeamId: actor.beamId,
    timestamp,
    nonce,
  }
  return { ...payload, signature: signPayload(payload, actor.privateKey) }
}

test('Beam network completes a private signed contact handshake without leaking private identity data', async () => {
  const db = createDatabase(':memory:')
  const app = createApp(db)
  const ada = createIdentity(db, {
    beamId: 'ada@beam.directory',
    displayName: 'Ada Lovelace',
    identityKind: 'person',
  })
  const grace = createIdentity(db, {
    beamId: 'grace@beam.directory',
    displayName: 'Grace Hopper',
    identityKind: 'person',
  })

  try {
    const unauthorized = await app.request('http://localhost/network/me')
    assert.equal(unauthorized.status, 401)

    const hiddenFuzzy = await app.request('http://localhost/network/discover?q=grace', {
      headers: authHeaders(ada),
    })
    assert.equal(hiddenFuzzy.status, 200)
    assert.equal(((await hiddenFuzzy.json()) as { total: number }).total, 0)

    const exact = await app.request(`http://localhost/network/discover?q=${encodeURIComponent(grace.beamId)}`, {
      headers: authHeaders(ada),
    })
    assert.equal(exact.status, 200)
    const exactBody = await exact.json() as {
      results: Array<{ identity: Record<string, unknown>; connection: unknown }>
    }
    assert.equal(exactBody.results.length, 1)
    assert.equal(exactBody.results[0]?.identity['beamId'], grace.beamId)
    assert.equal(exactBody.results[0]?.identity['assurance'], 'email')
    assert.equal('email' in (exactBody.results[0]?.identity ?? {}), false)
    assert.equal('publicKey' in (exactBody.results[0]?.identity ?? {}), false)

    const requestBody = signedRequestBody(ada, grace.beamId, 'Let us connect.')
    const requested = await app.request('http://localhost/network/connections', {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(requestBody),
    })
    assert.equal(requested.status, 201)
    const requestedBody = await requested.json() as {
      connection: { connectionId: string; status: string; direction: string; relationshipType: string }
    }
    assert.equal(requestedBody.connection.status, 'pending')
    assert.equal(requestedBody.connection.direction, 'outbound')
    assert.equal(requestedBody.connection.relationshipType, 'C2C')

    const replay = await app.request('http://localhost/network/connections', {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify(requestBody),
    })
    assert.equal(replay.status, 409)
    assert.equal((await replay.json() as { errorCode: string }).errorCode, 'NONCE_REPLAY')

    const inbound = await app.request('http://localhost/network/connections', {
      headers: authHeaders(grace),
    })
    assert.equal(inbound.status, 200)
    const inboundBody = await inbound.json() as {
      connections: Array<{ direction: string; counterpart: { beamId: string } }>
    }
    assert.equal(inboundBody.connections[0]?.direction, 'inbound')
    assert.equal(inboundBody.connections[0]?.counterpart.beamId, ada.beamId)

    const foreignResponse = await app.request(
      `http://localhost/network/connections/${requestedBody.connection.connectionId}/respond`,
      {
        method: 'POST',
        headers: authHeaders(ada),
        body: JSON.stringify(signedResponseBody(ada, requestedBody.connection.connectionId, 'accepted')),
      },
    )
    assert.equal(foreignResponse.status, 404)

    const accepted = await app.request(
      `http://localhost/network/connections/${requestedBody.connection.connectionId}/respond`,
      {
        method: 'POST',
        headers: authHeaders(grace),
        body: JSON.stringify(signedResponseBody(grace, requestedBody.connection.connectionId, 'accepted')),
      },
    )
    assert.equal(accepted.status, 200)
    assert.equal((await accepted.json() as { connection: { status: string } }).connection.status, 'accepted')

    const contacts = await app.request('http://localhost/network/connections', {
      headers: authHeaders(ada),
    })
    const contactsBody = await contacts.json() as {
      connections: Array<{ status: string; counterpart: { beamId: string } }>
    }
    assert.equal(contactsBody.connections[0]?.status, 'accepted')
    assert.equal(contactsBody.connections[0]?.counterpart.beamId, grace.beamId)

    const removed = await app.request(
      `http://localhost/network/connections/${requestedBody.connection.connectionId}`,
      {
        method: 'DELETE',
        headers: authHeaders(grace),
        body: JSON.stringify(signedRemoveBody(grace, requestedBody.connection.connectionId)),
      },
    )
    assert.equal(removed.status, 200)
    assert.equal((await removed.json() as { connection: { status: string } }).connection.status, 'cancelled')
  } finally {
    db.close()
  }
})

test('Beam network classifies C2C, C2B, B2C, and B2B relationships from verified principals', async () => {
  const db = createDatabase(':memory:')
  const app = createApp(db)
  const personOne = createIdentity(db, {
    beamId: 'person-one@beam.directory',
    displayName: 'Person One',
    identityKind: 'person',
  })
  const personTwo = createIdentity(db, {
    beamId: 'person-two@beam.directory',
    displayName: 'Person Two',
    identityKind: 'person',
  })
  const company = createIdentity(db, {
    beamId: 'company@northstar.beam.directory',
    displayName: 'Northstar',
    identityKind: 'organization',
    org: 'northstar',
  })
  const agent = createIdentity(db, {
    beamId: 'concierge@northstar.beam.directory',
    displayName: 'Northstar Concierge',
    identityKind: 'agent',
    org: 'northstar',
  })
  const service = createIdentity(db, {
    beamId: 'procurement@orbit.beam.directory',
    displayName: 'Orbit Procurement',
    identityKind: 'service',
    org: 'orbit',
  })

  async function requestType(
    requester: TestIdentity,
    recipient: TestIdentity,
    expected: 'C2C' | 'C2B' | 'B2C' | 'B2B',
  ): Promise<void> {
    const response = await app.request('http://localhost/network/connections', {
      method: 'POST',
      headers: authHeaders(requester),
      body: JSON.stringify(signedRequestBody(requester, recipient.beamId, 'Verified hello')),
    })
    assert.equal(response.status, 201)
    const body = await response.json() as { connection: { relationshipType: string } }
    assert.equal(body.connection.relationshipType, expected)
  }

  try {
    await requestType(personOne, personTwo, 'C2C')
    await requestType(personOne, company, 'C2B')
    await requestType(agent, personTwo, 'B2C')
    await requestType(agent, service, 'B2B')
  } finally {
    db.close()
  }
})
