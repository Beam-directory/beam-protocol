import { createPublicKey } from 'node:crypto'

function isSpkiKey(publicKey: string, algorithm: 'ed25519' | 'x25519'): boolean {
  if (!publicKey || publicKey.length > 512) return false
  try {
    const parsed = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
    return parsed.asymmetricKeyType === algorithm
  } catch {
    return false
  }
}

export function isEd25519Spki(publicKey: string): boolean {
  return isSpkiKey(publicKey, 'ed25519')
}

export function isX25519Spki(publicKey: string): boolean {
  return isSpkiKey(publicKey, 'x25519')
}
