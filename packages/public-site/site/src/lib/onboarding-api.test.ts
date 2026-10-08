import { describe, expect, it, vi } from 'vitest'
import { base64ToBytes, canonicalize, generateAgentIdentity } from './agent-keys'
import {
  CAPABILITIES,
  NotAvailableYet,
  OnboardingApiError,
  checkDomainVerification,
  checkPowerOfRepresentation,
  classifyOrgConflict,
  createOrg,
  describeError,
  getKycStatus,
  getOrg,
  inviteEmployee,
  issueMandate,
  lookupLei,
  registerAgent,
  registerInterest,
  sendContactRequest,
  startKyc,
  submitBusinessRegistration,
  syncEmployeeDirectory,
  verifyDomainByWellKnownFile,
} from './onboarding-api'
import { suggestDisambiguatedOrgName } from './onboarding-steps'
import { de } from '../i18n/de.ts'
import { en } from '../i18n/en.ts'

const BASE = 'https://directory.test'

function mockFetch(status: number, body: unknown) {
  return vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))
}

function call(fetchImpl: ReturnType<typeof mockFetch>, index = 0) {
  const [url, init] = fetchImpl.mock.calls[index] as [string, RequestInit]
  const headers = init.headers as Record<string, string>
  return { url, init, headers, body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined }
}

