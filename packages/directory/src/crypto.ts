import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey, type KeyObject } from 'node:crypto'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const ED25519_MULTICODEC_PREFIX = Buffer.from([0xed, 0x01])

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson)
  }

  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key])
    }
    return sorted
  }

  return value
}

function base64UrlToBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = (4 - (normalized.length % 4)) % 4
  return Buffer.from(normalized.padEnd(normalized.length + padding, '='), 'base64')
}

export function bufferToBase64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base58Encode(value: Uint8Array): string {
  if (value.length === 0) {
    return ''
  }

  const digits = [0]
  for (const byte of value) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      const next = (digits[index] ?? 0) * 256 + carry
      digits[index] = next % 58
      carry = Math.floor(next / 58)
    }

    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }

  let result = ''
  for (const byte of value) {
    if (byte !== 0) break
    result += BASE58_ALPHABET[0]
  }

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    result += BASE58_ALPHABET[digits[index] ?? 0]
  }

  return result
}

export function base58Decode(value: string): Buffer {
  if (!value) {
    return Buffer.alloc(0)
  }

  const bytes = [0]
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char)
    if (digit < 0) {
      throw new Error(`Invalid base58 character: ${char}`)
    }

    let carry = digit
    for (let index = 0; index < bytes.length; index += 1) {
      const next = (bytes[index] ?? 0) * 58 + carry
      bytes[index] = next & 0xff
      carry = next >> 8
    }

    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  let leadingZeroes = 0
  for (const char of value) {
    if (char !== BASE58_ALPHABET[0]) break
    leadingZeroes += 1
  }

  const decoded = Buffer.alloc(leadingZeroes + bytes.length)
  for (let index = 0; index < leadingZeroes; index += 1) {
    decoded[index] = 0
  }

  for (let index = 0; index < bytes.length; index += 1) {
    decoded[decoded.length - 1 - index] = bytes[index] ?? 0
  }

  return decoded
}

export function publicKeyBase64ToRawEd25519(publicKeyBase64: string): Buffer {
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  })

  const exported = publicKey.export({ format: 'jwk' }) as JsonWebKey
  if (exported.kty !== 'OKP' || exported.crv !== 'Ed25519' || typeof exported.x !== 'string') {
    throw new Error('Expected an Ed25519 public key')
  }

  return base64UrlToBuffer(exported.x)
}

export function publicKeyBase64ToMultibase(publicKeyBase64: string): string {
  const rawKey = publicKeyBase64ToRawEd25519(publicKeyBase64)
  return `z${base58Encode(Buffer.concat([ED25519_MULTICODEC_PREFIX, rawKey]))}`
}

export function multibaseToRawEd25519(multibase: string): Buffer {
  if (!multibase.startsWith('z')) {
    throw new Error('Expected a base58btc multibase key')
  }

  const decoded = base58Decode(multibase.slice(1))
  if (decoded.length !== 34 || !decoded.subarray(0, 2).equals(ED25519_MULTICODEC_PREFIX)) {
    throw new Error('Expected an Ed25519 multicodec key')
  }

  return decoded.subarray(2)
}

export function rawEd25519ToPublicKeyBase64(rawKey: Buffer): string {
  if (rawKey.length !== 32) {
    throw new Error('Ed25519 public keys must be 32 bytes')
  }

  const jwk: JsonWebKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: bufferToBase64Url(rawKey),
  }
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' })
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
}

export function signPayload(payload: unknown, privateKey: KeyObject | string): string {
  const keyObject = typeof privateKey === 'string'
    ? createPrivateKey({
        key: Buffer.from(privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      })
    : privateKey

  return sign(null, Buffer.from(canonicalizeJson(payload), 'utf8'), keyObject).toString('base64')
}

export function verifyPayload(payload: unknown, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    const keyObject = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })

    const payloadString = typeof payload === 'string'
      ? payload
      : canonicalizeJson(payload)

    return verify(
      null,
      Buffer.from(payloadString, 'utf8'),
      keyObject,
      Buffer.from(signatureBase64, 'base64')
    )
  } catch {
    return false
  }
}
