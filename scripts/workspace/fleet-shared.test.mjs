import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import test from 'node:test'
import { buildFleetWebSocketUrl, sendSignedFleetResult } from './fleet-shared.mjs'

test('fleet websocket URL transports only a short-lived ticket', () => {
  assert.throws(
    () => buildFleetWebSocketUrl('http://127.0.0.1:3100', 'alpha@openclaw.beam.directory', ''),
    /WebSocket ticket is required/,
  )

  const url = new URL(buildFleetWebSocketUrl(
    'https://api.beam.directory',
    'alpha@openclaw.beam.directory',
    'bwt_short_lived',
  ))
  assert.equal(url.protocol, 'wss:')
  assert.equal(url.pathname, '/ws')
  assert.equal(url.searchParams.get('beamId'), 'alpha@openclaw.beam.directory')
  assert.equal(url.searchParams.get('ticket'), 'bwt_short_lived')
  assert.equal(url.searchParams.has('apiKey'), false)
})

test('fleet results are canonically signed by the intended responder', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const responder = { beamId: 'beta@openclaw.beam.directory', privateKey }
  let serialized = ''
  const ws = { send: (value) => { serialized = value } }

  sendSignedFleetResult(ws, responder, {
    to: responder.beamId,
    nonce: 'fleet-result-nonce',
  }, { ok: true })

  const message = JSON.parse(serialized)
  const { signature, ...unsigned } = message.frame
  const canonical = JSON.stringify(Object.fromEntries(
    Object.keys(unsigned).sort().map((key) => [key, unsigned[key]]),
  ))
  assert.equal(message.type, 'result')
  assert.equal(verify(null, Buffer.from(canonical), publicKey, Buffer.from(signature, 'base64')), true)
})
