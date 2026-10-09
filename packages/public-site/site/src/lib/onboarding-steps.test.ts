import { describe, expect, it } from 'vitest'
import { buildRecoveryKit, generateAgentIdentity, recoveryKitFileName } from './agent-keys'
import {
  EMPTY_SCOPE,
  INITIAL_PROGRESS,
  PROGRESS_STORAGE_KEY,
  buildBeamId,
  canAdvance,
  deriveOrgName,
  isValidLei,
  loadProgress,
  mandatePayload,
  saveProgress,
  scopeGrantFromDraft,
  scopeWithin,
  validateAgentName,
  validateDomain,
  validateRecipientBeamId,
  validateRegistry,
} from './onboarding-steps'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

describe('org namespace', () => {
  it('derives the public label from the registrable domain', () => {
    expect(deriveOrgName('https://www.firma.de/kontakt')).toBe('firma')
    expect(deriveOrgName('team.firma.de')).toBe('firma')
    expect(deriveOrgName('shop.firma.co.uk')).toBe('firma')
    expect(deriveOrgName('mein-betrieb.com')).toBe('mein-betrieb')
  })

  it('validates domains', () => {
    expect(validateDomain('firma.de')).toBeNull()
    expect(validateDomain('firma')).not.toBeNull()
    expect(validateDomain('')).not.toBeNull()
  })
})

describe('agent address', () => {
  it('builds org Beam IDs and validates the local part', () => {
    expect(buildBeamId(' Einkauf ', 'firma')).toBe('einkauf@firma.beam.directory')
    expect(validateAgentName('einkauf')).toBeNull()
    expect(validateAgentName('e')).not.toBeNull()
    expect(validateAgentName('-x')).not.toBeNull()
    expect(validateAgentName('Ein kauf')).not.toBeNull()
  })

  it('validates contact recipients', () => {
    expect(validateRecipientBeamId('lakis@partner.beam.directory')).toBeNull()
    expect(validateRecipientBeamId('lakis@example.com')).not.toBeNull()
    expect(validateRecipientBeamId('a@firma.beam.directory', 'a@firma.beam.directory')).not.toBeNull()
  })
})

describe('registry filing', () => {
  const base = {
    kind: 'handelsregister' as const,
    registrationNumber: 'HRB 123456',
    legalName: 'Firma GmbH',
    registerCourt: 'Amtsgericht Berlin',
    applicantName: 'Ada Lovelace',
    applicantRole: 'geschaeftsfuehrer',
    leiCountry: 'DE',
  }

  it('accepts a German commercial-register filing and a checksum-valid LEI', () => {
    expect(validateRegistry(base)).toBeNull()
    expect(validateRegistry({ ...base, registrationNumber: '123456' })).toBe('registryDeInvalid')
    expect(validateRegistry({ ...base, registerCourt: '' })).toBe('registerCourtRequired')
    expect(validateRegistry({ ...base, applicantRole: '' })).toBe('applicantRoleRequired')
    expect(isValidLei('5493001KJTIIGC8Y1R12')).toBe(true)
    expect(validateRegistry({ ...base, kind: 'lei', registrationNumber: '5493001KJTIIGC8Y1R12', leiCountry: 'DE' })).toBeNull()
    expect(validateRegistry({ ...base, kind: 'lei', registrationNumber: '5493001KJTIIGC8Y1R12', leiCountry: 'Germany' })).toBe('leiCountryInvalid')
    expect(validateRegistry({ ...base, kind: 'lei', registrationNumber: 'not-an-lei', leiCountry: 'DE' })).toBe('leiInvalid')
  })
})

