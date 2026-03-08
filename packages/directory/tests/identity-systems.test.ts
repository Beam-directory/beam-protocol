import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createDatabase, getAgent, registerAgent } from '../src/db.js'
import { agentKeysRouter, revokedKeysRouter } from '../src/routes/keys.js'
import { verificationRouter } from '../src/routes/verify.js'
import { delegationsRouter } from '../src/routes/delegations.js'
import { reportsRouter } from '../src/routes/reports.js'
import { canActOnBehalf } from '../src/websocket.js'

function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey,
  }
}

function signPayload(privateKey: ReturnType<typeof generateIdentity>['privateKey'], payload: string): string {
  return sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64')
}

function createTestApp(db: ReturnType<typeof createDatabase>, resolver?: (hostname: string) => Promise<string[][]>) {
  const app = new Hono()
  app.route('/agents', verificationRouter(db, resolver as never))
  app.route('/agents', agentKeysRouter(db))
  app.route('/agents', delegationsRouter(db))
  app.route('/agents', reportsRouter(db))
  app.route('/keys', revokedKeysRouter(db))
  return app
}

async function jsonRequest(app: Hono, path: string, init?: RequestInit) {
  const response = await app.request(`http://localhost${path}`, init)
  const body = await response.json()
  return { response, body }
}

