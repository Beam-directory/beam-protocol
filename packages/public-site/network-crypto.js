const ENVELOPE_VERSION = 1
const ENVELOPE_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM'
const MAX_ENCRYPTED_PAYLOAD_BYTES = 9 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function subtleCrypto() {
  if (!globalThis.crypto?.subtle) throw new Error('Secure browser cryptography is unavailable.')
  return globalThis.crypto.subtle
}

function randomBytes(length) {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  const chunkSize = 32_768
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return globalThis.btoa(binary)
}

export function base64ToBytes(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid encrypted Beam data.')
  try {
    const binary = globalThis.atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    throw new Error('Invalid encrypted Beam data.')
  }
}

function contentAdditionalData(conversationId, senderBeamId) {
  return encoder.encode(`beam-network-content:v1:${conversationId}:${senderBeamId}`)
}

function wrapAdditionalData(conversationId, senderBeamId, recipientBeamId) {
  return encoder.encode(`beam-network-wrap:v1:${conversationId}:${senderBeamId}:${recipientBeamId}`)
}

async function deriveWrappingKey(privateKey, publicKey, salt, conversationId, recipientBeamId) {
  const subtle = subtleCrypto()
  const shared = await subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256)
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info: encoder.encode(`beam-network-key:v1:${conversationId}:${recipientBeamId}`),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function generateNetworkEncryptionIdentity() {
  const subtle = subtleCrypto()
  let pair
  try {
    pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  } catch {
    throw new Error('This browser cannot create Beam end-to-end encryption keys. Use a current Safari, Chrome, Edge, or Firefox.')
  }
  const [publicKey, privateKey] = await Promise.all([
    subtle.exportKey('spki', pair.publicKey),
    subtle.exportKey('pkcs8', pair.privateKey),
  ])
  return {
    algorithm: 'X25519',
    publicKey: bytesToBase64(publicKey),
    privateKey: bytesToBase64(privateKey),
  }
}

export async function importNetworkEncryptionPrivateKey(identity) {
  if (
    !identity
    || identity.algorithm !== 'X25519'
    || typeof identity.publicKey !== 'string'
    || typeof identity.privateKey !== 'string'
  ) throw new Error('This Beam identity has no end-to-end encryption key.')

  const subtle = subtleCrypto()
  try {
    const [privateKey, publicKey, probe] = await Promise.all([
      subtle.importKey('pkcs8', base64ToBytes(identity.privateKey), { name: 'X25519' }, false, ['deriveBits']),
      subtle.importKey('spki', base64ToBytes(identity.publicKey), { name: 'X25519' }, false, []),
      subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']),
    ])
    const [left, right] = await Promise.all([
      subtle.deriveBits({ name: 'X25519', public: probe.publicKey }, privateKey, 256),
      subtle.deriveBits({ name: 'X25519', public: publicKey }, probe.privateKey, 256),
    ])
    const leftBytes = new Uint8Array(left)
    const rightBytes = new Uint8Array(right)
    if (leftBytes.length !== rightBytes.length || !leftBytes.every((value, index) => value === rightBytes[index])) {
      throw new Error('Key mismatch')
    }
    return privateKey
  } catch {
    throw new Error('This Beam recovery kit contains a damaged encryption key.')
  }
}

