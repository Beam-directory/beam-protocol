import { afterEach, describe, expect, it, vi } from 'vitest'

import { BeamClient, BeamDirectory, beamIdFromApiKey } from '../src/index.js'

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
