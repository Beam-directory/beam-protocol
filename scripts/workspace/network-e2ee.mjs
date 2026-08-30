import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const algorithm = 'X25519-HKDF-SHA256-AES-256-GCM'

function aad(kind, conversationId, senderBeamId, recipientBeamId = null) {
  return Buffer.from(kind === 'content'
    ? `beam-network-content:v1:${conversationId}:${senderBeamId}`
    : `beam-network-wrap:v1:${conversationId}:${senderBeamId}:${recipientBeamId}`)
}

function wrappingInfo(conversationId, recipientBeamId) {
  return Buffer.from(`beam-network-key:v1:${conversationId}:${recipientBeamId}`)
}

function wrappingKey(privateKey, publicKey, salt, conversationId, recipientBeamId) {
  const sharedSecret = diffieHellman({ privateKey, publicKey })
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, wrappingInfo(conversationId, recipientBeamId), 32))
}

function encryptAesGcm(plaintext, key, nonce, additionalData) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(additionalData)
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

function decryptAesGcm(ciphertextAndTag, key, nonce, additionalData) {
  if (ciphertextAndTag.byteLength < 17) {
    throw new Error('Invalid encrypted Beam payload')
  }
  const ciphertext = ciphertextAndTag.subarray(0, -16)
  const tag = ciphertextAndTag.subarray(-16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  decipher.setAAD(additionalData)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export function createNetworkEncryptionIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    dhPublicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    dhPrivateKeyBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}

export function assertNetworkEncryptionIdentity(publicKeyBase64, privateKeyBase64) {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    const privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' })
    if (publicKey.asymmetricKeyType !== 'x25519' || privateKey.asymmetricKeyType !== 'x25519') {
      throw new Error('Wrong encryption algorithm')
    }
    const probe = generateKeyPairSync('x25519')
    const left = diffieHellman({ privateKey, publicKey: probe.publicKey })
    const right = diffieHellman({ privateKey: probe.privateKey, publicKey })
    if (!timingSafeEqual(left, right)) {
      throw new Error('Encryption keys do not match')
    }
  } catch {
    throw new Error('Beam X25519 public and private keys do not match')
  }
}

export function encryptNetworkPayload({ conversationId, senderBeamId, recipients, payload }) {
  const messageKey = randomBytes(32)
  const nonce = randomBytes(12)
  const salt = randomBytes(32)
  const ephemeral = generateKeyPairSync('x25519')
  const ciphertext = encryptAesGcm(
    Buffer.from(JSON.stringify(payload)),
    messageKey,
    nonce,
    aad('content', conversationId, senderBeamId),
  )

  const wrappedRecipients = recipients
    .slice()
    .sort((left, right) => left.beamId.localeCompare(right.beamId))
    .map((recipient) => {
      const publicKey = createPublicKey({ key: Buffer.from(recipient.dhPublicKey, 'base64'), format: 'der', type: 'spki' })
      if (publicKey.asymmetricKeyType !== 'x25519') {
        throw new Error(`${recipient.beamId} has an invalid Beam encryption key`)
      }
      const key = wrappingKey(ephemeral.privateKey, publicKey, salt, conversationId, recipient.beamId)
      const wrapNonce = randomBytes(12)
      return {
        beamId: recipient.beamId,
        nonce: wrapNonce.toString('base64'),
        wrappedKey: encryptAesGcm(
          messageKey,
          key,
          wrapNonce,
          aad('wrap', conversationId, senderBeamId, recipient.beamId),
        ).toString('base64'),
      }
    })

  return {
    version: 1,
    algorithm,
    ephemeralPublicKey: ephemeral.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    recipients: wrappedRecipients,
  }
}

export function decryptNetworkPayload({ conversationId, senderBeamId, recipientBeamId, privateKeyBase64, envelope }) {
  if (envelope?.version !== 1 || envelope?.algorithm !== algorithm) {
    throw new Error('Unsupported Beam encryption format')
  }
  const recipient = envelope.recipients?.find((entry) => entry.beamId === recipientBeamId)
  if (!recipient) {
    throw new Error('Encrypted Beam message is not addressed to this identity')
  }
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' })
  const ephemeralPublicKey = createPublicKey({ key: Buffer.from(envelope.ephemeralPublicKey, 'base64'), format: 'der', type: 'spki' })
  const key = wrappingKey(
    privateKey,
    ephemeralPublicKey,
    Buffer.from(envelope.salt, 'base64'),
    conversationId,
    recipientBeamId,
  )
  const messageKey = decryptAesGcm(
    Buffer.from(recipient.wrappedKey, 'base64'),
    key,
    Buffer.from(recipient.nonce, 'base64'),
    aad('wrap', conversationId, senderBeamId, recipientBeamId),
  )
  const plaintext = decryptAesGcm(
    Buffer.from(envelope.ciphertext, 'base64'),
    messageKey,
    Buffer.from(envelope.nonce, 'base64'),
    aad('content', conversationId, senderBeamId),
  )
  const parsed = JSON.parse(plaintext.toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid decrypted Beam message')
  }
  return parsed
}
