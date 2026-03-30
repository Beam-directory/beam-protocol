import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createAdminSession } from '../src/admin-auth.js'
import { createDatabase, getAgent, registerAgent, assignDirectoryRole } from '../src/db.js'
import { canonicalizeJson } from '../src/crypto.js'
import { getLocalDirectoryUrl } from '../src/federation.js'
import { agentsRouter } from '../src/routes/agents.js'
import { didRouter } from '../src/routes/did.js'
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

function signCanonicalPayload(
  privateKey: ReturnType<typeof generateIdentity>['privateKey'],
  payload: Record<string, unknown>,
): string {
  return sign(null, Buffer.from(canonicalizeJson(payload), 'utf8'), privateKey).toString('base64')
}

function createTestApp(db: ReturnType<typeof createDatabase>, resolver?: (hostname: string) => Promise<string[][]>) {
  const app = new Hono()
  app.route('/agents', agentsRouter(db))
  app.route('/agents', verificationRouter(db, resolver as never))
  app.route('/agents', agentKeysRouter(db))
  app.route('/agents', delegationsRouter(db))
  app.route('/agents', reportsRouter(db))
  app.route('/agents', didRouter(db))
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
    expect(checked.body.agent.trust_score).toBe(1)
  })

  it('rotates agent keys, exposes key state, and keeps revoked keys in DID resolution', async () => {
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
    expect(rotated.body.keyState.active.publicKey).toBe(newIdentity.publicKey)
    expect(rotated.body.keyState.revoked[0].publicKey).toBe(oldIdentity.publicKey)

    const listed = await jsonRequest(app, `/agents/${encodeURIComponent(beamId)}/keys`)
    expect(listed.response.status).toBe(200)
    expect(listed.body.keyState.active.publicKey).toBe(newIdentity.publicKey)
    expect(listed.body.keyState.revoked).toHaveLength(1)

    const lookup = await jsonRequest(app, `/agents/${encodeURIComponent(beamId)}`)
    expect(lookup.response.status).toBe(200)
    expect(lookup.body.keyState.active.publicKey).toBe(newIdentity.publicKey)
    expect(lookup.body.keyState.revoked[0].publicKey).toBe(oldIdentity.publicKey)

    const revokePayload = {
      action: 'keys.revoke',
      beamId,
      publicKey: oldIdentity.publicKey,
      timestamp: new Date().toISOString(),
    }
    const revokedResponse = await jsonRequest(app, `/agents/${encodeURIComponent(beamId)}/keys/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        public_key: oldIdentity.publicKey,
        timestamp: revokePayload.timestamp,
        signature: signCanonicalPayload(newIdentity.privateKey, revokePayload),
      }),
    })
    expect(revokedResponse.response.status).toBe(409)

    const did = await app.request(`http://localhost/agents/did/${encodeURIComponent('did:beam:acme:rotator')}`)
    const didBody = await did.json() as { verificationMethod: Array<{ publicKeyMultibase: string; beamStatus?: string }> }
    expect(did.status).toBe(200)
    expect(didBody.verificationMethod).toHaveLength(2)
    expect(didBody.verificationMethod.some((entry) => entry.beamStatus === 'active')).toBe(true)
    expect(didBody.verificationMethod.some((entry) => entry.beamStatus === 'revoked')).toBe(true)

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
    vi.stubEnv('JWT_SECRET', 'secret-admin-jwt')

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

    assignDirectoryRole(db, {
      userId: 'ops@example.com',
      role: 'admin',
      directoryUrl: getLocalDirectoryUrl(),
    })
    const adminSession = createAdminSession(db, {
      email: 'ops@example.com',
      role: 'admin',
    })

    const listed = await jsonRequest(app, `/agents/${encodeURIComponent(targetBeamId)}/reports`, {
      headers: { Authorization: `Bearer ${adminSession.token}` },
    })
    expect(listed.response.status).toBe(200)
    expect(listed.body.total).toBe(5)
  })
})
