/**
 * Beam Shield — E2E Encryption (S5)
 * X25519 Key Agreement + ChaCha20-Poly1305 AEAD
 *
 * Flow:
 * 1. Sender generates ephemeral X25519 keypair
 * 2. ECDH(ephemeral.private, recipient.dhPublicKey) → sharedSecret
 * 3. HKDF(sharedSecret) → encryptionKey
 * 4. ChaCha20-Poly1305(key, nonce, payload) → ciphertext
 * 5. Send: { encrypted: true, ephemeralPublicKey, ciphertext, nonce }
 */

import {
  generateKeyPairSync,
  diffieHellman,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

const HKDF_INFO = Buffer.from('beam-e2e-v1')
const HKDF_SALT = Buffer.alloc(32, 0) // Zero salt for deterministic derivation

export interface X25519KeyPair {
  publicKey: string  // base64
  privateKey: string // base64
}

export interface EncryptedPayload {
  encrypted: true
  ephemeralPublicKey: string // base64
  ciphertext: string         // base64
  nonce: string              // base64 (12 bytes)
  algorithm: 'chacha20-poly1305'
}

/** Generate a new X25519 keypair for E2E encryption */
export function generateX25519KeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  }
}

/** Derive shared secret via ECDH + HKDF */
function deriveKey(
  myPrivateKeyDer: Buffer,
  theirPublicKeyDer: Buffer,
): Buffer {
  const { createPrivateKey, createPublicKey } = require('node:crypto')
  const priv = createPrivateKey({ key: myPrivateKeyDer, format: 'der', type: 'pkcs8' })
  const pub = createPublicKey({ key: theirPublicKeyDer, format: 'der', type: 'spki' })

  const shared = diffieHellman({ privateKey: priv, publicKey: pub })

  // HKDF-SHA256 to derive 32-byte encryption key
  const derived = hkdfSync('sha256', shared, HKDF_SALT, HKDF_INFO, 32)
  return Buffer.from(derived)
}

/** Encrypt a payload for a recipient with their X25519 DH public key */
export function encryptPayload(
  payload: Record<string, unknown>,
  recipientDhPublicKeyBase64: string,
): EncryptedPayload {
  // Generate ephemeral keypair
  const ephemeral = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })

  const recipientPub = Buffer.from(recipientDhPublicKeyBase64, 'base64')
  const key = deriveKey(ephemeral.privateKey as Buffer, recipientPub)

  // ChaCha20-Poly1305 encryption
  const nonce = randomBytes(12)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8')

  const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    encrypted: true,
    ephemeralPublicKey: (ephemeral.publicKey as Buffer).toString('base64'),
    ciphertext: Buffer.concat([encrypted, authTag]).toString('base64'),
    nonce: nonce.toString('base64'),
    algorithm: 'chacha20-poly1305',
  }
}

/** Decrypt a payload using own X25519 DH private key */
export function decryptPayload(
  encryptedPayload: EncryptedPayload,
  myDhPrivateKeyBase64: string,
): Record<string, unknown> {
  const ephemeralPub = Buffer.from(encryptedPayload.ephemeralPublicKey, 'base64')
  const myPriv = Buffer.from(myDhPrivateKeyBase64, 'base64')
  const key = deriveKey(myPriv, ephemeralPub)

  const nonce = Buffer.from(encryptedPayload.nonce, 'base64')
  const fullCiphertext = Buffer.from(encryptedPayload.ciphertext, 'base64')

  // Last 16 bytes = auth tag
  const ciphertext = fullCiphertext.subarray(0, fullCiphertext.length - 16)
  const authTag = fullCiphertext.subarray(fullCiphertext.length - 16)

  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(decrypted.toString('utf-8')) as Record<string, unknown>
}

/** Check if a payload is encrypted */
export function isEncryptedPayload(payload: unknown): payload is EncryptedPayload {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  return p.encrypted === true && typeof p.ephemeralPublicKey === 'string' && typeof p.ciphertext === 'string'
}
