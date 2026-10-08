import { describe, expect, it, vi } from 'vitest'
import { base64ToBytes, canonicalize, generateAgentIdentity, generateSigningIdentity } from './agent-keys'
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
  registerAgent,
  registerInterest,
  requestManualKyc,
  sendContactRequest,
  startThirdPartyKyc,
  submitOrgRegistry,
  syncEmployeeDirectory,
} from './onboarding-api'
import { mandatePayload } from './onboarding-steps'
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
  it('posts the requested short name and returns the DNS challenge and the one-time org key', async () => {
    const fetchImpl = mockFetch(201, {
      name: 'firma--de', requestedName: 'firma', displayName: 'Firma GmbH', domain: 'firma.de',
      beamDomain: 'firma--de.beam.directory', verified: false,
      claimExpiresAt: '2026-10-15T00:00:00.000Z', createdAt: 'x', verifiedAt: null,
      verification: {
        txtName: '_beam-verification.firma.de',
        txtValue: 'beam-verification=abc',
        wellKnownUrl: 'https://firma.de/.well-known/beam-verification',
        wellKnownBody: 'beam-verification=abc',
      },
      apiKey: 'beam_org_secret',
    })
    const org = await createOrg({ name: 'firma', displayName: 'Firma GmbH', domain: 'firma.de' }, { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/orgs`)
    expect(sent.init.method).toBe('POST')
    expect(sent.body).toEqual({ name: 'firma', displayName: 'Firma GmbH', domain: 'firma.de' })
    expect(sent.headers.authorization).toBeUndefined()
    expect(org.apiKey).toBe('beam_org_secret')
    expect(org.name).toBe('firma--de')
    expect(org.requestedName).toBe('firma')
    expect(org.verification?.wellKnownUrl).toContain('/.well-known/beam-verification')
  })

  it('maps directory error codes to a typed error in both languages', async () => {
    const fetchImpl = mockFetch(403, { error: 'mismatch', errorCode: 'ORG_NAMESPACE_DOMAIN_MISMATCH' })
    const error = await createOrg({ name: 'x', displayName: 'X', domain: 'firma.de' }, { baseUrl: BASE, fetchImpl }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OnboardingApiError)
    expect((error as OnboardingApiError).status).toBe(403)
    expect(describeError(error, de.errors)).toContain('Namensraum muss zum Namen der Domain passen')
    expect(describeError(error, en.errors)).toContain('namespace has to match the domain name')
  })

  it('classifies a taken name separately from a taken domain', async () => {
    const taken = mockFetch(409, { error: 'Organization coppen already exists', errorCode: 'ORG_EXISTS' })
    const first = await createOrg({ name: 'coppen', displayName: 'COPPEN', domain: 'coppen.at' }, { baseUrl: BASE, fetchImpl: taken }).catch((err: unknown) => err)
    expect(classifyOrgConflict(first)).toBe('name')

    const domain = mockFetch(409, { error: 'Domain coppen.at is already claimed', errorCode: 'DOMAIN_EXISTS' })
    const second = await createOrg({ name: 'coppen', displayName: 'COPPEN', domain: 'coppen.at' }, { baseUrl: BASE, fetchImpl: domain }).catch((err: unknown) => err)
    expect(classifyOrgConflict(second)).toBe('domain')
    expect(describeError(second, de.errors)).toContain('bereits einer verifizierten Firma zugeordnet')
  })

  it('reports network failures as NETWORK_ERROR', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const error = await createOrg({ name: 'x', displayName: 'X', domain: 'x.de' }, { baseUrl: BASE, fetchImpl }).catch((err: unknown) => err)
    expect((error as OnboardingApiError).code).toBe('NETWORK_ERROR')
  })
})

describe('domain verification', () => {
  it('sends the org key as bearer token', async () => {
    const fetchImpl = mockFetch(200, { org: { name: 'firma', domain: 'firma.de', verified: true }, agents: [], total: 0 })
    const org = await getOrg('firma', 'beam_org_secret', { baseUrl: BASE, fetchImpl })
    expect(call(fetchImpl).url).toBe(`${BASE}/orgs/firma`)
    expect(call(fetchImpl).headers.authorization).toBe('Bearer beam_org_secret')
    expect(org.verified).toBe(true)
  })

  it('posts method dns and treats TXT_NOT_FOUND as not verified yet', async () => {
    const fetchImpl = mockFetch(409, {
      verified: false, method: 'dns', txtName: '_beam-verification.firma.de', expected: 'beam-verification=abc', records: ['other'], errorCode: 'TXT_NOT_FOUND',
    })
    const result = await checkDomainVerification('firma--de', 'k', 'dns', { baseUrl: BASE, fetchImpl })
    expect(call(fetchImpl).url).toBe(`${BASE}/orgs/firma--de/verify`)
    expect(call(fetchImpl).body).toEqual({ method: 'dns' })
    expect(result.verified).toBe(false)
    if (!result.verified) expect(result.records).toEqual(['other'])
  })

  it('posts method well-known and treats a missing file as not verified yet', async () => {
    const fetchImpl = mockFetch(409, {
      verified: false, method: 'well-known', txtName: '_beam-verification.firma.de',
      wellKnownUrl: 'https://firma.de/.well-known/beam-verification', expected: 'beam-verification=abc', records: [], errorCode: 'WELL_KNOWN_NOT_FOUND',
    })
    const result = await checkDomainVerification('firma--de', 'k', 'well-known', { baseUrl: BASE, fetchImpl })
    expect(call(fetchImpl).body).toEqual({ method: 'well-known' })
    expect(result).toMatchObject({ verified: false, method: 'well-known', errorCode: 'WELL_KNOWN_NOT_FOUND' })
  })

  it('returns the verified org on success', async () => {
    const fetchImpl = mockFetch(200, { verified: true, method: 'dns', org: { name: 'firma', domain: 'firma.de', verified: true, domainVerifiedVia: 'dns' } })
    const result = await checkDomainVerification('firma', 'k', 'dns', { baseUrl: BASE, fetchImpl })
    expect(result.verified).toBe(true)
  })
})

describe('registry, people and agents', () => {
  it('files a register entry on the org and reports pending', async () => {
    const fetchImpl = mockFetch(201, { filing: { id: 1, kind: 'handelsregister', country: 'DE', registrationNumber: 'HRB 123456', status: 'pending', legalName: 'Firma GmbH', applicantName: 'Ada', applicantRole: 'geschaeftsfuehrer' } })
    const result = await submitOrgRegistry('firma', 'beam_org_secret', {
      kind: 'handelsregister', country: 'DE', registrationNumber: 'HRB 123456', registerCourt: 'Amtsgericht Berlin',
      legalName: 'Firma GmbH', applicantName: 'Ada', applicantRole: 'geschaeftsfuehrer',
    }, { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/orgs/firma/registry`)
    expect(sent.headers.authorization).toBe('Bearer beam_org_secret')
    expect(result.status).toBe('pending')
  })

  it('requests manual KYC and never sends a private key', async () => {
    const fetchImpl = mockFetch(200, { person: { id: 'p1', kycStatus: 'pending', kycProvider: 'manual', email: 'ada@firma.de', displayName: 'Ada', role: 'Owner', publicKey: 'PUB', rights: { actions: ['read'] } } })
    const person = await requestManualKyc('firma', 'k', 'p1', { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/orgs/firma/people/p1/kyc`)
    expect(sent.body).toEqual({ provider: 'manual' })
    expect(JSON.stringify(sent.body)).not.toMatch(/private/i)
    expect(person.kycStatus).toBe('pending')
  })

  it('registers an agent on the org route with the public key only', async () => {
    const fetchImpl = mockFetch(201, { beamId: 'einkauf@firma.beam.directory', displayName: 'Einkauf', org: 'firma', apiKey: 'bk_abc.def', responsiblePersonId: 'p1' })
    const result = await registerAgent({
      orgName: 'firma', agentName: 'einkauf', displayName: 'Einkauf', publicKey: 'PUB', responsiblePersonId: 'p1',
    }, 'beam_org_secret', { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/orgs/firma/agents`)
    expect(sent.body).toEqual({
      agentName: 'einkauf', displayName: 'Einkauf', publicKey: 'PUB', responsiblePersonId: 'p1', capabilities: [],
    })
    expect(JSON.stringify(sent.body)).not.toMatch(/private|dhPublic/i)
    expect(result.apiKey).toBe('bk_abc.def')
  })

  it('signs the full mandate payload with the person key and does not send that key', async () => {
    const identity = await generateSigningIdentity()
    const payload = mandatePayload({
      jti: 'mandate01',
      personId: 'p1',
      agentBeamId: 'einkauf@firma.beam.directory',
      org: 'firma',
      scopes: { actions: ['read', 'file.send'] },
      expiresAt: '2026-12-01T00:00:00.000Z',
    })
    const fetchImpl = mockFetch(201, { mandate: { jti: 'mandate01', status: 'active', expiresAt: payload.expiresAt, agentBeamId: payload.agentBeamId } })
    const issued = await issueMandate({ beamId: payload.agentBeamId, payload, signingKey: identity.signingKey }, { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/agents/${encodeURIComponent(payload.agentBeamId)}/mandates`)
    const body = sent.body as Record<string, unknown>
    expect(body.jti).toBe('mandate01')
    expect(body.escalationPersonId).toBeNull()
    expect(JSON.stringify(body)).not.toContain(identity.privateKey)
    const publicKey = await crypto.subtle.importKey('spki', base64ToBytes(identity.publicKey), { name: 'Ed25519' }, false, ['verify'])
    const valid = await crypto.subtle.verify('Ed25519', publicKey, base64ToBytes(String(body.signature)), new TextEncoder().encode(JSON.stringify(canonicalize(payload))))
    expect(valid).toBe(true)
    expect(issued.status).toBe('active')
  })

  it('loads KYC status from the people list', async () => {
    const fetchImpl = mockFetch(200, { people: [{ id: 'p1', kycStatus: 'verified', email: 'a@b.c', displayName: 'A', role: 'Owner', publicKey: 'PUB', rights: { actions: ['read'] } }] })
    const person = await getKycStatus('firma', 'k', 'p1', { baseUrl: BASE, fetchImpl })
    expect(call(fetchImpl).url).toBe(`${BASE}/orgs/firma/people`)
    expect(person?.kycStatus).toBe('verified')
  })

  it('invites an employee without a private key', async () => {
    const fetchImpl = mockFetch(201, { invitationId: 'i1', email: 'sam@firma.de', role: 'Buyer', expiresAt: '2026-11-01T00:00:00.000Z', token: 'once' })
    const invite = await inviteEmployee('firma', 'k', { email: 'Sam@Firma.de', role: 'Buyer', rights: { actions: ['read'] }, supervisorPersonId: 'p1' }, { baseUrl: BASE, fetchImpl })
    expect(call(fetchImpl).url).toBe(`${BASE}/orgs/firma/people/invitations`)
    expect(call(fetchImpl).body).toMatchObject({ email: 'sam@firma.de', supervisorPersonId: 'p1' })
    expect(invite.token).toBe('once')
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
    expect(JSON.stringify(body)).not.toContain(identity.privateKey)

    const { signature, ...signed } = body
    const publicKey = await crypto.subtle.importKey('spki', base64ToBytes(identity.publicKey), { name: 'Ed25519' }, false, ['verify'])
    const valid = await crypto.subtle.verify(
      'Ed25519', publicKey, base64ToBytes(signature), new TextEncoder().encode(JSON.stringify(canonicalize(signed))),
    )
    expect(valid).toBe(true)
    expect(result).toEqual({ connectionId: 'c1', status: 'pending', recipientBeamId: 'lakis@partner.beam.directory' })
  })
})

describe('what is still not real', () => {
  it('records interest without unlocking anything', async () => {
    const fetchImpl = mockFetch(201, { ok: true, status: 'registered' })
    await registerInterest({ email: 'A@Firma.de', company: 'Firma', capability: 'thirdPartyKyc', note: 'bitte' }, { baseUrl: BASE, fetchImpl })
    const sent = call(fetchImpl)
    expect(sent.url).toBe(`${BASE}/waitlist`)
    expect(sent.body).toMatchObject({ email: 'a@firma.de', source: 'onboarding-interest', workflowType: 'onboarding-thirdPartyKyc', hp_company: '' })
  })

  const pending = [
    ['checkPowerOfRepresentation', checkPowerOfRepresentation],
    ['startThirdPartyKyc', startThirdPartyKyc],
    ['syncEmployeeDirectory', syncEmployeeDirectory],
  ] as const

  it.each(pending)('%s throws NotAvailableYet without any request', async (name, fn) => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const error = await fn().catch((err: unknown) => err)
    expect(error).toBeInstanceOf(NotAvailableYet)
    expect((error as NotAvailableYet).capability).toBe(name === 'startThirdPartyKyc' ? 'thirdPartyKyc' : name)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('keeps Grok sending, third-party KYC, directory sync and representation checks unavailable', () => {
    expect(CAPABILITIES.grokSending).toBe('unavailable')
    expect(CAPABILITIES.thirdPartyKyc).toBe('unavailable')
    expect(CAPABILITIES.syncEmployeeDirectory).toBe('unavailable')
    expect(CAPABILITIES.checkPowerOfRepresentation).toBe('unavailable')
    expect(CAPABILITIES.issueMandate).toBe('live')
    expect(CAPABILITIES.verifyDomainByWellKnownFile).toBe('live')
    expect(CAPABILITIES.requestManualKyc).toBe('live')
  })
})
