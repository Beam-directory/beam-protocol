import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BeamDirectory, BeamDirectoryError } from '../src/directory.js'
import type { AgentRecord } from '../src/types.js'

interface MockResponseInit {
  body?: unknown
  ok?: boolean
  status?: number
  statusText?: string
}

function createResponse(init: MockResponseInit) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: vi.fn().mockResolvedValue(init.body),
  }
}

describe('BeamDirectory', () => {
  const fetchMock = vi.fn()
  const directory = new BeamDirectory({ baseUrl: 'https://directory.example/', apiKey: 'secret-key' })

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('register() posts agent registration and returns the created agent', async () => {
    const agent: AgentRecord = {
      beamId: 'alice@acme.beam.directory',
      displayName: 'Alice',
      capabilities: ['agent.ping'],
      publicKey: 'pub-key',
      org: 'acme',
      trustScore: 0.7,
      verified: true,
      createdAt: '2026-03-08T10:00:00.000Z',
      lastSeen: '2026-03-08T10:00:00.000Z',
    }
    fetchMock.mockResolvedValue(createResponse({ body: agent, status: 201 }))

    const result = await directory.register({
      beamId: agent.beamId,
      displayName: agent.displayName,
      capabilities: agent.capabilities,
      publicKey: agent.publicKey,
      org: agent.org,
    })

    expect(result).toEqual(agent)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://directory.example/agents/register',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-key',
        }),
      }),
    )
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      beamId: agent.beamId,
      displayName: agent.displayName,
      capabilities: agent.capabilities,
      publicKey: agent.publicKey,
      org: agent.org,
    })
  })

  it('register() wraps API failures in BeamDirectoryError', async () => {
    fetchMock.mockResolvedValue(
      createResponse({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        body: { error: 'Invalid registration' },
      }),
    )

    await expect(
      directory.register({
        beamId: 'alice@acme.beam.directory',
        displayName: 'Alice',
        capabilities: [],
        publicKey: 'pub-key',
        org: 'acme',
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<BeamDirectoryError>>({
      name: 'BeamDirectoryError',
      message: 'Registration failed: Invalid registration',
      statusCode: 400,
    }))
  })

  it('lookup() returns an agent when found', async () => {
    const agent = {
      beamId: 'bob@acme.beam.directory',
      displayName: 'Bob',
      capabilities: ['task.delegate'],
      publicKey: 'pub-key',
      org: 'acme',
      trustScore: 0.6,
      verified: false,
      createdAt: '2026-03-08T10:00:00.000Z',
      lastSeen: '2026-03-08T10:10:00.000Z',
    }
    fetchMock.mockResolvedValue(createResponse({ body: agent }))

    await expect(directory.lookup(agent.beamId)).resolves.toEqual(agent)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://directory.example/agents/bob%40acme.beam.directory',
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })

  it('lookup() returns null for 404 responses', async () => {
    fetchMock.mockResolvedValue(createResponse({ ok: false, status: 404, statusText: 'Not Found' }))

    await expect(directory.lookup('missing@acme.beam.directory')).resolves.toBeNull()
  })

  it('search() sends filters and normalizes snake_case records', async () => {
    fetchMock.mockResolvedValue(
      createResponse({
        body: {
          agents: [
            {
              beam_id: 'clara@acme.beam.directory',
              display_name: 'Clara',
              capabilities: ['sales.pipeline_summary', 'agent.ping'],
              public_key: 'pub-key',
              org: 'acme',
              trust_score: 0.9,
              verified: true,
              created_at: '2026-03-01T10:00:00.000Z',
              last_seen: '2026-03-08T09:00:00.000Z',
            },
          ],
          total: 1,
        },
      }),
    )

    const result = await directory.search({
      org: 'acme',
      capabilities: ['sales.pipeline_summary', 'agent.ping'],
      minTrustScore: 0.8,
      limit: 5,
    })

    expect(result).toEqual([
      {
        beamId: 'clara@acme.beam.directory',
        displayName: 'Clara',
        capabilities: ['sales.pipeline_summary', 'agent.ping'],
        publicKey: 'pub-key',
        org: 'acme',
        trustScore: 0.9,
        verified: true,
        createdAt: '2026-03-01T10:00:00.000Z',
        lastSeen: '2026-03-08T09:00:00.000Z',
      },
    ])

    const [url] = fetchMock.mock.calls[0] as [string]
    const parsedUrl = new URL(url)
    expect(parsedUrl.searchParams.get('org')).toBe('acme')
    expect(parsedUrl.searchParams.get('capabilities')).toBe('sales.pipeline_summary,agent.ping')
    expect(parsedUrl.searchParams.get('minTrustScore')).toBe('0.8')
    expect(parsedUrl.searchParams.get('limit')).toBe('5')
  })

  it('heartbeat() posts to the heartbeat endpoint', async () => {
    fetchMock.mockResolvedValue(createResponse({ body: { ok: true } }))

    await expect(directory.heartbeat('alice@acme.beam.directory')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://directory.example/agents/alice%40acme.beam.directory/heartbeat',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('heartbeat() ignores 404 responses but rejects other failures', async () => {
    fetchMock.mockResolvedValueOnce(createResponse({ ok: false, status: 404, statusText: 'Not Found' }))
    fetchMock.mockResolvedValueOnce(createResponse({ ok: false, status: 500, statusText: 'Server Error' }))

    await expect(directory.heartbeat('missing@acme.beam.directory')).resolves.toBeUndefined()
    await expect(directory.heartbeat('broken@acme.beam.directory')).rejects.toEqual(
      expect.objectContaining<Partial<BeamDirectoryError>>({
        name: 'BeamDirectoryError',
        message: 'Heartbeat failed: Server Error',
        statusCode: 500,
      }),
    )
  })
})
