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
    },
    scopes: { actions: ['read'], order: null, fileMaxBytes: null },
    issuedAt: '2026-10-08T11:50:00.000Z',
    expiresAt: '2026-10-08T12:05:00.000Z',
    pinnedKeyId: 'ed25519:test',
    assertionKeyId: 'ed25519:test',
    keyMatchesPin: true,
    summary: 'verified individual, on behalf of individual, may: read',
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
    expect(english.startsWith('verified individual')).toBe(true)
    expect(german.startsWith('geprüfte Privatperson')).toBe(true)
    expect(english.includes('coppen')).toBe(false)
    expect(german.includes('GmbH')).toBe(false)
    expect(isVerifiedIndividual(check({ org: { name: 'coppen', domain: 'coppen.de', verified: true, level: 'domain', registryStatus: 'none' }, subject: 'organization' }))).toBe(false)
  })
})
