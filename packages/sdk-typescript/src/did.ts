import { createPublicKey, verify, type JsonWebKey } from 'node:crypto'
import { BeamIdentity } from './identity.js'

export type ServiceEndpointValue = string | string[] | Record<string, unknown>

export interface VerificationMethod {
  id: string
  type: 'Ed25519VerificationKey2020'
  controller: string
  publicKeyMultibase: string
}

export interface ServiceEndpoint {
  id: string
  type: string
  serviceEndpoint: ServiceEndpointValue
}

export interface DIDDocument {
  '@context': string[]
  id: string
  alsoKnownAs?: string[]
  verificationMethod: VerificationMethod[]
  authentication: string[]
  assertionMethod: string[]
  capabilityInvocation: string[]
  capabilityDelegation: string[]
  service?: ServiceEndpoint[]
  created?: string
  updated?: string
  deactivated?: boolean
}

export interface CredentialSubject {
  id: string
  email?: string
  domain?: string
  business?: Record<string, unknown>
  verified: boolean
}

export interface Proof {
  type: 'Ed25519Signature2020'
  created: string
  proofPurpose: 'assertionMethod'
  verificationMethod: string
  proofValue: string
  publicKeyMultibase: string
}

export interface VerifiableCredential {
  '@context': string[]
  id: string
  type: string[]
  issuer: string
  issuanceDate: string
  credentialSubject: CredentialSubject
  proof: Proof
}

type BeamDIDConfig = {
  baseUrl: string
  identity?: BeamIdentity
}

type CreateOptions = {
  beamId?: string
  publicKey?: string
  format?: 'personal' | 'org' | 'key'
  createdAt?: string
  updatedAt?: string
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

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

function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function base64UrlToBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = (4 - (normalized.length % 4)) % 4
  return Buffer.from(normalized.padEnd(normalized.length + padding, '='), 'base64')
}

function bufferToBase64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base58Encode(value: Uint8Array): string {
  if (value.length === 0) return ''
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

function base58Decode(value: string): Buffer {
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
  for (let index = 0; index < bytes.length; index += 1) {
    decoded[decoded.length - 1 - index] = bytes[index] ?? 0
  }
  return decoded
}

function publicKeyBase64ToMultibase(publicKeyBase64: string): string {
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('Expected Ed25519 public key')
  }
  const rawKey = base64UrlToBuffer(jwk.x)
  return `z${base58Encode(Buffer.concat([Buffer.from([0xed, 0x01]), rawKey]))}`
}

function multibaseToPublicKeyBase64(multibase: string): string {
  if (!multibase.startsWith('z')) {
    throw new Error('Expected base58btc key')
  }

  const decoded = base58Decode(multibase.slice(1))
  const rawKey = decoded.subarray(2)
  const jwk: JsonWebKey = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: bufferToBase64Url(rawKey),
  }
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' })
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
}

function extractParts(beamId: string): { handle: string; org: string | null } {
  if (!beamId.includes('@')) {
    return { handle: beamId, org: null }
  }

  const [handle, domain] = beamId.split('@')
  const org = domain?.endsWith('.beam.directory')
    ? domain.slice(0, -'.beam.directory'.length)
    : null
  return { handle: handle ?? beamId, org }
}

function buildDocument(input: {
  did: string
  publicKey: string
  beamId: string
  baseUrl: string
  createdAt?: string
  updatedAt?: string
}): DIDDocument {
  const verificationMethodId = `${input.did}#key-1`
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: input.did,
    alsoKnownAs: [input.beamId],
    verificationMethod: [{
      id: verificationMethodId,
      type: 'Ed25519VerificationKey2020',
      controller: input.did,
      publicKeyMultibase: publicKeyBase64ToMultibase(input.publicKey),
    }],
    authentication: [verificationMethodId],
    assertionMethod: [verificationMethodId],
    capabilityInvocation: [verificationMethodId],
    capabilityDelegation: [verificationMethodId],
    service: [{
      id: `${input.did}#resolver`,
      type: 'DIDResolutionService',
      serviceEndpoint: `${input.baseUrl.replace(/\/$/, '')}/did/${encodeURIComponent(input.did)}`,
    }],
    ...(input.createdAt ? { created: input.createdAt } : {}),
    ...(input.updatedAt ? { updated: input.updatedAt } : {}),
  }
}

export class BeamDID {
  private readonly baseUrl: string
  private readonly identity?: BeamIdentity

  constructor(config: BeamDIDConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.identity = config.identity
  }

  create(options: CreateOptions = {}): DIDDocument {
    const beamId = options.beamId ?? this.identity?.beamId
    const publicKey = options.publicKey ?? this.identity?.publicKeyBase64

    if (!beamId || !publicKey) {
      throw new Error('beamId and publicKey are required to create a DID document')
    }

    const { handle, org } = extractParts(beamId)
    const format = options.format ?? (org ? 'org' : 'personal')
    const did = format === 'key'
      ? `did:beam:${publicKeyBase64ToMultibase(publicKey)}`
      : format === 'personal'
        ? `did:beam:${handle}`
        : `did:beam:${org ?? 'beam'}:${handle}`

    return buildDocument({
      did,
      publicKey,
      beamId,
      baseUrl: this.baseUrl,
      createdAt: options.createdAt,
      updatedAt: options.updatedAt,
    })
  }

  async resolve(did: string): Promise<DIDDocument | null> {
    const response = await fetch(`${this.baseUrl}/did/${encodeURIComponent(did)}`, {
      headers: { Accept: 'application/did+json' },
    })

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw new Error(`DID resolution failed: ${response.status} ${response.statusText}`)
    }

    return response.json() as Promise<DIDDocument>
  }

  update(document: DIDDocument, patch: Partial<DIDDocument>): DIDDocument {
    return {
      ...document,
      ...patch,
      updated: new Date().toISOString(),
    }
  }

  deactivate(document: DIDDocument): DIDDocument {
    return {
      ...document,
      deactivated: true,
      updated: new Date().toISOString(),
    }
  }
}

export class CredentialVerifier {
  static verify(vc: VerifiableCredential): boolean {
    try {
      const { proof, ...unsignedCredential } = vc
      if (proof.verificationMethod !== `${vc.issuer}#key-1` || proof.proofPurpose !== 'assertionMethod') {
        return false
      }

      const publicKeyBase64 = multibaseToPublicKeyBase64(proof.publicKeyMultibase)
      const publicKey = createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      })

      return verify(
        null,
        Buffer.from(canonicalizeJson(unsignedCredential), 'utf8'),
        publicKey,
        Buffer.from(proof.proofValue, 'base64')
      )
    } catch {
      return false
    }
  }
}

export class BeamCredentialsClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  async issueEmailVC(beamId: string, email: string): Promise<VerifiableCredential> {
    return this.post('/credentials/email', { beamId, email })
  }

  async issueDomainVC(beamId: string, domain: string): Promise<VerifiableCredential> {
    return this.post('/credentials/domain', { beamId, domain })
  }

  async issueBusinessVC(beamId: string, businessInfo: Record<string, unknown>): Promise<VerifiableCredential> {
    return this.post('/credentials/business', { beamId, businessInfo })
  }

  verify(vc: VerifiableCredential): boolean {
    return CredentialVerifier.verify(vc)
  }

  private async post(path: string, body: Record<string, unknown>): Promise<VerifiableCredential> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Credential request failed: ${response.status} ${response.statusText}`)
    }

    return response.json() as Promise<VerifiableCredential>
  }
}
