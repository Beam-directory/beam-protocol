import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertNetworkEncryptionIdentity,
  createNetworkEncryptionIdentity,
  decryptNetworkPayload,
  encryptNetworkPayload,
} from './network-e2ee.mjs'

test('Network E2EE encrypts once and decrypts for every intended identity', () => {
  const alice = createNetworkEncryptionIdentity()
  const bob = createNetworkEncryptionIdentity()
  const agent = createNetworkEncryptionIdentity()
  const recipients = [
    { beamId: 'alice@example.beam.directory', dhPublicKey: alice.dhPublicKeyBase64 },
    { beamId: 'bob@example.beam.directory', dhPublicKey: bob.dhPublicKeyBase64 },
    { beamId: 'agent@example.beam.directory', dhPublicKey: agent.dhPublicKeyBase64 },
  ]
  const payload = { body: 'Only the conversation members can read this.', messageType: 'text', attachment: null }
  const encrypted = encryptNetworkPayload({
    conversationId: 'conversation_test',
    senderBeamId: 'alice@example.beam.directory',
    recipients,
    payload,
  })

  assert.equal(JSON.stringify(encrypted).includes(payload.body), false)
  for (const [beamId, identity] of [
    ['alice@example.beam.directory', alice],
    ['bob@example.beam.directory', bob],
    ['agent@example.beam.directory', agent],
  ]) {
    assert.deepEqual(decryptNetworkPayload({
      conversationId: 'conversation_test',
      senderBeamId: 'alice@example.beam.directory',
      recipientBeamId: beamId,
      privateKeyBase64: identity.dhPrivateKeyBase64,
      envelope: encrypted,
    }), payload)
  }
})

test('Network E2EE rejects a wrong private key', () => {
  const alice = createNetworkEncryptionIdentity()
  const mallory = createNetworkEncryptionIdentity()
  const envelope = encryptNetworkPayload({
    conversationId: 'conversation_test',
    senderBeamId: 'alice@example.beam.directory',
    recipients: [{ beamId: 'alice@example.beam.directory', dhPublicKey: alice.dhPublicKeyBase64 }],
    payload: { body: 'secret' },
  })

  assert.throws(() => decryptNetworkPayload({
    conversationId: 'conversation_test',
    senderBeamId: 'alice@example.beam.directory',
    recipientBeamId: 'alice@example.beam.directory',
    privateKeyBase64: mallory.dhPrivateKeyBase64,
    envelope,
  }))
  assert.throws(() => assertNetworkEncryptionIdentity(alice.dhPublicKeyBase64, mallory.dhPrivateKeyBase64))
})
