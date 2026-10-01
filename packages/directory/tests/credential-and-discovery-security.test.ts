import { generateKeyPairSync } from 'node:crypto'
import { publicKeyBase64ToMultibase, signPayload } from '../src/crypto.js'
import { issueEmailVC, verifyCredential, type VerifiableCredential } from '../src/credentials.js'
import { getDirectoryIssuerDid } from '../src/issuer.js'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/email.js', () => ({
  sendAgentVerificationEmail: vi.fn(async () => true),
  sendIdentityClaimEmail: vi.fn(async () => true),
}))

import { createAdminSession } from '../src/admin-auth.js'
import {
  assignDirectoryRole,
  createBusinessVerification,
  createDatabase,
  createDomainVerification,
  updateDomainVerificationStatus,
} from '../src/db.js'
import { getLocalDirectoryUrl } from '../src/federation.js'
import { createApp } from '../src/server.js'

function publicKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
}

function assertNoCredential(body: Record<string, unknown>) {
  expect(body).not.toHaveProperty('credentialSubject')
  expect(body).not.toHaveProperty('proof')
  expect(body['type']).not.toEqual(expect.arrayContaining(['VerifiableCredential']))
}

async function registerAgent(
  app: ReturnType<typeof createApp>,
  input: {
    beamId: string
    email?: string
    visibility?: 'public' | 'unlisted'
    displayName?: string
  },
) {
  const response = await app.request('http://localhost/agents/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      beamId: input.beamId,
      displayName: input.displayName ?? input.beamId.split('@')[0],
      capabilities: ['chat'],
      publicKey: publicKey(),
      email: input.email,
      visibility: input.visibility,
    }),
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<Record<string, unknown> & { apiKey: string }>
}

function issueAdmin(db: Database, email: string, role: 'admin' | 'viewer') {
  assignDirectoryRole(db, {
    userId: email,
    role,
    directoryUrl: getLocalDirectoryUrl(),
  })
  return createAdminSession(db, { email, role }).token
}

