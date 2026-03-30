import { afterEach, describe, expect, it, vi } from 'vitest'

import { BeamClient, BeamDirectory, BeamIdentity, canonicalizeFrame } from '../src/index.js'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('SDK key lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('signs key rotation payloads and normalizes returned key state', async () => {
    const currentIdentity = BeamIdentity.generate({ agentName: 'rotator', orgName: 'acme' })
    const nextIdentity = BeamIdentity.generate({ agentName: 'rotator', orgName: 'acme' })

    const fetchMock = vi.fn(async () => jsonResponse({
      beamId: currentIdentity.beamId,
      previousKey: currentIdentity.publicKeyBase64,
      keyState: {
        active: {
          beamId: currentIdentity.beamId,
          publicKey: nextIdentity.publicKeyBase64,
          createdAt: Date.now(),
          revokedAt: null,
          status: 'active',
        },
        revoked: [{
          beamId: currentIdentity.beamId,
          publicKey: currentIdentity.publicKeyBase64,
          createdAt: Date.now() - 1_000,
          revokedAt: Date.now(),
          status: 'revoked',
        }],
        keys: [],
        total: 1,
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new BeamClient({
      identity: currentIdentity.export(),
      directoryUrl: 'https://api.beam.directory',
    })

    const result = await client.rotateKeys(nextIdentity.export())

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, string>
    expect(body['new_public_key']).toBe(nextIdentity.publicKeyBase64)
    expect(body['rotation_proof']).toBeTypeOf('string')
    expect(body['signature']).toBeTypeOf('string')
    expect(body['timestamp']).toBeTypeOf('string')
    expect(BeamIdentity.verify(
      canonicalizeFrame({
        action: 'keys.rotate',
        beamId: currentIdentity.beamId,
        newPublicKey: nextIdentity.publicKeyBase64,
        timestamp: body['timestamp'],
      }),
      body['signature'] ?? '',
      currentIdentity.publicKeyBase64,
    )).toBe(true)
    expect(result.keyState?.active?.publicKey).toBe(nextIdentity.publicKeyBase64)
  })

  it('lists keys and signs revocation payloads', async () => {
    const identity = BeamIdentity.generate({ agentName: 'guardian', orgName: 'acme' })
    const retiredIdentity = BeamIdentity.generate({ agentName: 'guardian', orgName: 'acme' })

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/keys')) {
        return jsonResponse({
          keyState: {
            active: {
              beamId: identity.beamId,
              publicKey: identity.publicKeyBase64,
              createdAt: Date.now(),
              revokedAt: null,
              status: 'active',
            },
            revoked: [{
              beamId: identity.beamId,
              publicKey: retiredIdentity.publicKeyBase64,
              createdAt: Date.now() - 1_000,
              revokedAt: Date.now(),
              status: 'revoked',
            }],
            keys: [{
              beamId: identity.beamId,
              publicKey: identity.publicKeyBase64,
              createdAt: Date.now(),
              revokedAt: null,
              status: 'active',
            }],
            total: 2,
          },
        })
      }

      return jsonResponse({
        beamId: identity.beamId,
        revoked: true,
        revokedKey: {
          beamId: identity.beamId,
          publicKey: retiredIdentity.publicKeyBase64,
          createdAt: Date.now() - 1_000,
          revokedAt: Date.now(),
          status: 'revoked',
        },
        keyState: {
          active: {
            beamId: identity.beamId,
            publicKey: identity.publicKeyBase64,
            createdAt: Date.now(),
            revokedAt: null,
            status: 'active',
          },
          revoked: [{
            beamId: identity.beamId,
            publicKey: retiredIdentity.publicKeyBase64,
            createdAt: Date.now() - 1_000,
            revokedAt: Date.now(),
            status: 'revoked',
          }],
          keys: [],
          total: 2,
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const directory = new BeamDirectory({
      baseUrl: 'https://api.beam.directory',
    })
    const keyState = await directory.listKeys(identity.beamId)
    expect(keyState.revoked[0]?.publicKey).toBe(retiredIdentity.publicKeyBase64)

    const client = new BeamClient({
      identity: identity.export(),
      directoryUrl: 'https://api.beam.directory',
    })
    const result = await client.revokeKey(retiredIdentity.publicKeyBase64)

    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, string>
    expect(BeamIdentity.verify(
      canonicalizeFrame({
        action: 'keys.revoke',
        beamId: identity.beamId,
        publicKey: retiredIdentity.publicKeyBase64,
        timestamp: body['timestamp'],
      }),
      body['signature'] ?? '',
      identity.publicKeyBase64,
    )).toBe(true)
    expect(result.revoked).toBe(true)
    expect(result.revokedKey?.publicKey).toBe(retiredIdentity.publicKeyBase64)
  })
})
