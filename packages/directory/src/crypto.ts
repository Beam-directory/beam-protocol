import { createPublicKey, verify } from 'node:crypto'

function toPublicKey(publicKeyBase64: string) {
  return createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  })
}

export function verifySignedPayload(
  publicKeyBase64: string,
  payload: string,
  signatureBase64: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(payload, 'utf8'),
      toPublicKey(publicKeyBase64),
      Buffer.from(signatureBase64, 'base64'),
    )
  } catch {
    return false
  }
}
