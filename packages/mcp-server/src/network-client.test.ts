import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { BeamIdentity, canonicalizeFrame, type BeamIdString } from 'beam-protocol-sdk'
import type { BeamMcpConfig } from './config.js'
import { BeamNetworkClient } from './network-client.js'

function config(): BeamMcpConfig {
  const identity = BeamIdentity.generate({ agentName: 'codex', orgName: 'acme' }).export()
  const dh = generateKeyPairSync('x25519')
  return {
    beamId: identity.beamId,
    publicKeyBase64: identity.publicKeyBase64,
    privateKeyBase64: identity.privateKeyBase64,
    dhPublicKeyBase64: dh.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    dhPrivateKeyBase64: dh.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    apiKey: 'bk_network_test',
    directoryUrl: 'https://api.beam.directory',
    allowedIntents: new Set(['conversation.message']),
    requireVerifiedTarget: true,
    minimumVerificationTier: 'verified',
    minimumTrustScore: 0.5,
  }
}

test('network reads use the configured identity credential and bounded query parameters', async () => {
  const requests: Array<{ url: string; authorization: string | null }> = []
  const client = new BeamNetworkClient(config(), async (input, init) => {
    const url = input instanceof URL ? input.href : String(input)
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })

  await client.identity()
  await client.discover('partner@acme.beam.directory')
  await client.messages('conversation-123', 25, '2026-08-29T10:00:00.000Z')

  assert.equal(requests[0]?.url, 'https://api.beam.directory/network/me')
  assert.equal(requests[1]?.url, 'https://api.beam.directory/network/discover?q=partner%40acme.beam.directory')
  assert.match(requests[2]?.url ?? '', /limit=25/)
  assert.match(requests[2]?.url ?? '', /before=2026-08-29T10%3A00%3A00.000Z/)
  assert.ok(requests.every((request) => request.authorization === 'Bearer bk_network_test'))
})

test('network mutations are signed by the configured Beam identity', async () => {
  const beamConfig = config()
  const partnerDh = generateKeyPairSync('x25519')
  const payloads: Record<string, unknown>[] = []
  const client = new BeamNetworkClient(beamConfig, async (_input, init) => {
    if (!init?.body) return new Response(JSON.stringify({
      conversations: [{
        conversationId: 'conversation-123',
        members: [
          { beamId: beamConfig.beamId, profile: { dhPublicKey: beamConfig.dhPublicKeyBase64 } },
          { beamId: 'partner@acme.beam.directory', profile: { dhPublicKey: partnerDh.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } },
        ],
      }],
    }), { status: 200 })
    payloads.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return new Response(JSON.stringify({ accepted: true }), { status: 201 })
  })

  await client.requestConnection('partner@acme.beam.directory' as BeamIdString, 'Let us connect')
  await client.sendMessage('conversation-123', 'Hello from Codex')

  assert.equal(payloads.length, 2)
  for (const payload of payloads) {
    const { signature, ...unsigned } = payload
    assert.equal(typeof signature, 'string')
    assert.equal(
      BeamIdentity.verify(canonicalizeFrame(unsigned), signature as string, beamConfig.publicKeyBase64),
      true,
    )
    assert.equal(typeof payload['timestamp'], 'string')
    assert.match(String(payload['nonce']), /^[A-Za-z0-9_-]{16,128}$/)
  }
  assert.equal(payloads[0]?.['requesterBeamId'], beamConfig.beamId)
  assert.equal(payloads[1]?.['senderBeamId'], beamConfig.beamId)
  assert.equal(payloads[1]?.['automationDepth'], 0)
  assert.equal(payloads[1]?.['body'], '')
  assert.equal(typeof payloads[1]?.['encrypted'], 'object')
})

test('network errors preserve the public error code without returning credentials', async () => {
  const client = new BeamNetworkClient(config(), async () => new Response(JSON.stringify({
    error: 'Direct conversations require an accepted connection',
    errorCode: 'CONNECTION_REQUIRED',
  }), { status: 403 }))

  await assert.rejects(
    client.openDirect('partner@acme.beam.directory' as BeamIdString),
    /403: CONNECTION_REQUIRED/,
  )
})
