import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentProfile, AgentRecord, BeamIdString, ResultFrame } from 'beam-protocol-sdk'
import { createBeamToolHandlers, type BeamGateway } from './tools.js'

const ownBeamId = 'grok@acme.beam.directory' as BeamIdString
const targetBeamId = 'support@partner.beam.directory' as BeamIdString

function agent(beamId: BeamIdString, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    beamId,
    displayName: beamId.split('@')[0] ?? beamId,
    capabilities: ['conversation.message'],
    publicKey: 'public-key-is-never-returned',
    org: beamId.split('@')[1]?.split('.')[0] ?? '',
    trustScore: 0.91,
    verified: true,
    verificationTier: 'verified',
    verificationStatus: 'verified',
    createdAt: '2026-08-23T00:00:00.000Z',
    lastSeen: '2026-08-23T00:00:00.000Z',
    apiKey: 'api-key-is-never-returned',
    ...overrides,
  }
}

function fixture(): { gateway: BeamGateway; sends: Array<Record<string, unknown>> } {
  const sends: Array<Record<string, unknown>> = []
  const records = new Map<string, AgentRecord>([
    [ownBeamId, agent(ownBeamId)],
    [targetBeamId, agent(targetBeamId)],
  ])
  return {
    sends,
    gateway: {
      async getStats() {
        return { totalAgents: 2, verifiedAgents: 2, intentsProcessed: 5, version: '1.7.0' }
      },
      async lookup(beamId) {
        return records.get(beamId) ?? null
      },
      async send(to, intent, payload, timeoutMs) {
        sends.push({ to, intent, payload, timeoutMs })
        return {
          v: '1',
          success: true,
          payload: { message: 'accepted' },
          nonce: 'nonce-1',
          timestamp: '2026-08-23T00:00:01.000Z',
          signature: 'signed-result',
        } satisfies ResultFrame
      },
    },
  }
}

test('status redacts key material', async () => {
  const { gateway } = fixture()
  const handlers = createBeamToolHandlers({ gateway, ownBeamId, allowedIntents: new Set(['conversation.message']) })
  const result = await handlers.status({ target: targetBeamId })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('api-key-is-never-returned'), false)
  assert.equal(serialized.includes('public-key-is-never-returned'), false)
  assert.equal((result['target'] as Record<string, unknown>)['verified'], true)
})

test('prepare validates trust without sending or returning message text', async () => {
  const { gateway, sends } = fixture()
  const handlers = createBeamToolHandlers({ gateway, ownBeamId, allowedIntents: new Set(['conversation.message']) })
  const result = await handlers.prepareHandoff({ to: targetBeamId, message: 'Secret commercial context' })
  assert.equal(result['ready'], true)
  assert.equal(result['requiresHumanConfirmation'], true)
  assert.equal(typeof result['messageSha256'], 'string')
  assert.equal(JSON.stringify(result).includes('Secret commercial context'), false)
  assert.equal(sends.length, 0)
})

test('send is blocked without exact confirmation', async () => {
  const { gateway, sends } = fixture()
  const handlers = createBeamToolHandlers({ gateway, ownBeamId, allowedIntents: new Set(['conversation.message']) })
  await assert.rejects(
    handlers.send({ to: targetBeamId, message: 'Do it', confirmed: false }),
    /explicit human approval/,
  )
  assert.equal(sends.length, 0)
})

test('send enforces the intent allowlist', async () => {
  const { gateway, sends } = fixture()
  const handlers = createBeamToolHandlers({ gateway, ownBeamId, allowedIntents: new Set(['conversation.message']) })
  await assert.rejects(
    handlers.send({ to: targetBeamId, message: 'Do it', intent: 'finance.pay', confirmed: true }),
    /not allowed/,
  )
  assert.equal(sends.length, 0)
})

