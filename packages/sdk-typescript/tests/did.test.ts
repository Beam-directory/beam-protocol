import { afterEach, describe, expect, it, vi } from 'vitest'
import { BeamIdentity } from '../src/identity.js'
import { BeamDID, CredentialVerifier } from '../src/did.js'
import { issueBusinessVC, issueDomainVC, issueEmailVC } from '../../directory/src/credentials.js'

describe('BeamDID', () => {
  const identity = BeamIdentity.generate({ agentName: 'jarvis', orgName: 'acme' })
  const did = new BeamDID({ baseUrl: 'https://beam.directory', identity })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates an org-bound DID document', () => {
    const document = did.create({ format: 'org' })

    expect(document.id).toBe('did:beam:acme:jarvis')
    expect(document.verificationMethod[0]?.type).toBe('Ed25519VerificationKey2020')
    expect(document.authentication).toContain('did:beam:acme:jarvis#key-1')
  })

  it('creates a personal DID document', () => {
    const document = did.create({ format: 'personal' })

    expect(document.id).toBe('did:beam:jarvis')
    expect(document.verificationMethod[0]?.publicKeyMultibase.startsWith('z')).toBe(true)
  })

  it('creates a key-based DID document', () => {
    const document = did.create({ format: 'key' })

    expect(document.id.startsWith('did:beam:z')).toBe(true)
    expect(document.verificationMethod[0]?.controller).toBe(document.id)
  })

  it('resolves a DID document from the directory endpoint', async () => {
    const expected = did.create({ format: 'org' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => expected,
    }))

    await expect(did.resolve(expected.id)).resolves.toEqual(expected)
    expect(fetch).toHaveBeenCalledWith(
      `https://beam.directory/did/${encodeURIComponent(expected.id)}`,
      { headers: { Accept: 'application/did+json' } }
    )
  })
})

describe('Verifiable credentials', () => {
  const beamId = 'jarvis@acme.beam.directory'

  it('issues and verifies an email VC offline', () => {
    const vc = issueEmailVC(beamId, 'jarvis@example.com')

    expect(vc.type).toContain('EmailVerificationCredential')
    expect(vc.credentialSubject.email).toBe('jarvis@example.com')
    expect(CredentialVerifier.verify(vc)).toBe(true)
  })

  it('issues and verifies a domain VC offline', () => {
    const vc = issueDomainVC(beamId, 'example.com')

    expect(vc.type).toContain('DomainVerificationCredential')
    expect(vc.credentialSubject.domain).toBe('example.com')
    expect(CredentialVerifier.verify(vc)).toBe(true)
  })

  it('issues and verifies a business VC offline', () => {
    const vc = issueBusinessVC(beamId, { legalName: 'Acme Corp', registrationNumber: 'HRB-42' })

    expect(vc.type).toContain('BusinessVerificationCredential')
    expect(vc.credentialSubject.business?.['legalName']).toBe('Acme Corp')
    expect(CredentialVerifier.verify(vc)).toBe(true)
  })

  it('fails verification after credential tampering', () => {
    const vc = issueEmailVC(beamId, 'jarvis@example.com')
    const tampered = {
      ...vc,
      credentialSubject: {
        ...vc.credentialSubject,
        email: 'mallory@example.com',
      },
    }

    expect(CredentialVerifier.verify(tampered)).toBe(false)
  })
})
