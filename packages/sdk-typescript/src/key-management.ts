/**
 * Consumer-friendly key management for Beam identities.
 * Supports encrypted export/import, BIP-39 recovery phrases, and QR data.
 */
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto'
import { BIP39_ENGLISH } from './bip39-wordlist.js'

export interface ExportedIdentity {
  version: 1
  beamId: string
  publicKeyBase64: string
  /** Present only if not encrypted */
  privateKeyBase64?: string
  /** Present only if encrypted */
  encrypted?: {
    ciphertext: string   // base64
    iv: string           // base64
    salt: string         // base64
    iterations: number
  }
}

export interface BeamIdentityData {
  beamId: string
  publicKeyBase64: string
  privateKeyBase64: string
}

// ─── Helpers ───────────────────────────────────────────────

const cryptoApi = globalThis.crypto ?? webcrypto
const subtle = cryptoApi.subtle

function getSubtle() {
  if (!subtle) {
    throw new Error('Web Crypto API is not available in this runtime')
  }

  return subtle
}

async function deriveKey(password: string, salt: Uint8Array, iterations = 600_000): Promise<webcrypto.CryptoKey> {
  const enc = new TextEncoder()
  const cryptoSubtle = getSubtle()
  const keyMaterial = await cryptoSubtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return cryptoSubtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  return Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64')
}

function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// ─── Export / Import ───────────────────────────────────────

/**
 * Export a Beam identity as JSON. If password is provided, the private key
 * is encrypted with AES-256-GCM (PBKDF2 key derivation).
 */
export async function exportIdentity(identity: BeamIdentityData, password?: string): Promise<string> {
  if (!password) {
    const doc: ExportedIdentity = {
      version: 1,
      beamId: identity.beamId,
      publicKeyBase64: identity.publicKeyBase64,
      privateKeyBase64: identity.privateKeyBase64,
    }
    return JSON.stringify(doc, null, 2)
  }

  const salt = cryptoApi.getRandomValues(new Uint8Array(16))
  const iv = cryptoApi.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const plaintext = new TextEncoder().encode(identity.privateKeyBase64)
  const ciphertext = await getSubtle().encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext),
  )

  const doc: ExportedIdentity = {
    version: 1,
    beamId: identity.beamId,
    publicKeyBase64: identity.publicKeyBase64,
    encrypted: {
      ciphertext: toBase64(ciphertext),
      iv: toBase64(iv),
      salt: toBase64(salt),
      iterations: 600_000,
    },
  }
  return JSON.stringify(doc, null, 2)
}

/**
 * Import a Beam identity from JSON. If the identity was encrypted,
 * provide the same password used during export.
 */
export async function importIdentity(json: string, password?: string): Promise<BeamIdentityData> {
  const doc = JSON.parse(json) as ExportedIdentity

  if (doc.privateKeyBase64 && !doc.encrypted) {
    return {
      beamId: doc.beamId,
      publicKeyBase64: doc.publicKeyBase64,
      privateKeyBase64: doc.privateKeyBase64,
    }
  }

  if (!doc.encrypted) throw new Error('Identity is encrypted but no encrypted block found')
  if (!password) throw new Error('Password required to decrypt identity')

  const { ciphertext, iv, salt, iterations } = doc.encrypted
  const key = await deriveKey(password, fromBase64(salt), iterations)
  const decrypted = await getSubtle().decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(fromBase64(iv)) },
    key,
    toArrayBuffer(fromBase64(ciphertext)),
  )

  return {
    beamId: doc.beamId,
    publicKeyBase64: doc.publicKeyBase64,
    privateKeyBase64: new TextDecoder().decode(decrypted),
  }
}

// ─── Recovery Phrase (BIP-39 style) ────────────────────────

/**
 * Extract the 32-byte Ed25519 seed from a private key and encode as
 * a 12-word mnemonic. Only the first 128 bits (16 bytes) of the seed
 * are encoded; remaining 16 bytes are derived via SHA-256 during recovery.
 *
 * NOTE: This is a simplified scheme (128-bit entropy → 12 words).
 * The full 32-byte seed is NOT recoverable from just 12 words —
 * we hash the 16-byte entropy to get the full seed deterministically.
 */
export function generateRecoveryPhrase(identity: BeamIdentityData): string {
  const privKeyDer = Buffer.from(identity.privateKeyBase64, 'base64')
  // Ed25519 PKCS8 DER: last 32 bytes are the seed
  const seed = privKeyDer.subarray(privKeyDer.length - 32)

  // Take first 16 bytes (128 bits) → 12 words (11 bits each, 132 bits, 4 checksum)
  const entropy = seed.subarray(0, 16)
  const hash = createHash('sha256').update(entropy).digest()
  const checksumBits = hash[0]! >> 4 // 4 checksum bits for 128-bit entropy

  // Build bit string
  let bits = ''
  for (const byte of entropy) bits += byte.toString(2).padStart(8, '0')
  bits += checksumBits.toString(2).padStart(4, '0')

  const words: string[] = []
  for (let i = 0; i < 132; i += 11) {
    const idx = parseInt(bits.slice(i, i + 11), 2)
    words.push(BIP39_ENGLISH[idx]!)
  }

  return words.join(' ')
}

/**
 * Recover a Beam identity from a 12-word recovery phrase.
 * The entropy is expanded to a 32-byte seed via SHA-256.
 */
export function recoverFromPhrase(phrase: string, beamId?: string): BeamIdentityData {
  const words = phrase.trim().toLowerCase().split(/\s+/)
  if (words.length !== 12) throw new Error('Recovery phrase must be exactly 12 words')

  // Words → 132 bits
  let bits = ''
  for (const word of words) {
    const idx = BIP39_ENGLISH.indexOf(word)
    if (idx === -1) throw new Error(`Unknown word: ${word}`)
    bits += idx.toString(2).padStart(11, '0')
  }

  // Extract 128-bit entropy (first 128 bits)
  const entropyBits = bits.slice(0, 128)
  const entropy = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    entropy[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2)
  }

  // Verify checksum
  const hash = createHash('sha256').update(entropy).digest()
  const expectedChecksum = (hash[0]! >> 4).toString(2).padStart(4, '0')
  const actualChecksum = bits.slice(128, 132)
  if (expectedChecksum !== actualChecksum) throw new Error('Invalid recovery phrase checksum')

  // Expand entropy to 32-byte seed via SHA-256
  const seed = createHash('sha256').update(entropy).digest()

  // Create Ed25519 keypair from seed
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', { seed })

  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' })
  const pubDer = publicKey.export({ format: 'der', type: 'spki' })

  return {
    beamId: beamId ?? `recovered-${Date.now()}@beam.directory`,
    publicKeyBase64: Buffer.from(pubDer).toString('base64'),
    privateKeyBase64: Buffer.from(privDer).toString('base64'),
  }
}

// ─── QR Code Data ──────────────────────────────────────────

/**
 * Generate a compact JSON string suitable for QR code encoding.
 * Contains only the essential data to reconstruct the identity.
 */
export function toQRData(identity: BeamIdentityData): string {
  return JSON.stringify({
    b: identity.beamId,
    p: identity.publicKeyBase64,
    s: identity.privateKeyBase64,
  })
}

/**
 * Parse a QR code data string back into a BeamIdentityData object.
 */
export function fromQRData(data: string): BeamIdentityData {
  const obj = JSON.parse(data) as { b: string; p: string; s: string }
  return {
    beamId: obj.b,
    publicKeyBase64: obj.p,
    privateKeyBase64: obj.s,
  }
}
