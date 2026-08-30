import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decryptNetworkPayload as decryptInBrowser,
  encryptNetworkPayload as encryptInBrowser,
  generateNetworkEncryptionIdentity,
  importNetworkEncryptionPrivateKey,
} from './network-crypto.js'
import {
  decryptNetworkPayload as decryptInNode,
  encryptNetworkPayload as encryptInNode,
} from '../../scripts/workspace/network-e2ee.mjs'

test('browser and Node Beam Network encryption are interoperable', async () => {
  const alice = await generateNetworkEncryptionIdentity()
  const bob = await generateNetworkEncryptionIdentity()
  const alicePrivateKey = await importNetworkEncryptionPrivateKey(alice)
  const bobPrivateKey = await importNetworkEncryptionPrivateKey(bob)
  const recipients = [
    { beamId: 'alice@example.beam.directory', dhPublicKey: alice.publicKey },
    { beamId: 'bob@example.beam.directory', dhPublicKey: bob.publicKey },
  ]
  const payload = { body: 'One protocol across browser and agent.', messageType: 'text', attachment: null }

  const browserEnvelope = await encryptInBrowser({
    conversationId: 'conversation_interop',
    senderBeamId: 'alice@example.beam.directory',
    recipients,
    payload,
  })
  assert.deepEqual(decryptInNode({
    conversationId: 'conversation_interop',
    senderBeamId: 'alice@example.beam.directory',
    recipientBeamId: 'bob@example.beam.directory',
    privateKeyBase64: bob.privateKey,
    envelope: browserEnvelope,
  }), payload)

  const nodeEnvelope = encryptInNode({
    conversationId: 'conversation_interop',
    senderBeamId: 'bob@example.beam.directory',
    recipients,
    payload,
  })
  assert.deepEqual(await decryptInBrowser({
    conversationId: 'conversation_interop',
    senderBeamId: 'bob@example.beam.directory',
    recipientBeamId: 'alice@example.beam.directory',
    privateKey: alicePrivateKey,
    envelope: nodeEnvelope,
  }), payload)

  await assert.rejects(decryptInBrowser({
    conversationId: 'conversation_interop',
    senderBeamId: 'bob@example.beam.directory',
    recipientBeamId: 'alice@example.beam.directory',
    privateKey: bobPrivateKey,
    envelope: nodeEnvelope,
  }))
})
