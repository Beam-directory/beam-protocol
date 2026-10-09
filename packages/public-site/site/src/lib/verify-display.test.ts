import { describe, expect, it } from 'vitest'
import type { AgentCheck } from 'beam-protocol-sdk/trust-assertion'
import { de } from '../i18n/de.ts'
import { en } from '../i18n/en.ts'
import { formatLocalSummary, isVerifiedIndividual } from './verify-display.ts'

function check(patch: Partial<AgentCheck>): AgentCheck {
  return {
    address: 'grok@beam.directory',
    status: 'verified',
    verified: true,
    claimsAuthenticated: true,
    signature: 'valid',
    detail: 'ok',
    expired: false,
    suspended: false,
    org: null,
    subject: 'individual',
    owner: {
      role: 'individual',
      ref: 'ab'.repeat(32),
      kycStatus: 'verified',
      subject: 'individual',
      level: 'person_id_verified',
      provider: 'stripe_identity',
      publicName: 'Tobias K.',
    },
    scopes: { actions: ['read'], order: null, fileMaxBytes: null },
    issuedAt: '2026-10-08T11:50:00.000Z',
    expiresAt: '2026-10-08T12:05:00.000Z',
    pinnedKeyId: 'ed25519:test',
    assertionKeyId: 'ed25519:test',
    keyMatchesPin: true,
    summary: 'verified individual, on behalf of Tobias K., may: read',
    httpStatus: 200,
    ...patch,
  }
}

describe('individual trust display', () => {
  it('uses the individual labels in English and German and never names a company', () => {
    expect(en.check.verifiedIndividual).toBe('Verified individual')
    expect(de.check.verifiedIndividual).toBe('Geprüfte Privatperson')
    expect(en.check.noCompany).toBe('No company is attached to this agent.')
    expect(de.check.noCompany).toBe('Diesem Agenten ist kein Unternehmen zugeordnet.')
    const individual = check({})
    expect(isVerifiedIndividual(individual)).toBe(true)
    const english = formatLocalSummary(individual, en.check)
    const german = formatLocalSummary(individual, de.check)
    expect(english).toBe('verified individual, on behalf of Tobias K., may: read')
    expect(german).toBe('geprüfte Privatperson, im Auftrag von Tobias K., darf: read')
    expect(english.includes('on behalf of individual')).toBe(false)
    expect(german.includes('im Auftrag von individual')).toBe(false)
    expect(english.includes('Kub')).toBe(false)
    expect(german.includes('Kub')).toBe(false)
    expect(english.includes('coppen')).toBe(false)
    expect(german.includes('GmbH')).toBe(false)
    expect(de.check.yesIndividual('Tobias K.', 'lesen')).toBe('Ja, dieser Agent gehört zu Tobias K. (geprüfte Privatperson) und darf: lesen')
    expect(en.check.yesIndividual('Tobias K.', 'read')).toBe('Yes, this agent belongs to Tobias K. (verified individual) and may: read')
    const unnamed = formatLocalSummary(check({ owner: { ...individual.owner!, publicName: null } }), en.check)
    expect(unnamed).toBe('verified individual, may: read')
    expect(isVerifiedIndividual(check({ org: { name: 'coppen', domain: 'coppen.de', verified: true, level: 'domain', registryStatus: 'none' }, subject: 'organization' }))).toBe(false)
  })
})
