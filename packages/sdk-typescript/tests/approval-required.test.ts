import { afterEach, describe, expect, it, vi } from 'vitest'
import { BeamClient, BeamIdentity } from '../src/index.js'

describe('HTTP 202 approval', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns ApprovalRequired and does not treat the intent as delivered', async () => {
    const identity = BeamIdentity.generate({ agentName: 'buyer', orgName: 'coppen' })
    const client = new BeamClient({
      identity: identity.export(),
      directoryUrl: 'http://directory.test',
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Approval required',
      errorCode: 'APPROVAL_REQUIRED',
      approvalId: 'apr-1',
      executed: false,
    }), { status: 202, headers: { 'content-type': 'application/json' } })))

    const result = await client.send('vendor@coppen.beam.directory', 'order.place', {
      amount: '250.00',
      currency: 'EUR',
    })

    expect(result).toEqual({
      executed: false,
      approvalId: 'apr-1',
      errorCode: 'APPROVAL_REQUIRED',
      error: 'Approval required',
    })
  })
})
