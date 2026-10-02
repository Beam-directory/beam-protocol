import { describe, expect, it } from 'vitest'
import { fingerprintPublicKey, projectPublicAgent, projectPublicDirectory, sealSnippet } from './public-agent'

const publicCompany = {
  beam_id: 'einkauf@coppen.beam.directory',
  display_name: 'Einkauf',
  org: 'coppen',
  personal: false,
  visibility: 'public',
  flagged: false,
  verified: true,
  verification_tier: 'business',
  public_key: 'cHVibGljLWtleQ==',
  did: 'did:beam:einkauf@coppen.beam.directory',
  description: 'Beschafft Material.',
  website: 'https://coppen.example',
  created_at: '2026-08-02T10:00:00.000Z',
}

describe('public agent projection', () => {
  it('keeps a public verified company agent and drops contact fields', () => {
    const projected = projectPublicAgent(publicCompany, {
      business: {
        businessVerification: {
          legalName: 'COPPEN GmbH',
          registrationNumber: 'HRB 12345',
          country: 'DE',
          verifiedAt: '2026-09-01T00:00:00.000Z',
        },
      },
      domain: {
        status: 'verified',
        domain: 'coppen.example',
        verifiedAt: '2026-08-20T00:00:00.000Z',
        dnsRecord: { value: 'beam-verify=secret-token' },
      },
    })

    expect(projected.ok).toBe(true)
    if (!projected.ok) {
      return
    }
    expect(projected.agent.org).toBe('coppen')
    expect(projected.agent.legalName).toBe('COPPEN GmbH')
    expect(projected.agent.domain).toBe('coppen.example')
    expect(projected.agent.tier).toBe('business')
    expect(JSON.stringify(projected.agent)).not.toContain('secret-token')
    expect(JSON.stringify(projected.agent)).not.toContain('email')
  })

  it('hides unlisted, personal, and email-bearing records', () => {
    expect(projectPublicAgent({ ...publicCompany, visibility: 'unlisted' }).ok).toBe(false)
    expect(projectPublicAgent({ ...publicCompany, personal: true }).ok).toBe(false)
    expect(projectPublicAgent({ ...publicCompany, email: 'ada@coppen.example' })).toEqual({
      ok: false,
      reason: 'email-present',
    })
    expect(projectPublicAgent({ ...publicCompany, flagged: true }).ok).toBe(false)
  })

  it('lists only verified public company agents from browse payloads', () => {
    const listed = projectPublicDirectory({
      agents: [
        publicCompany,
        { ...publicCompany, beam_id: 'hidden@coppen.beam.directory', visibility: 'unlisted', email: 'hidden@example.com' },
        { ...publicCompany, beam_id: 'person@beam.directory', org: null, personal: true },
        { ...publicCompany, beam_id: 'basic@coppen.beam.directory', verified: false, verification_tier: 'basic' },
      ],
    })
    expect(listed.map((agent) => agent.beamId)).toEqual(['einkauf@coppen.beam.directory'])
  })

  it('fingerprints a public key without echoing it back', async () => {
    const fingerprint = await fingerprintPublicKey('cHVibGljLWtleQ==')
    expect(fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){7}$/)
    expect(fingerprint).not.toContain('cHVibGlj')
  })

  it('builds an embed snippet that points at the public seal', () => {
    const snippet = sealSnippet('https://beam.directory', 'https://api.beam.directory', 'einkauf@coppen.beam.directory')
    expect(snippet.svgUrl).toBe('https://api.beam.directory/agents/einkauf%40coppen.beam.directory/seal.svg')
    expect(snippet.html).toContain('https://beam.directory/agents/einkauf%40coppen.beam.directory')
    expect(snippet.html).not.toContain('@coppen')
  })
})
