import { describe, expect, it } from 'vitest'
import { buildRecoveryKit, generateAgentIdentity, recoveryKitFileName } from './agent-keys'
import {
  EMPTY_MANDATE,
  INITIAL_PROGRESS,
  PROGRESS_STORAGE_KEY,
  buildBeamId,
  canAdvance,
  deriveOrgName,
  loadProgress,
  mandatePreview,
  saveProgress,
  validateAgentName,
  validateDomain,
  validateMandate,
  validateRecipientBeamId,
  validateRegistration,
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
  it('derives the namespace from the registrable domain like the directory', () => {
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

describe('registry data', () => {
  it('mirrors the directory formats', () => {
    expect(validateRegistration('DE', 'HRB 123456', 'Firma GmbH')).toBeNull()
    expect(validateRegistration('DE', '123456', 'Firma GmbH')).not.toBeNull()
    expect(validateRegistration('UK', '01234567', 'Firma Ltd')).toBeNull()
    expect(validateRegistration('DE', 'HRB 1', '')).not.toBeNull()
  })
})

describe('mandate draft', () => {
  it('requires an amount for orders and a target for escalation', () => {
    expect(validateMandate({ ...EMPTY_MANDATE, escalateTo: 'Leitung Einkauf' })).toBeNull()
    expect(validateMandate({ ...EMPTY_MANDATE, escalateTo: 'X Y', order: true, orderLimitEur: '' })).not.toBeNull()
    expect(validateMandate({ ...EMPTY_MANDATE, escalate: false, read: false, sendFiles: false })).not.toBeNull()
  })

  it('marks the preview as not issued', () => {
    const preview = mandatePreview({ ...EMPTY_MANDATE, order: true, orderLimitEur: '500', escalateTo: 'Leitung' }, 'a@firma.beam.directory')
    expect(preview.status).toBe('Entwurf, nicht ausgestellt')
    expect(preview.scopes).toContainEqual({ scope: 'bestellen', maxBetragEur: 500 })
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
  it('blocks step 1 until the domain is verified and step 3 until the agent exists', () => {
    expect(canAdvance('firma', { orgVerified: false, orgKeyInMemory: true, agentRegistered: false }).ok).toBe(false)
    expect(canAdvance('firma', { orgVerified: true, orgKeyInMemory: true, agentRegistered: false }).ok).toBe(true)
    expect(canAdvance('person', { orgVerified: true, orgKeyInMemory: false, agentRegistered: false }).ok).toBe(true)
    expect(canAdvance('agent', { orgVerified: true, orgKeyInMemory: true, agentRegistered: false }).ok).toBe(false)
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
