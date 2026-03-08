import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { publicKeyBase64ToMultibase } from './crypto.js'

const DEFAULT_DIRECTORY_DID = 'did:beam:beam:directory'

type IssuerIdentity = {
  did: string
  privateKey: KeyObject
  publicKey: KeyObject
  publicKeyBase64: string
  publicKeyMultibase: string
}

let cachedIdentity: IssuerIdentity | null = null

function loadIdentityFromEnv(): IssuerIdentity | null {
  const privateKeyBase64 = process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY']
  const publicKeyBase64 = process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY']

  if (!privateKeyBase64 || !publicKeyBase64) {
    return null
  }

  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  })

  return {
    did: process.env['BEAM_DIRECTORY_DID'] ?? DEFAULT_DIRECTORY_DID,
    privateKey,
    publicKey,
    publicKeyBase64,
    publicKeyMultibase: publicKeyBase64ToMultibase(publicKeyBase64),
  }
}

function createEphemeralIdentity(): IssuerIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyBase64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')

  return {
    did: process.env['BEAM_DIRECTORY_DID'] ?? DEFAULT_DIRECTORY_DID,
    privateKey,
    publicKey,
    publicKeyBase64,
    publicKeyMultibase: publicKeyBase64ToMultibase(publicKeyBase64),
  }
}

export function getDirectoryIssuerIdentity(): IssuerIdentity {
  if (!cachedIdentity) {
    cachedIdentity = loadIdentityFromEnv() ?? createEphemeralIdentity()
  }

  return cachedIdentity
}

export function getDirectoryIssuerDid(): string {
  return getDirectoryIssuerIdentity().did
}

export function getDirectoryIssuerPublicKeyBase64(): string {
  return getDirectoryIssuerIdentity().publicKeyBase64
}

export function getDirectoryIssuerPublicKeyMultibase(): string {
  return getDirectoryIssuerIdentity().publicKeyMultibase
}

export function getDirectoryIssuerPrivateKey(): KeyObject {
  return getDirectoryIssuerIdentity().privateKey
}
