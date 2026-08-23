import { afterEach, describe, expect, it, vi } from 'vitest'

import { BeamClient, BeamDirectory, BeamIdentity, beamIdFromApiKey } from '../src/index.js'

function makeApiKey(beamId: string): string {
  return `bk_${Buffer.from(beamId, 'utf8').toString('base64url')}.testsecret`
}

describe('SDK API key auth', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('derives the beam id from a bk_ api key', () => {
    const apiKey = makeApiKey('agent@beam.directory')
    expect(beamIdFromApiKey(apiKey)).toBe('agent@beam.directory')

    const client = new BeamClient({
      apiKey,
      directoryUrl: 'https://api.beam.directory',
    })

    expect(client.beamId).toBe('agent@beam.directory')
  })

  it('fails closed when websocket responder credentials are incomplete', async () => {
    const identity = BeamIdentity.generate({ agentName: 'agent', orgName: 'acme' })
    const identityOnly = new BeamClient({
      identity: identity.export(),
      directoryUrl: 'https://api.beam.directory',
    })
    await expect(identityOnly.connect()).rejects.toThrow(/agent API key returned by register/i)

    const apiKeyOnly = new BeamClient({
      apiKey: makeApiKey('agent@beam.directory'),
      directoryUrl: 'https://api.beam.directory',
    })
    await expect(apiKeyOnly.connect()).rejects.toThrow(/Ed25519 identity.*ResultFrames/i)
    expect(() => apiKeyOnly.on('agent.ping', () => undefined)).toThrow(/Ed25519 identity.*ResultFrames/i)
  })

  it('adopts the one-time registration API key for authenticated transports', async () => {
    const identity = BeamIdentity.generate({ agentName: 'agent', orgName: 'acme' })
    const apiKey = makeApiKey(identity.beamId)
    const client = new BeamClient({
      identity: identity.export(),
      directoryUrl: 'https://api.beam.directory',
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      beamId: identity.beamId,
      displayName: 'Agent',
      capabilities: ['agent.ping'],
      publicKey: identity.publicKeyBase64,
      apiKey,
      trustScore: 0.3,
      verified: false,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const record = await client.register('Agent', ['agent.ping'])

    expect(record.apiKey).toBe(apiKey)
    expect(client.apiKey).toBe(apiKey)
  })

  it('sends x-api-key on directory requests', async () => {
    const apiKey = makeApiKey('agent@beam.directory')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ totalAgents: 1, verifiedAgents: 1, intentsProcessed: 2 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const directory = new BeamDirectory({
      baseUrl: 'https://api.beam.directory',
      apiKey,
    })

    await directory.getStats()

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.beam.directory/stats',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': apiKey,
        }),
      }),
    )
  })

  it('preserves assurance tier and status on direct agent lookup', async () => {
    const beamId = 'partner@verified.beam.directory'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      beam_id: beamId,
      display_name: 'Verified Partner',
      capabilities: ['conversation.message'],
      public_key: 'public-key',
      org: 'verified',
      trust_score: 0.94,
      verified: true,
      verification_tier: 'business',
      verification_status: 'verified',
      assurance_scope: 'local',
      assurance_issuer: 'https://api.beam.directory',
      domain: 'verified.example',
      created_at: '2026-08-23T00:00:00.000Z',
      last_seen: '2026-08-23T00:00:00.000Z',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    const record = await new BeamDirectory({ baseUrl: 'https://api.beam.directory' }).lookup(beamId)
    expect(record?.verificationTier).toBe('business')
    expect(record?.verificationStatus).toBe('verified')
    expect(record?.assuranceScope).toBe('local')
    expect(record?.assuranceIssuer).toBe('https://api.beam.directory')
    expect(record?.domain).toBe('verified.example')
  })

  it('exchanges the long-lived API key for a short-lived WebSocket ticket', async () => {
    const beamId = 'agent@acme.beam.directory'
    const apiKey = makeApiKey(beamId)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      beamId,
      ticket: 'bwt_short_lived',
      expiresAt: '2026-08-23T08:00:30.000Z',
      expiresInSeconds: 30,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const directory = new BeamDirectory({ baseUrl: 'https://api.beam.directory', apiKey })
    const ticket = await directory.createWebSocketTicket(beamId)

    expect(ticket.ticket).toBe('bwt_short_lived')
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.beam.directory/agents/${encodeURIComponent(beamId)}/ws-ticket`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': apiKey }),
      }),
    )
  })

  it('parses release truth fields from /stats responses', async () => {
    const apiKey = makeApiKey('agent@beam.directory')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      agents: 3,
      verifiedAgents: 2,
      intentsProcessed: 9,
      waitlistSize: 1,
      version: '0.8.0',
      gitSha: 'abcdef1234567890abcdef1234567890abcdef12',
      deployedAt: '2026-03-30T19:00:00.000Z',
      release: {
        version: '0.8.0',
        gitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        gitShaShort: 'abcdef1',
        deployedAt: '2026-03-30T19:00:00.000Z',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const directory = new BeamDirectory({
      baseUrl: 'https://api.beam.directory',
      apiKey,
    })

    const stats = await directory.getStats()

    expect(stats.totalAgents).toBe(3)
    expect(stats.version).toBe('0.8.0')
    expect(stats.gitSha).toBe('abcdef1234567890abcdef1234567890abcdef12')
    expect(stats.deployedAt).toBe('2026-03-30T19:00:00.000Z')
    expect(stats.release?.gitShaShort).toBe('abcdef1')
  })
})
