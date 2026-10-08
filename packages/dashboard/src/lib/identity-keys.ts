export type LocalEd25519Identity = {
  publicKeyBase64: string
  privateKeyBase64: string
  privateKeyPem: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function toPem(label: string, der: Uint8Array): string {
  const encoded = bytesToBase64(der)
  const lines = encoded.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`
}

export async function generateEd25519Identity(): Promise<LocalEd25519Identity> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('This browser cannot generate a Beam signing key')
  }
  const pair = await subtle.generateKey({ name: 'Ed25519' } as AlgorithmIdentifier, true, ['sign', 'verify']) as CryptoKeyPair
  const publicKey = new Uint8Array(await subtle.exportKey('spki', pair.publicKey))
  const privateKey = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey))
  return {
    publicKeyBase64: bytesToBase64(publicKey),
    privateKeyBase64: bytesToBase64(privateKey),
    privateKeyPem: toPem('PRIVATE KEY', privateKey),
  }
}

export function withLocalSigningKey<T extends { publicKey: string; publicKeyBase64: string }>(
  credential: T,
  keys: LocalEd25519Identity,
): T & { privateKey: string; privateKeyBase64: string } {
  if (credential.publicKey !== keys.publicKeyBase64) {
    throw new Error('Directory stored a different public key than this browser generated')
  }
  return {
    ...credential,
    privateKey: keys.privateKeyPem,
    privateKeyBase64: keys.privateKeyBase64,
  }
}