describe('mandate payload', () => {
  it('builds the object the directory verifies, with no supervisor to escalate to', () => {
    const grant = scopeGrantFromDraft({ ...EMPTY_SCOPE, order: true, orderLimitEur: '500,5' })
    expect('grant' in grant).toBe(true)
    if (!('grant' in grant)) return
    expect(grant.grant.order).toEqual({ maxAmount: '500.50', currency: 'EUR' })
    const payload = mandatePayload({
      jti: 'mandate01',
      personId: 'p1',
      agentBeamId: 'a@firma.beam.directory',
      org: 'firma',
      scopes: grant.grant,
      expiresAt: '2026-12-01T00:00:00.000Z',
    })
    expect(payload).toMatchObject({ type: 'mandate', version: 1, escalationPersonId: null, jti: 'mandate01' })
    expect(scopeWithin(grant.grant, grant.grant)).toBe(true)
    expect(scopeWithin({ actions: ['order'], order: { maxAmount: '600.00', currency: 'EUR' } }, grant.grant)).toBe(false)
  })

  it('rejects an empty scope and a zero amount', () => {
    expect(scopeGrantFromDraft({ read: false, schedule: false, files: false, order: false, orderLimitEur: '' })).toEqual({ error: 'scopeRequired' })
    expect(scopeGrantFromDraft({ ...EMPTY_SCOPE, order: true, orderLimitEur: '0' })).toEqual({ error: 'orderLimitRequired' })
  })
})

describe('progress persistence', () => {
  it('never writes secrets, even if they are passed in', () => {
    const storage = memoryStorage()
    const progress = { ...INITIAL_PROGRESS, step: 2, orgName: 'firma', apiKey: 'beam_org_secret', privateKey: 'PRIV', agentApiKey: 'bk_x' }
    saveProgress(progress, storage)
    const stored = storage.data.get(PROGRESS_STORAGE_KEY) ?? ''
    expect(stored).not.toContain('beam_org_secret')
    expect(stored).not.toContain('PRIV')
    expect(stored).not.toContain('bk_x')
    expect(loadProgress(storage)).toMatchObject({ step: 2, orgName: 'firma' })
  })

  it('falls back to the initial state on garbage', () => {
    const storage = memoryStorage()
    storage.setItem(PROGRESS_STORAGE_KEY, '{not json')
    expect(loadProgress(storage)).toEqual(INITIAL_PROGRESS)
    storage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify({ step: 99 }))
    expect(loadProgress(storage).step).toBe(3)
  })
})

describe('step gating', () => {
  it('blocks the company step until the domain is confirmed, the person step until a record exists, and the agent step until registration', () => {
    expect(canAdvance('firma', { orgVerified: false, orgKeyInMemory: true, personReady: false, agentRegistered: false }).ok).toBe(false)
    expect(canAdvance('firma', { orgVerified: true, orgKeyInMemory: true, personReady: false, agentRegistered: false }).ok).toBe(true)
    expect(canAdvance('person', { orgVerified: true, orgKeyInMemory: true, personReady: false, agentRegistered: false })).toEqual({ ok: false, reason: 'person' })
    expect(canAdvance('person', { orgVerified: true, orgKeyInMemory: false, personReady: true, agentRegistered: false }).ok).toBe(true)
    expect(canAdvance('agent', { orgVerified: true, orgKeyInMemory: true, personReady: true, agentRegistered: false }).ok).toBe(false)
  })
})

describe('recovery kit', () => {
  it('matches the format /network opens', async () => {
    const identity = await generateAgentIdentity()
    const kit = buildRecoveryKit({ beamId: 'a@firma.beam.directory', directoryUrl: 'https://api.beam.directory', identity, apiKey: 'bk_abc' })
    expect(kit.format).toBe('beam-identity-recovery')
    expect(kit.version).toBe(1)
    expect(kit.identity.algorithm).toBe('Ed25519')
    expect(kit.identity.encryption.algorithm).toBe('X25519')
    expect(kit.credential.apiKey.startsWith('bk_')).toBe(true)
    expect(recoveryKitFileName(kit.beamId)).toBe('a_at_firma.beam.directory-recovery.json')
  })
})
