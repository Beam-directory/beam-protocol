import assert from 'node:assert/strict'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import test from 'node:test'
import { signedAgentConfigBody } from './agent-config.mjs'

test('a config patch is signed and still carries dhPublicKey for directory v1.7.0', () => {
  const keys = generateKeyPairSync('ed25519')
  const privateKeyBase64 = keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  const dhPublicKey = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const beamId = 'grok@coppen.beam.directory'
  const body = signedAgentConfigBody(privateKeyBase64, beamId, { dhPublicKey })

  assert.equal(body.type, 'agent.config')
  assert.equal(body.beamId, beamId)
  assert.equal(body.dhPublicKey, dhPublicKey)
  assert.match(body.nonce, /^[A-Za-z0-9_-]{16,128}$/)
  assert.equal(Number.isNaN(Date.parse(body.timestamp)), false)

  const { signature, ...signed } = body
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(signed).sort().map((key) => [key, signed[key]])))
  assert.equal(verify(
    null,
    Buffer.from(canonical, 'utf8'),
    createPublicKey({ key: keys.publicKey.export({ type: 'spki', format: 'der' }), format: 'der', type: 'spki' }),
    Buffer.from(signature, 'base64'),
  ), true)
})