describe('directory identity and verification routes', () => {
  let db: ReturnType<typeof createDatabase>

  beforeEach(() => {
    db = createDatabase(':memory:')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    db.close()
  })

  it('verifies domains and applies the verification tier trust boost', async () => {
    const identity = generateIdentity()
    const beamId = 'alpha@acme.beam.directory'
    registerAgent(db, {
      beamId,
      displayName: 'Alpha',
      capabilities: ['agent.introduce'],
      publicKey: identity.publicKey,
      org: 'acme',
    })

    let expectedTxtValue = ''
    const app = createTestApp(db, async () => [[expectedTxtValue]])

    const created = await jsonRequest(app, `/agents/${encodeURIComponent(beamId)}/verify/domain`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com' }),
    })

    expect(created.response.status).toBe(201)
    expectedTxtValue = created.body.dnsRecord.value
    expect(created.body.dnsRecord.name).toBe('_beam-verify.example.com')

    const checked = await jsonRequest(app, `/agents/${encodeURIComponent(beamId)}/verify/domain/check`)
    expect(checked.response.status).toBe(200)
    expect(checked.body.verified).toBe(true)
    expect(checked.body.agent.verificationTier).toBe('verified')
    expect(checked.body.agent.trust_score).toBe(0.7)
  })

  it('rotates agent keys and exposes revoked keys', async () => {
    const oldIdentity = generateIdentity()
    const newIdentity = generateIdentity()
    const beamId = 'rotator@acme.beam.directory'
    registerAgent(db, {
      beamId,
      displayName: 'Rotator',
      capabilities: ['agent.introduce'],
      publicKey: oldIdentity.publicKey,
      org: 'acme',
    })

    const app = createTestApp(db)
    const rotationProof = signPayload(oldIdentity.privateKey, newIdentity.publicKey)

    const rotated = await jsonRequest(app, `/agents/${encodeURIComponent(beamId)}/keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        new_public_key: newIdentity.publicKey,
        rotation_proof: rotationProof,
      }),
    })

    expect(rotated.response.status).toBe(200)
    expect(rotated.body.agent.public_key).toBe(newIdentity.publicKey)

    const revoked = await jsonRequest(app, '/keys/revoked')
    expect(revoked.response.status).toBe(200)
    expect(revoked.body.total).toBe(1)
    expect(revoked.body.keys[0].beamId).toBe(beamId)
    expect(revoked.body.keys[0].publicKey).toBe(oldIdentity.publicKey)
  })

  it('creates, lists, enforces, and revokes delegations', async () => {
    const grantorIdentity = generateIdentity()
    const granteeIdentity = generateIdentity()
    const grantorBeamId = 'grantor@acme.beam.directory'
    const granteeBeamId = 'grantee@acme.beam.directory'

    registerAgent(db, {
      beamId: grantorBeamId,
      displayName: 'Grantor',
      capabilities: ['system.broadcast'],
      publicKey: grantorIdentity.publicKey,
      org: 'acme',
    })
    registerAgent(db, {
      beamId: granteeBeamId,
      displayName: 'Grantee',
      capabilities: ['system.broadcast'],
      publicKey: granteeIdentity.publicKey,
      org: 'acme',
    })

    const app = createTestApp(db)
    const expiresAt = Date.now() + 60_000
    const createPayload = JSON.stringify({
      type: 'delegation',
      grantor_beam_id: grantorBeamId,
      grantee_beam_id: granteeBeamId,
      scope: 'system.broadcast',
      expires_at: expiresAt,
    })

    const created = await jsonRequest(app, `/agents/${encodeURIComponent(grantorBeamId)}/delegate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grantee_beam_id: granteeBeamId,
        scope: 'system.broadcast',
        expires_at: expiresAt,
        signature: signPayload(grantorIdentity.privateKey, createPayload),
      }),
    })

    expect(created.response.status).toBe(201)
    expect(created.body.granteeBeamId).toBe(granteeBeamId)

    const listed = await jsonRequest(app, `/agents/${encodeURIComponent(grantorBeamId)}/delegations`)
    expect(listed.response.status).toBe(200)
    expect(listed.body.total).toBe(1)
    expect(canActOnBehalf(db, granteeBeamId, grantorBeamId, 'system.broadcast')).toBe(true)

    const revokePayload = JSON.stringify({
      type: 'delegation-revoke',
      grantor_beam_id: grantorBeamId,
      delegation_id: created.body.id,
    })

    const revoked = await jsonRequest(app, `/agents/${encodeURIComponent(grantorBeamId)}/delegations/${created.body.id}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        signature: signPayload(grantorIdentity.privateKey, revokePayload),
      }),
    })

    expect(revoked.response.status).toBe(200)
    expect(canActOnBehalf(db, granteeBeamId, grantorBeamId, 'system.broadcast')).toBe(false)
  })

  it('accepts reports, blocks duplicates, and flags agents after five pending reports', async () => {
    vi.stubEnv('BEAM_ADMIN_KEY', 'secret-admin')

    const targetIdentity = generateIdentity()
    const targetBeamId = 'target@acme.beam.directory'
    registerAgent(db, {
      beamId: targetBeamId,
      displayName: 'Target',
      capabilities: ['agent.introduce'],
      publicKey: targetIdentity.publicKey,
      org: 'acme',
    })

    const reporters = Array.from({ length: 5 }, (_, index) => {
      const identity = generateIdentity()
      const beamId = `reporter${index + 1}@acme.beam.directory`
      registerAgent(db, {
        beamId,
        displayName: `Reporter ${index + 1}`,
        capabilities: ['agent.introduce'],
        publicKey: identity.publicKey,
        org: 'acme',
      })
      return beamId
    })

    const app = createTestApp(db)

    const first = await jsonRequest(app, `/agents/${encodeURIComponent(targetBeamId)}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reporter_beam_id: reporters[0], reason: 'spam' }),
    })
    expect(first.response.status).toBe(201)
    expect(first.body.pendingReports).toBe(1)

    const duplicate = await jsonRequest(app, `/agents/${encodeURIComponent(targetBeamId)}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reporter_beam_id: reporters[0], reason: 'spam again' }),
    })
    expect(duplicate.response.status).toBe(409)

    for (const reporterBeamId of reporters.slice(1)) {
      const result = await jsonRequest(app, `/agents/${encodeURIComponent(targetBeamId)}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reporter_beam_id: reporterBeamId, reason: 'malicious behavior' }),
      })
      expect(result.response.status).toBe(201)
    }

    const target = getAgent(db, targetBeamId)
    expect(target?.flagged).toBe(1)
    expect(target?.trust_score).toBe(0)

    const listed = await jsonRequest(app, `/agents/${encodeURIComponent(targetBeamId)}/reports`, {
      headers: { 'x-admin-key': 'secret-admin' },
    })
    expect(listed.response.status).toBe(200)
    expect(listed.body.total).toBe(5)
  })
})
