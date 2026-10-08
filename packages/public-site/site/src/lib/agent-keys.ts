/**
 * Client-side agent keys. Mirrors the browser flow of the legacy pages:
 * - key generation as in claim.js `createDeviceIdentity` (Ed25519 SPKI/PKCS8 + X25519 from network-crypto.js),
 * - signing as in network-v2.js `signMutation` (canonical JSON, Ed25519, base64),
 * - the recovery kit format that /network opens (`beam-identity-recovery`, version 1).
 *
 * Private keys only ever live in memory here. Nothing in this module persists them.
 */

export interface EncryptionIdentity {
  algorithm: 'X25519'
  publicKey: string
  privateKey: string
}

export interface AgentIdentity {
  /** Ed25519 public key, base64 SPKI/DER. This is the only signing key material sent to Beam. */
  publicKey: string
  /** Ed25519 private key, base64 PKCS8. Never sent anywhere; only written into a recovery kit on request. */
  privateKey: string
  /** Non-extractable copy of the private key for signing in this tab. */
  signingKey: CryptoKey
  /** X25519 identity for end-to-end encryption in /network. */
  encryption: EncryptionIdentity
}

export interface RecoveryKit {
  format: 'beam-identity-recovery'
  version: 1
  createdAt: string
  beamId: string
  directoryUrl: string
  identity: {
    algorithm: 'Ed25519'
    publicKey: string
    privateKey: string
    encryption: EncryptionIdentity
  }
  credential: { apiKey: string }
  notice: string
}

export class KeySupportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeySupportError'
  }
}

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new KeySupportError('Dieser Browser kann keine sicheren Schlüssel erzeugen. Bitte einen aktuellen Browser verwenden.')
  }
  return subtle
}

export function bytesToBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ''
  const chunkSize = 32_768
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return globalThis.btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Same ordering rule as the directory's `canonicalizeJson` (sorted object keys, arrays kept in order). */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

export function createNonce(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export interface SigningIdentity {
  /** Ed25519 public key, base64 SPKI/DER. This is the only key material sent to Beam. */
  publicKey: string
  /** Ed25519 private key, base64 PKCS8. Never sent; only written into a file the user downloads. */
  privateKey: string
  /** Non-extractable copy of the private key for signing in this tab. */
  signingKey: CryptoKey
}

/** Person keys sign mandates. They are not chat keys. */
export async function generateSigningIdentity(): Promise<SigningIdentity> {
  const subtle = subtleCrypto()
  let signingPair: CryptoKeyPair
  try {
    signingPair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  } catch {
    throw new KeySupportError('Dieser Browser unterstützt Ed25519 noch nicht. Bitte aktuelles Safari, Chrome, Edge oder Firefox verwenden.')
  }
  const [publicKey, privateKey] = await Promise.all([
    subtle.exportKey('spki', signingPair.publicKey),
    subtle.exportKey('pkcs8', signingPair.privateKey),
  ])
  const signingKey = await subtle.importKey('pkcs8', privateKey, { name: 'Ed25519' }, false, ['sign'])
  return { publicKey: bytesToBase64(publicKey), privateKey: bytesToBase64(privateKey), signingKey }
}

/** Restores a person signing key from a file the user saved. The bytes stay in this tab. */
export async function importSigningIdentity(publicKey: string, privateKey: string): Promise<SigningIdentity> {
  const subtle = subtleCrypto()
  let signingKey: CryptoKey
  try {
    signingKey = await subtle.importKey('pkcs8', base64ToBytes(privateKey), { name: 'Ed25519' }, false, ['sign'])
  } catch {
    throw new KeySupportError('Die Schlüsseldatei konnte nicht gelesen werden.')
  }
  return { publicKey, privateKey, signingKey }
}

export async function generateAgentIdentity(): Promise<AgentIdentity> {
  const subtle = subtleCrypto()
  let signingPair: CryptoKeyPair
  let encryptionPair: CryptoKeyPair
  try {
    signingPair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
    encryptionPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair
  } catch {
    throw new KeySupportError('Dieser Browser unterstützt Ed25519/X25519 noch nicht. Bitte aktuelles Safari, Chrome, Edge oder Firefox verwenden.')
  }

  const [publicKey, privateKey, encryptionPublic, encryptionPrivate] = await Promise.all([
    subtle.exportKey('spki', signingPair.publicKey),
    subtle.exportKey('pkcs8', signingPair.privateKey),
    subtle.exportKey('spki', encryptionPair.publicKey),
    subtle.exportKey('pkcs8', encryptionPair.privateKey),
  ])

  // Re-import as non-extractable so the signing handle used by this tab cannot be exported again.
  const signingKey = await subtle.importKey('pkcs8', privateKey, { name: 'Ed25519' }, false, ['sign'])

  return {
    publicKey: bytesToBase64(publicKey),
    privateKey: bytesToBase64(privateKey),
    signingKey,
    encryption: {
      algorithm: 'X25519',
      publicKey: bytesToBase64(encryptionPublic),
      privateKey: bytesToBase64(encryptionPrivate),
    },
  }
}

export async function signCanonical(payload: unknown, signingKey: CryptoKey): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(payload)))
  const signature = await subtleCrypto().sign('Ed25519', signingKey, encoded)
  return bytesToBase64(signature)
}

export type SignedMutation<T extends Record<string, unknown>> = T & { timestamp: string; nonce: string; signature: string }

/** Adds timestamp and nonce, then signs, exactly like network-v2.js `signMutation`. */
export async function signMutation<T extends Record<string, unknown>>(
  payload: T,
  signingKey: CryptoKey,
  now: Date = new Date(),
): Promise<SignedMutation<T>> {
  const signed = { ...payload, timestamp: now.toISOString(), nonce: createNonce() }
  const signature = await signCanonical(signed, signingKey)
  return { ...signed, signature }
}

export function buildRecoveryKit(input: {
  beamId: string
  directoryUrl: string
  identity: AgentIdentity
  apiKey: string
  now?: Date
}): RecoveryKit {
  return {
    format: 'beam-identity-recovery',
    version: 1,
    createdAt: (input.now ?? new Date()).toISOString(),
    beamId: input.beamId,
    directoryUrl: input.directoryUrl,
    identity: {
      algorithm: 'Ed25519',
      publicKey: input.identity.publicKey,
      privateKey: input.identity.privateKey,
      encryption: input.identity.encryption,
    },
    credential: { apiKey: input.apiKey },
    notice: 'Keep this file private. It controls your Beam identity and is not stored by Beam.',
  }
}

export function recoveryKitFileName(beamId: string): string {
  return `${beamId.replace('@', '_at_')}-recovery.json`
}