test('send blocks an unverified or low-trust target even after model confirmation', async () => {
  const { gateway, sends } = fixture()
  const originalLookup = gateway.lookup
  gateway.lookup = async (beamId) => {
    const record = await originalLookup(beamId)
    return record && beamId === targetBeamId
      ? { ...record, verified: false, trustScore: 0.2 }
      : record
  }
  const handlers = createBeamToolHandlers({ gateway, ownBeamId, allowedIntents: new Set(['conversation.message']) })

  const preview = await handlers.prepareHandoff({ to: targetBeamId, message: 'Do it' })
  assert.equal(preview['ready'], false)
  await assert.rejects(
    handlers.send({ to: targetBeamId, message: 'Do it', confirmed: true }),
    /target policy blocked delivery/i,
  )
  assert.equal(sends.length, 0)
})

test('business-assurance policy cannot be waived by a verified boolean', async () => {
  const { gateway, sends } = fixture()
  const originalLookup = gateway.lookup
  gateway.lookup = async (beamId) => {
    const record = await originalLookup(beamId)
    return record && beamId === targetBeamId
      ? { ...record, verified: true, verificationTier: 'verified' }
      : record
  }
  const handlers = createBeamToolHandlers({
    gateway,
    ownBeamId,
    allowedIntents: new Set(['conversation.message']),
    minimumVerificationTier: 'business',
  })

  const preview = await handlers.prepareHandoff({ to: targetBeamId, message: 'Do it' })
  assert.equal(preview['ready'], false)
  assert.match(JSON.stringify(preview['warnings']), /below required business/)
  assert.equal(((preview['target'] as Record<string, unknown>)['assurance'] as Record<string, unknown>)['tier'], 'verified')
  await assert.rejects(
    handlers.send({ to: targetBeamId, message: 'Do it', confirmed: true }),
    /below required business/,
  )
  assert.equal(sends.length, 0)
})

test('federated assurance assertions cannot satisfy local verification policy', async () => {
  const { gateway, sends } = fixture()
  const originalLookup = gateway.lookup
  gateway.lookup = async (beamId) => {
    const record = await originalLookup(beamId)
    return record && beamId === targetBeamId
      ? {
          ...record,
          verified: true,
          verificationTier: 'enterprise',
          assuranceScope: 'federated-untrusted',
          assuranceIssuer: 'https://peer.example',
          remoteAssurance: {
            issuer: 'https://peer.example',
            verified: true,
            tier: 'enterprise',
            status: 'verified',
            trustScore: 1,
          },
        }
      : record
  }
  const handlers = createBeamToolHandlers({
    gateway,
    ownBeamId,
    allowedIntents: new Set(['conversation.message']),
    minimumVerificationTier: 'business',
  })

  const preview = await handlers.prepareHandoff({ to: targetBeamId, message: 'Do it' })
  assert.equal(preview['ready'], false)
  const target = preview['target'] as Record<string, unknown>
  const assurance = target['assurance'] as Record<string, unknown>
  assert.equal(target['verified'], false)
  assert.equal(assurance['tier'], 'basic')
  assert.equal(assurance['independentlyVerified'], false)
  assert.equal(assurance['scope'], 'federated-untrusted')
  assert.equal((assurance['remoteAssertion'] as Record<string, unknown>)['tier'], 'enterprise')
  await assert.rejects(
    handlers.send({ to: targetBeamId, message: 'Do it', confirmed: true }),
    /target policy blocked delivery/i,
  )
  assert.equal(sends.length, 0)
})

test('confirmed send delivers a signed result', async () => {
  const { gateway, sends } = fixture()
  const handlers = createBeamToolHandlers({ gateway, ownBeamId, allowedIntents: new Set(['conversation.message']) })
  const result = await handlers.send({
    to: targetBeamId,
    message: 'Please take over this support case',
    context: { ticket: 'SUP-42' },
    confirmed: true,
    timeoutMs: 10_000,
  })
  assert.equal(sends.length, 1)
  assert.equal((result['result'] as Record<string, unknown>)['signed'], true)
  assert.equal(result['delivered'], true)
})

test('unknown target is rejected before delivery', async () => {
  const { gateway, sends } = fixture()
  const handlers = createBeamToolHandlers({ gateway, ownBeamId, allowedIntents: new Set(['conversation.message']) })
  await assert.rejects(
    handlers.send({ to: 'missing@partner.beam.directory', message: 'Hello', confirmed: true }),
    /not found/,
  )
  assert.equal(sends.length, 0)
})
