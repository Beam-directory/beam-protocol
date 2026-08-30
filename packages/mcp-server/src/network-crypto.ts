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
  type KeyObject,
} from 'node:crypto'
import type { BeamIdString } from 'beam-protocol-sdk'

const ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM'

export type NetworkEncryptedEnvelope = {
  version: 1
  algorithm: typeof ALGORITHM
  ephemeralPublicKey: string
  salt: string
  nonce: string
  ciphertext: string
  recipients: Array<{ beamId: BeamIdString; nonce: string; wrappedKey: string }>
}

function additionalData(kind: 'content' | 'wrap', conversationId: string, senderBeamId: string, recipientBeamId?: string): Buffer {
  return Buffer.from(kind === 'content'
    ? `beam-network-content:v1:${conversationId}:${senderBeamId}`
    : `beam-network-wrap:v1:${conversationId}:${senderBeamId}:${recipientBeamId}`)
}

function wrappingInfo(conversationId: string, recipientBeamId: string): Buffer {
  return Buffer.from(`beam-network-key:v1:${conversationId}:${recipientBeamId}`)
}

function deriveWrappingKey(privateKey: KeyObject, publicKey: KeyObject, salt: Buffer, conversationId: string, recipientBeamId: string): Buffer {
  const shared = diffieHellman({ privateKey, publicKey })
  return Buffer.from(hkdfSync('sha256', shared, salt, wrappingInfo(conversationId, recipientBeamId), 32))
}

function encryptAesGcm(plaintext: Buffer, key: Buffer, nonce: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

function decryptAesGcm(ciphertextAndTag: Buffer, key: Buffer, nonce: Buffer, aad: Buffer): Buffer {
  if (ciphertextAndTag.byteLength < 17) throw new Error('Invalid encrypted Beam payload')
  const ciphertext = ciphertextAndTag.subarray(0, -16)
  const tag = ciphertextAndTag.subarray(-16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export function assertX25519KeyPair(publicKeyBase64: string, privateKeyBase64: string): void {
  try {
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), type: 'spki', format: 'der' })
    const privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), type: 'pkcs8', format: 'der' })
    if (publicKey.asymmetricKeyType !== 'x25519' || privateKey.asymmetricKeyType !== 'x25519') throw new Error('Wrong algorithm')
    const probe = generateKeyPairSync('x25519')
    const left = diffieHellman({ privateKey, publicKey: probe.publicKey })
    const right = diffieHellman({ privateKey: probe.privateKey, publicKey })
    if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) throw new Error('Key mismatch')
  } catch {
    throw new Error('BEAM X25519 public and private key material do not match')
  }
}

export function encryptNetworkPayload(input: {
  conversationId: string
  senderBeamId: BeamIdString
  recipients: Array<{ beamId: BeamIdString; dhPublicKey: string }>
  payload: Record<string, unknown>
}): NetworkEncryptedEnvelope {
  const messageKey = randomBytes(32)
  const nonce = randomBytes(12)
  const salt = randomBytes(32)
  const ephemeral = generateKeyPairSync('x25519')
  const ciphertext = encryptAesGcm(
    Buffer.from(JSON.stringify(input.payload)),
    messageKey,
    nonce,
    additionalData('content', input.conversationId, input.senderBeamId),
  )
  const recipients = input.recipients
    .slice()
    .sort((left, right) => left.beamId.localeCompare(right.beamId))
    .map((recipient) => {
      const publicKey = createPublicKey({ key: Buffer.from(recipient.dhPublicKey, 'base64'), type: 'spki', format: 'der' })
      if (publicKey.asymmetricKeyType !== 'x25519') throw new Error(`${recipient.beamId} has an invalid Beam encryption key`)
      const wrappingKey = deriveWrappingKey(ephemeral.privateKey, publicKey, salt, input.conversationId, recipient.beamId)
      const wrapNonce = randomBytes(12)
      return {
        beamId: recipient.beamId,
        nonce: wrapNonce.toString('base64'),
        wrappedKey: encryptAesGcm(
          messageKey,
          wrappingKey,
          wrapNonce,
          additionalData('wrap', input.conversationId, input.senderBeamId, recipient.beamId),
        ).toString('base64'),
      }
    })
  return {
    version: 1,
    algorithm: ALGORITHM,
    ephemeralPublicKey: ephemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    recipients,
  }
}

export function decryptNetworkPayload(input: {
  conversationId: string
  senderBeamId: string
  recipientBeamId: BeamIdString
  privateKeyBase64: string
  envelope: NetworkEncryptedEnvelope
}): Record<string, unknown> {
  if (input.envelope.version !== 1 || input.envelope.algorithm !== ALGORITHM) throw new Error('Unsupported Beam encryption format')
  const recipient = input.envelope.recipients.find((entry) => entry.beamId === input.recipientBeamId)
  if (!recipient) throw new Error('Encrypted Beam message is not addressed to this identity')
  const privateKey = createPrivateKey({ key: Buffer.from(input.privateKeyBase64, 'base64'), type: 'pkcs8', format: 'der' })
  const ephemeralPublicKey = createPublicKey({ key: Buffer.from(input.envelope.ephemeralPublicKey, 'base64'), type: 'spki', format: 'der' })
  const wrappingKey = deriveWrappingKey(
    privateKey,
    ephemeralPublicKey,
    Buffer.from(input.envelope.salt, 'base64'),
    input.conversationId,
    input.recipientBeamId,
  )
  const messageKey = decryptAesGcm(
    Buffer.from(recipient.wrappedKey, 'base64'),
    wrappingKey,
    Buffer.from(recipient.nonce, 'base64'),
    additionalData('wrap', input.conversationId, input.senderBeamId, input.recipientBeamId),
  )
  const plaintext = decryptAesGcm(
    Buffer.from(input.envelope.ciphertext, 'base64'),
    messageKey,
    Buffer.from(input.envelope.nonce, 'base64'),
    additionalData('content', input.conversationId, input.senderBeamId),
  )
  const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid decrypted Beam message')
  return parsed as Record<string, unknown>
}