export async function encryptNetworkPayload({ conversationId, senderBeamId, recipients, payload }) {
  if (!Array.isArray(recipients) || recipients.length < 2 || recipients.length > 50) {
    throw new Error('This conversation has an invalid encryption membership.')
  }
  const unique = new Map()
  for (const recipient of recipients) {
    if (!recipient?.beamId || !recipient?.dhPublicKey) {
      throw new Error(`${recipient?.beamId || 'A conversation member'} has not enabled end-to-end encryption yet.`)
    }
    unique.set(recipient.beamId, recipient.dhPublicKey)
  }
  if (unique.size !== recipients.length) throw new Error('Conversation encryption members must be unique.')

  const plaintext = encoder.encode(JSON.stringify(payload))
  if (plaintext.byteLength > MAX_ENCRYPTED_PAYLOAD_BYTES) throw new Error('This encrypted Beam message is too large.')

  const subtle = subtleCrypto()
  const messageKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const messageKeyBytes = new Uint8Array(await subtle.exportKey('raw', messageKey))
  const contentNonce = randomBytes(12)
  const ciphertext = await subtle.encrypt({
    name: 'AES-GCM',
    iv: contentNonce,
    additionalData: contentAdditionalData(conversationId, senderBeamId),
    tagLength: 128,
  }, messageKey, plaintext)

  const ephemeral = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const ephemeralPublicKey = await subtle.exportKey('spki', ephemeral.publicKey)
  const salt = randomBytes(32)
  const wrappedRecipients = []
  for (const [beamId, publicKeyBase64] of [...unique.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const publicKey = await subtle.importKey('spki', base64ToBytes(publicKeyBase64), { name: 'X25519' }, false, [])
    const wrappingKey = await deriveWrappingKey(ephemeral.privateKey, publicKey, salt, conversationId, beamId)
    const nonce = randomBytes(12)
    const wrappedKey = await subtle.encrypt({
      name: 'AES-GCM',
      iv: nonce,
      additionalData: wrapAdditionalData(conversationId, senderBeamId, beamId),
      tagLength: 128,
    }, wrappingKey, messageKeyBytes)
    wrappedRecipients.push({ beamId, nonce: bytesToBase64(nonce), wrappedKey: bytesToBase64(wrappedKey) })
  }

  return {
    version: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    ephemeralPublicKey: bytesToBase64(ephemeralPublicKey),
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(contentNonce),
    ciphertext: bytesToBase64(ciphertext),
    recipients: wrappedRecipients,
  }
}

export async function decryptNetworkPayload({ conversationId, senderBeamId, recipientBeamId, privateKey, envelope }) {
  if (
    !envelope
    || envelope.version !== ENVELOPE_VERSION
    || envelope.algorithm !== ENVELOPE_ALGORITHM
    || !Array.isArray(envelope.recipients)
  ) throw new Error('This message uses an unsupported Beam encryption format.')
  const recipient = envelope.recipients.find((item) => item?.beamId === recipientBeamId)
  if (!recipient) throw new Error('This encrypted message was not addressed to this Beam identity.')

  const subtle = subtleCrypto()
  try {
    const ephemeralPublicKey = await subtle.importKey(
      'spki',
      base64ToBytes(envelope.ephemeralPublicKey),
      { name: 'X25519' },
      false,
      [],
    )
    const salt = base64ToBytes(envelope.salt)
    const wrappingKey = await deriveWrappingKey(privateKey, ephemeralPublicKey, salt, conversationId, recipientBeamId)
    const messageKeyBytes = await subtle.decrypt({
      name: 'AES-GCM',
      iv: base64ToBytes(recipient.nonce),
      additionalData: wrapAdditionalData(conversationId, senderBeamId, recipientBeamId),
      tagLength: 128,
    }, wrappingKey, base64ToBytes(recipient.wrappedKey))
    const messageKey = await subtle.importKey('raw', messageKeyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
    const plaintext = await subtle.decrypt({
      name: 'AES-GCM',
      iv: base64ToBytes(envelope.nonce),
      additionalData: contentAdditionalData(conversationId, senderBeamId),
      tagLength: 128,
    }, messageKey, base64ToBytes(envelope.ciphertext))
    return JSON.parse(decoder.decode(plaintext))
  } catch {
    throw new Error('Beam could not decrypt this message for your identity.')
  }
}

export const networkEncryptionFormat = Object.freeze({
  version: ENVELOPE_VERSION,
  algorithm: ENVELOPE_ALGORITHM,
})