describe('credential issuance and public discovery', () => {
  let db: Database
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', 'credential-test-secret')
    db = createDatabase(':memory:')
    app = createApp(db)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    db.close()
  })

  it('rejects unauthenticated verified credential issuance', async () => {
    const owner = await registerAgent(app, {
      beamId: 'owner@beam.directory',
      email: 'owner@example.com',
    })
    const intruderKey = (await registerAgent(app, {
      beamId: 'intruder@beam.directory',
      email: 'intruder@example.com',
    })).apiKey

    for (const [path, body] of [
      ['/agents/email', { beamId: 'owner@beam.directory', email: 'owner@example.com' }],
      ['/agents/domain', { beamId: 'owner@beam.directory', domain: 'example.com' }],
      ['/agents/business', { beamId: 'owner@beam.directory', businessInfo: { country: 'DE', registrationNumber: 'HRB 1', legalName: 'Owner GmbH' } }],
    ] as const) {
      const anonymous = await app.request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(anonymous.status).toBe(401)
      assertNoCredential(await anonymous.json() as Record<string, unknown>)

      const otherOwner = await app.request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': intruderKey },
        body: JSON.stringify(body),
      })
      expect(otherOwner.status).toBe(401)
      assertNoCredential(await otherOwner.json() as Record<string, unknown>)
    }

    const viewerToken = issueAdmin(db, 'viewer@example.com', 'viewer')
    const viewer = await app.request('http://localhost/agents/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({ beamId: 'owner@beam.directory', email: 'owner@example.com' }),
    })
    expect(viewer.status).toBe(401)
    assertNoCredential(await viewer.json() as Record<string, unknown>)
    expect(owner.apiKey).toBeTruthy()
  })

  it('issues an email credential only after the owner proves the address', async () => {
    const beamId = 'mail@beam.directory'
    const email = 'mail.owner@example.com'
    const registered = await registerAgent(app, { beamId, email })
    const headers = {
      'content-type': 'application/json',
      'x-api-key': registered.apiKey,
    }
    const requestBody = { beamId, email }

    const before = await app.request('http://localhost/agents/email', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    })
    expect(before.status).toBe(409)
    expect((await before.json() as { errorCode: string }).errorCode).toBe('VERIFICATION_REQUIRED')

    const adminToken = issueAdmin(db, 'ops@example.com', 'admin')
    const adminBefore = await app.request('http://localhost/agents/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(requestBody),
    })
    expect(adminBefore.status).toBe(409)

    const tokenRow = db.prepare('SELECT token FROM verification_tokens WHERE beam_id = ?').get(beamId) as { token: string }
    const verified = await app.request(`http://localhost/agents/verify-email?token=${tokenRow.token}`)
    expect(verified.status).toBe(200)

    const wrongAddress = await app.request('http://localhost/agents/email', {
      method: 'POST',
      headers,
      body: JSON.stringify({ beamId, email: 'someone-else@example.com' }),
    })
    expect(wrongAddress.status).toBe(409)
    assertNoCredential(await wrongAddress.json() as Record<string, unknown>)

    const anonymous = await app.request('http://localhost/agents/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    expect(anonymous.status).toBe(401)

    const issued = await app.request('http://localhost/agents/email', {
      method: 'POST',
      headers,
      body: JSON.stringify({ beamId, email: 'Mail.Owner@example.com' }),
    })
    expect(issued.status).toBe(201)
    const credential = await issued.json() as VerifiableCredential
    expect(credential.credentialSubject.verified).toBe(true)
    expect(credential.credentialSubject.email).toBe(email)
    expect(credential.credentialSubject.id).toContain('did:beam:')
    expect(verifyCredential(credential)).toBe(true)

    const adminIssued = await app.request('http://localhost/agents/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(requestBody),
    })
    expect(adminIssued.status).toBe(201)
    expect((await adminIssued.json() as VerifiableCredential).credentialSubject.email).toBe(email)
  })

  it('issues domain and business credentials only for checks that already passed', async () => {
    const beamId = 'company@beam.directory'
    const registered = await registerAgent(app, { beamId, email: 'company@example.com' })
    const headers = {
      'content-type': 'application/json',
      'x-api-key': registered.apiKey,
    }

    const domainBefore = await app.request('http://localhost/agents/domain', {
      method: 'POST',
      headers,
      body: JSON.stringify({ beamId, domain: 'https://Acme.example/' }),
    })
    expect(domainBefore.status).toBe(409)

    const pending = createDomainVerification(db, {
      beamId,
      domain: 'acme.example',
      challengeToken: 'dns-challenge',
    })
    const stillPending = await app.request('http://localhost/agents/domain', {
      method: 'POST',
      headers,
      body: JSON.stringify({ beamId, domain: 'acme.example' }),
    })
    expect(stillPending.status).toBe(409)

    updateDomainVerificationStatus(db, pending.id, 'verified')
    const domainIssued = await app.request('http://localhost/agents/domain', {
      method: 'POST',
      headers,
      body: JSON.stringify({ beamId, domain: 'https://Acme.example/' }),
    })
    expect(domainIssued.status).toBe(201)
    const domainCredential = await domainIssued.json() as VerifiableCredential
    expect(domainCredential.credentialSubject.verified).toBe(true)
    expect(domainCredential.credentialSubject.domain).toBe('acme.example')
    expect(verifyCredential(domainCredential)).toBe(true)

    const businessBefore = await app.request('http://localhost/agents/business', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        beamId,
        businessInfo: { country: 'DE', registrationNumber: 'HRB 123', legalName: 'Acme GmbH' },
      }),
    })
    expect(businessBefore.status).toBe(409)

    createBusinessVerification(db, {
      beamId,
      country: 'DE',
      registrationNumber: 'HRB 123',
      legalName: 'Acme GmbH',
      status: 'verified',
      verificationSource: 'manual-registry-review',
      sourceReference: 'HRB 123',
    })

    const mismatched = await app.request('http://localhost/agents/business', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        beamId,
        businessInfo: { country: 'DE', registrationNumber: 'HRB 123', legalName: 'Other GmbH', ownerEmail: 'hidden@example.com' },
      }),
    })
    expect(mismatched.status).toBe(409)
    assertNoCredential(await mismatched.json() as Record<string, unknown>)

    const businessIssued = await app.request('http://localhost/agents/business', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        beamId,
        businessInfo: {
          country: 'de',
          registrationNumber: 'hrb 123',
          legalName: 'acme gmbh',
          ownerEmail: 'hidden@example.com',
        },
      }),
    })
    expect(businessIssued.status).toBe(201)
    const businessCredential = await businessIssued.json() as VerifiableCredential
    expect(businessCredential.credentialSubject.verified).toBe(true)
    expect(businessCredential.credentialSubject.business).toEqual({
      country: 'DE',
      registrationNumber: 'HRB 123',
      legalName: 'Acme GmbH',
      verificationSource: 'manual-registry-review',
      sourceReference: 'HRB 123',
      verifiedAt: expect.any(String),
    })
    expect(JSON.stringify(businessCredential)).not.toContain('hidden@example.com')
    expect(verifyCredential(businessCredential)).toBe(true)
  })

  it('keeps unlisted identities and email addresses out of public discovery', async () => {
    const hiddenEmail = 'hidden.person@example.com'
    const listedEmail = 'listed.person@example.com'
    const companyEmail = 'company.hidden@example.com'
    const hidden = await registerAgent(app, {
      beamId: 'hidden-person@beam.directory',
      email: hiddenEmail,
      displayName: 'Hidden Person',
    })
    await registerAgent(app, {
      beamId: 'listed-person@beam.directory',
      email: listedEmail,
      visibility: 'public',
      displayName: 'Listed Person',
    })
    await registerAgent(app, {
      beamId: 'warehouse@beam.directory',
      email: companyEmail,
      displayName: 'Warehouse',
    })
    db.prepare(`
      UPDATE agents
      SET personal = 0, org = 'acme', visibility = 'unlisted'
      WHERE beam_id = 'warehouse@beam.directory'
    `).run()

    const search = await app.request('http://localhost/agents/search')
    expect(search.status).toBe(200)
    const searchBody = await search.json() as { agents: Array<Record<string, unknown>>; total: number }
    const searchIds = searchBody.agents.map((agent) => agent['beam_id'])
    expect(searchIds).toEqual(['listed-person@beam.directory'])
    expect(JSON.stringify(searchBody)).not.toContain(hiddenEmail)
    expect(JSON.stringify(searchBody)).not.toContain(listedEmail)
    expect(JSON.stringify(searchBody)).not.toContain(companyEmail)
    expect(searchBody.agents[0]).not.toHaveProperty('email')
    expect(searchBody.agents[0]).not.toHaveProperty('api_key_hash')
    expect(searchBody.agents[0]).not.toHaveProperty('email_token')

    const personalSearch = await app.request('http://localhost/agents/search?org=personal&q=person')
    const personalBody = await personalSearch.json() as { agents: Array<Record<string, unknown>> }
    expect(personalBody.agents.map((agent) => agent['beam_id'])).toEqual(['listed-person@beam.directory'])

    const browse = await app.request('http://localhost/agents/browse?page=1&limit=20')
    expect(browse.status).toBe(200)
    const browseBody = await browse.json() as { agents: Array<Record<string, unknown>>; total: number }
    expect(browseBody.total).toBe(1)
    expect(browseBody.agents.map((agent) => agent['beam_id'])).toEqual(['listed-person@beam.directory'])
    expect(JSON.stringify(browseBody)).not.toContain('@example.com')

    const directory = await app.request('http://localhost/directory/agents')
    expect(directory.status).toBe(200)
    const directoryBody = await directory.json() as { agents: Array<Record<string, unknown>>; listed: number }
    expect(directoryBody.agents.map((agent) => agent['beam_id'])).toEqual(['listed-person@beam.directory'])
    expect(directoryBody.listed).toBe(1)
    expect(JSON.stringify(directoryBody)).not.toContain('@example.com')
    expect(directoryBody.agents[0]).not.toHaveProperty('api_key_hash')
    expect(directoryBody.agents[0]).not.toHaveProperty('email')

    const forcedUnlisted = await app.request('http://localhost/directory/agents?includeUnlisted=true')
    const forcedBody = await forcedUnlisted.json() as { agents: Array<Record<string, unknown>> }
    expect(forcedBody.agents.map((agent) => agent['beam_id'])).toEqual(['listed-person@beam.directory'])

    const viewerToken = issueAdmin(db, 'viewer@example.com', 'viewer')
    const viewerListing = await app.request('http://localhost/directory/agents?includeUnlisted=true', {
      headers: { authorization: `Bearer ${viewerToken}` },
    })
    const viewerBody = await viewerListing.json() as { agents: Array<Record<string, unknown>> }
    expect(viewerBody.agents.map((agent) => agent['beam_id'])).toEqual(['listed-person@beam.directory'])
    expect(JSON.stringify(viewerBody)).not.toContain(hiddenEmail)

    const adminToken = issueAdmin(db, 'ops@example.com', 'admin')
    const adminListing = await app.request('http://localhost/directory/agents?includeUnlisted=true', {
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const adminBody = await adminListing.json() as { agents: Array<Record<string, unknown>> }
    const adminIds = adminBody.agents.map((agent) => agent['beam_id'])
    expect(adminIds).toContain('hidden-person@beam.directory')
    expect(adminIds).toContain('warehouse@beam.directory')
    expect(JSON.stringify(adminBody)).not.toContain(hiddenEmail)
    expect(JSON.stringify(adminBody)).not.toContain('api_key_hash')

    const publicLookup = await app.request('http://localhost/agents/hidden-person%40beam.directory')
    expect(publicLookup.status).toBe(200)
    const publicAgent = await publicLookup.json() as Record<string, unknown>
    expect(publicAgent['beam_id']).toBe('hidden-person@beam.directory')
    expect(publicAgent['visibility']).toBe('unlisted')
    expect(publicAgent).not.toHaveProperty('email')
    expect(JSON.stringify(publicAgent)).not.toContain(hiddenEmail)

    const ownerLookup = await app.request('http://localhost/agents/hidden-person%40beam.directory', {
      headers: { 'x-api-key': hidden.apiKey },
    })
    expect(ownerLookup.status).toBe(200)
    expect((await ownerLookup.json() as Record<string, unknown>)['email']).toBe(hiddenEmail)

    const federation = await app.request('http://localhost/federation/agents/hidden-person%40beam.directory?localOnly=1')
    expect(federation.status).toBe(200)
    const federationBody = await federation.json() as { agent: Record<string, unknown> }
    expect(federationBody.agent['beam_id']).toBe('hidden-person@beam.directory')
    expect(JSON.stringify(federationBody)).not.toContain(hiddenEmail)
    expect(federationBody.agent).not.toHaveProperty('email')
  })

  it('accepts only directory-signed credentials that still match directory state', async () => {
    const { apiKey } = await registerAgent(app, { beamId: 'mail@beam.directory', email: 'mail@example.com' })
    const selfSigned = selfSignedEmailCredential('mail@beam.directory', 'mail@example.com')
    const forged = await app.request('http://localhost/agents/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vc: selfSigned }),
    })
    expect(forged.status).toBe(200)
    expect(await forged.json()).toMatchObject({
      valid: false,
      signatureValid: false,
      current: false,
      errorCode: 'INVALID_SIGNATURE',
    })
    expect(verifyCredential(selfSigned)).toBe(false)

    const mintedEarly = issueEmailVC('mail@beam.directory', 'mail@example.com')
    expect(verifyCredential(mintedEarly)).toBe(true)
    const stale = await app.request('http://localhost/agents/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vc: mintedEarly }),
    })
    expect(await stale.json()).toMatchObject({
      valid: false,
      signatureValid: true,
      current: false,
      errorCode: 'VERIFICATION_NOT_CURRENT',
    })

    const token = db.prepare('SELECT token FROM verification_tokens WHERE beam_id = ?').get('mail@beam.directory') as { token: string }
    const confirmed = await app.request(`http://localhost/agents/verify-email?token=${token.token}`)
    expect(confirmed.status).toBe(200)

    const current = await app.request('http://localhost/agents/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vc: mintedEarly }),
    })
    expect(await current.json()).toEqual({ valid: true, signatureValid: true, current: true })

    const issued = await app.request('http://localhost/agents/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ beamId: 'mail@beam.directory', email: 'mail@example.com' }),
    })
    expect(issued.status).toBe(201)
    const credential = await issued.json() as VerifiableCredential
    const genuine = await app.request('http://localhost/agents/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vc: credential }),
    })
    expect(await genuine.json()).toEqual({ valid: true, signatureValid: true, current: true })

    db.prepare('UPDATE agents SET email_verified = 0 WHERE beam_id = ?').run('mail@beam.directory')
    const revoked = await app.request('http://localhost/agents/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vc: credential }),
    })
    expect(await revoked.json()).toMatchObject({
      valid: false,
      signatureValid: true,
      current: false,
      errorCode: 'VERIFICATION_NOT_CURRENT',
    })
  })
})

function selfSignedEmailCredential(beamId: string, email: string): VerifiableCredential {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyBase64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
  const issuer = getDirectoryIssuerDid()
  const issuanceDate = new Date().toISOString()
  const unsigned = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: 'urn:uuid:self-signed',
    type: ['VerifiableCredential', 'EmailVerificationCredential'],
    issuer,
    issuanceDate,
    credentialSubject: {
      id: `did:beam:${beamId.slice(0, beamId.indexOf('@'))}`,
      email,
      verified: true,
    },
  }
  return {
    ...unsigned,
    proof: {
      type: 'Ed25519Signature2020',
      created: issuanceDate,
      proofPurpose: 'assertionMethod',
      verificationMethod: `${issuer}#key-1`,
      proofValue: signPayload(unsigned, privateKey),
      publicKeyMultibase: publicKeyBase64ToMultibase(publicKeyBase64),
    },
  }
}
