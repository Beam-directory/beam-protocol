import { randomUUID } from 'node:crypto'
import { canonicalizeJson, multibaseToRawEd25519, rawEd25519ToPublicKeyBase64, signPayload, verifyPayload } from './crypto.js'
import { toBeamDID } from './did.js'
import { getDirectoryIssuerDid, getDirectoryIssuerPrivateKey, getDirectoryIssuerPublicKeyMultibase } from './issuer.js'

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

function buildCredential(input: {
  beamId: string
  type: string
  subject: Omit<CredentialSubject, 'id' | 'verified'>
}): VerifiableCredential {
  const issuanceDate = new Date().toISOString()
  const issuer = getDirectoryIssuerDid()
  const unsignedCredential = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: `urn:uuid:${randomUUID()}`,
    type: ['VerifiableCredential', input.type],
    issuer,
    issuanceDate,
    credentialSubject: {
      id: toBeamDID(input.beamId),
      ...input.subject,
      verified: true,
    },
  }

  const proof: Proof = {
    type: 'Ed25519Signature2020',
    created: issuanceDate,
    proofPurpose: 'assertionMethod',
    verificationMethod: `${issuer}#key-1`,
    proofValue: signPayload(unsignedCredential, getDirectoryIssuerPrivateKey()),
    publicKeyMultibase: getDirectoryIssuerPublicKeyMultibase(),
  }

  return {
    ...unsignedCredential,
    proof,
  }
}

export function issueEmailVC(beamId: string, email: string): VerifiableCredential {
  return buildCredential({
    beamId,
    type: 'EmailVerificationCredential',
    subject: { email: email.trim().toLowerCase() },
  })
}

export function issueDomainVC(beamId: string, domain: string): VerifiableCredential {
  return buildCredential({
    beamId,
    type: 'DomainVerificationCredential',
    subject: { domain: domain.trim().toLowerCase() },
  })
}

export function issueBusinessVC(beamId: string, businessInfo: Record<string, unknown>): VerifiableCredential {
  return buildCredential({
    beamId,
    type: 'BusinessVerificationCredential',
    subject: { business: businessInfo },
  })
}

export function verifyCredential(vc: VerifiableCredential): boolean {
  if (!vc || typeof vc !== 'object' || !vc.proof || vc.credentialSubject?.verified !== true) {
    return false
  }

  try {
    const issuerDid = getDirectoryIssuerDid()
    const issuerKeyMultibase = getDirectoryIssuerPublicKeyMultibase()
    const { proof, ...unsignedCredential } = vc

    if (vc.issuer !== issuerDid) {
      return false
    }
    if (proof.type !== 'Ed25519Signature2020' || proof.proofPurpose !== 'assertionMethod') {
      return false
    }
    if (proof.verificationMethod !== `${issuerDid}#key-1`) {
      return false
    }
    if (proof.publicKeyMultibase !== issuerKeyMultibase) {
      return false
    }

    const publicKeyBase64 = rawEd25519ToPublicKeyBase64(multibaseToRawEd25519(issuerKeyMultibase))
    return verifyPayload(unsignedCredential, proof.proofValue, publicKeyBase64)
  } catch {
    return false
  }
}

export function canonicalizeCredential(vc: Omit<VerifiableCredential, 'proof'>): string {
  return canonicalizeJson(vc)
}