describe('createOrg', () => {
  it('posts to /orgs and returns the DNS challenge and the one-time org key', async () => {
    const fetchImpl = mockFetch(201, {
      name: 'firma', displayName: 'Firma GmbH', domain: 'firma.de', beamDomain: 'firma.beam.directory', verified: false,
      claimExpiresAt: '2026-10-15T00:00:00.000Z', createdAt: 'x', verifiedAt: null,
      verification: { txtName: '_beam-verification.firma.de', txtValue: 'beam-verification=abc' },
      apiKey: 'beam_org_secret',
    })
    const org = await createOrg({ name: 'firma', displayName: 'Firma GmbH', domain: 'firma.de' }, { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/orgs`)
    expect(sent.init.method).toBe('POST')
    expect(sent.body).toEqual({ name: 'firma', displayName: 'Firma GmbH', domain: 'firma.de' })
    expect(sent.headers.authorization).toBeUndefined()
    expect(org.apiKey).toBe('beam_org_secret')
    expect(org.verification).toEqual({ txtName: '_beam-verification.firma.de', txtValue: 'beam-verification=abc' })
    expect(org.verified).toBe(false)
  })

  it('maps directory error codes to a typed error with a German message', async () => {
    const fetchImpl = mockFetch(403, { error: 'mismatch', errorCode: 'ORG_NAMESPACE_DOMAIN_MISMATCH' })
    const error = await createOrg({ name: 'x', displayName: 'X', domain: 'firma.de' }, { baseUrl: BASE, fetchImpl }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OnboardingApiError)
    expect((error as OnboardingApiError).status).toBe(403)
    expect(describeError(error, de.errors)).toContain('Namensraum muss zum Namen der Domain passen')
    expect(describeError(error, en.errors)).toContain('namespace has to match the domain name')
  })

  it('on 409 name taken suggests label-suffix, and reports the 403 mismatch of the current backend honestly', async () => {
    const taken = mockFetch(409, { error: 'Organization coppen already exists', errorCode: 'ORG_EXISTS' })
    const first = await createOrg({ name: 'coppen', displayName: 'COPPEN', domain: 'coppen.at' }, { baseUrl: BASE, fetchImpl: taken }).catch((err: unknown) => err)
    expect(classifyOrgConflict(first)).toBe('name')
    const suggestion = suggestDisambiguatedOrgName('coppen.at')
    expect(suggestion).toBe('coppen-at')

    const mismatch = mockFetch(403, { error: 'must match', errorCode: 'ORG_NAMESPACE_DOMAIN_MISMATCH' })
    const retry = await createOrg({ name: suggestion ?? '', displayName: 'COPPEN', domain: 'coppen.at' }, { baseUrl: BASE, fetchImpl: mismatch }).catch((err: unknown) => err)
    expect(call(mismatch).body).toMatchObject({ name: 'coppen-at', domain: 'coppen.at' })
    expect(classifyOrgConflict(retry)).toBe('suffix-not-supported')
    expect(retry).toBeInstanceOf(OnboardingApiError)
  })

  it('does not suggest a name when the domain itself is claimed', async () => {
    const fetchImpl = mockFetch(409, { error: 'Domain coppen.at is already claimed', errorCode: 'DOMAIN_EXISTS' })
    const error = await createOrg({ name: 'coppen', displayName: 'COPPEN', domain: 'coppen.at' }, { baseUrl: BASE, fetchImpl }).catch((err: unknown) => err)
    expect(classifyOrgConflict(error)).toBe('domain')
    expect(describeError(error, de.errors)).toContain('bereits einer verifizierten Firma zugeordnet')
  })

  it('reports network failures as NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const error = await createOrg({ name: 'x', displayName: 'X', domain: 'x.de' }, { baseUrl: BASE, fetchImpl }).catch((err: unknown) => err)
    expect((error as OnboardingApiError).code).toBe('NETWORK_ERROR')
  })
})

describe('getOrg and checkDomainVerification', () => {
  it('sends the org key as bearer token', async () => {
    const fetchImpl = mockFetch(200, { org: { name: 'firma', domain: 'firma.de', verified: true }, agents: [], total: 0 })
    const org = await getOrg('firma', 'beam_org_secret', { baseUrl: BASE, fetchImpl })
    expect(call(fetchImpl).url).toBe(`${BASE}/orgs/firma`)
    expect(call(fetchImpl).headers.authorization).toBe('Bearer beam_org_secret')
    expect(org.verified).toBe(true)
  })

  it('treats a 409 TXT_NOT_FOUND as "not verified yet" instead of an error', async () => {
    const fetchImpl = mockFetch(409, {
      verified: false, txtName: '_beam-verification.firma.de', expected: 'beam-verification=abc', records: ['other'], errorCode: 'TXT_NOT_FOUND',
    })
    const result = await checkDomainVerification('firma', 'k', { baseUrl: BASE, fetchImpl })
    expect(call(fetchImpl).url).toBe(`${BASE}/orgs/firma/verify`)
    expect(result).toEqual({ verified: false, expected: 'beam-verification=abc', txtName: '_beam-verification.firma.de', records: ['other'] })
  })

  it('returns the verified org on success', async () => {
    const fetchImpl = mockFetch(200, { verified: true, org: { name: 'firma', domain: 'firma.de', verified: true } })
    const result = await checkDomainVerification('firma', 'k', { baseUrl: BASE, fetchImpl })
    expect(result.verified).toBe(true)
  })

  it('throws for an expired claim', async () => {
    const fetchImpl = mockFetch(410, { error: 'expired', errorCode: 'ORG_CLAIM_EXPIRED' })
    await expect(checkDomainVerification('firma', 'k', { baseUrl: BASE, fetchImpl })).rejects.toMatchObject({ code: 'ORG_CLAIM_EXPIRED' })
  })
})

describe('registerAgent', () => {
  it('sends only public keys and the org key', async () => {
    const fetchImpl = mockFetch(201, { beamId: 'einkauf@firma.beam.directory', displayName: 'Einkauf', org: 'firma', apiKey: 'bk_abc.def', verificationTier: 'basic' })
    const result = await registerAgent({
      beamId: 'einkauf@firma.beam.directory', org: 'firma', displayName: 'Einkauf', publicKey: 'PUB', dhPublicKey: 'DH',
    }, 'beam_org_secret', { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/agents/register`)
    expect(sent.headers.authorization).toBe('Bearer beam_org_secret')
    expect(sent.body).toEqual({ beamId: 'einkauf@firma.beam.directory', org: 'firma', displayName: 'Einkauf', publicKey: 'PUB', dhPublicKey: 'DH', capabilities: [] })
    expect(JSON.stringify(sent.body)).not.toMatch(/private/i)
    expect(result.apiKey).toBe('bk_abc.def')
  })
})

describe('submitBusinessRegistration', () => {
  it('posts the registry data with the agent key and reports a pending review, never verified', async () => {
    const fetchImpl = mockFetch(202, { verified: false, status: 'pending', reviewRequired: true, message: 'Registration format accepted.' })
    const result = await submitBusinessRegistration('einkauf@firma.beam.directory', 'bk_x', {
      country: 'DE', registrationNumber: 'HRB 1234', legalName: 'Firma GmbH',
    }, { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/agents/einkauf%40firma.beam.directory/verify-business`)
    expect(sent.headers.authorization).toBe('Bearer bk_x')
    expect(result).toEqual({ status: 'pending', reviewRequired: true, message: 'Registration format accepted.' })
  })
})

describe('sendContactRequest', () => {
  it('signs the same canonical payload the directory verifies', async () => {
    const identity = await generateAgentIdentity()
    const fetchImpl = mockFetch(201, { connection: { connectionId: 'c1', status: 'pending', recipientBeamId: 'lakis@partner.beam.directory' } })
    const result = await sendContactRequest({
      requesterBeamId: 'einkauf@firma.beam.directory',
      recipientBeamId: ' Lakis@Partner.beam.directory ',
      message: 'Hallo',
      agentApiKey: 'bk_x',
      signingKey: identity.signingKey,
    }, { baseUrl: BASE, fetchImpl })

    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/network/connections`)
    expect(sent.headers.authorization).toBe('Bearer bk_x')
    const body = sent.body as Record<string, string>
    expect(body.type).toBe('network.connection.request')
    expect(body.recipientBeamId).toBe('lakis@partner.beam.directory')
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/)

    // Server side (routes/network.ts): verifyPayload({ ...payload, timestamp, nonce }, signature, publicKey)
    const { signature, ...signed } = body
    const publicKey = await crypto.subtle.importKey('spki', base64ToBytes(identity.publicKey), { name: 'Ed25519' }, false, ['verify'])
    const valid = await crypto.subtle.verify(
      'Ed25519', publicKey, base64ToBytes(signature), new TextEncoder().encode(JSON.stringify(canonicalize(signed))),
    )
    expect(valid).toBe(true)
    expect(result).toEqual({ connectionId: 'c1', status: 'pending', recipientBeamId: 'lakis@partner.beam.directory' })
  })
})

describe('registerInterest', () => {
  it('uses the existing waitlist with a non-seal source', async () => {
    const fetchImpl = mockFetch(201, { ok: true, status: 'registered' })
    await registerInterest({ email: 'A@Firma.de', company: 'Firma', capability: 'startKyc', note: 'bitte' }, { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/waitlist`)
    expect(sent.body).toMatchObject({ email: 'a@firma.de', source: 'onboarding-interest', workflowType: 'onboarding-startKyc', hp_company: '' })
  })
})

describe('unavailable capabilities', () => {
  const pending = [
    ['verifyDomainByWellKnownFile', verifyDomainByWellKnownFile],
    ['lookupLei', lookupLei],
    ['checkPowerOfRepresentation', checkPowerOfRepresentation],
    ['startKyc', startKyc],
    ['getKycStatus', getKycStatus],
    ['syncEmployeeDirectory', syncEmployeeDirectory],
    ['inviteEmployee', inviteEmployee],
    ['issueMandate', issueMandate],
  ] as const

  it.each(pending)('%s throws NotAvailableYet without any request', async (name, fn) => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const error = await fn().catch((err: unknown) => err)
    expect(error).toBeInstanceOf(NotAvailableYet)
    expect((error as NotAvailableYet).capability).toBe(name)
    expect((error as NotAvailableYet).status).toBe('unavailable')
    expect(CAPABILITIES[name]).toBe('unavailable')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
