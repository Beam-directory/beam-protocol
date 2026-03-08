import type { AgentRow } from './types.js'
import { multibaseToRawEd25519, publicKeyBase64ToMultibase, rawEd25519ToPublicKeyBase64 } from './crypto.js'
import { getDirectoryIssuerDid, getDirectoryIssuerPublicKeyBase64 } from './issuer.js'

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
  controller?: string | string[]
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

type ResolverConfig = {
  getStoredDocument?: (did: string) => DIDDocument | null
  getAgentByBeamId?: (beamId: string) => AgentRow | null
  findAgentByHandle?: (handle: string) => AgentRow | null
}

const resolverConfig: ResolverConfig = {}

export function configureDIDResolver(config: ResolverConfig): void {
  resolverConfig.getStoredDocument = config.getStoredDocument
  resolverConfig.getAgentByBeamId = config.getAgentByBeamId
  resolverConfig.findAgentByHandle = config.findAgentByHandle
}

function getDirectoryBaseUrl(): string {
  return (process.env['BEAM_DIRECTORY_BASE_URL'] ?? 'https://beam.directory').replace(/\/$/, '')
}

function extractAgentHandle(beamId: string): string {
  return beamId.split('@')[0] ?? beamId
}

function extractOrgName(beamId: string): string | null {
  const [, domain] = beamId.split('@')
  if (domain === 'beam.directory') {
    return null
  }

  if (!domain?.endsWith('.beam.directory')) {
    return null
  }

  return domain.slice(0, -'.beam.directory'.length)
}

function createDocument(input: {
  did: string
  publicKeyBase64: string
  createdAt?: string
  updatedAt?: string
  alsoKnownAs?: string[]
  service?: ServiceEndpoint[]
  deactivated?: boolean
}): DIDDocument {
  const verificationMethodId = `${input.did}#key-1`

  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: input.did,
    ...(input.alsoKnownAs?.length ? { alsoKnownAs: input.alsoKnownAs } : {}),
    verificationMethod: [
      {
        id: verificationMethodId,
        type: 'Ed25519VerificationKey2020',
        controller: input.did,
        publicKeyMultibase: publicKeyBase64ToMultibase(input.publicKeyBase64),
      },
    ],
    authentication: [verificationMethodId],
    assertionMethod: [verificationMethodId],
    capabilityInvocation: [verificationMethodId],
    capabilityDelegation: [verificationMethodId],
    ...(input.service?.length ? { service: input.service } : {}),
    ...(input.createdAt ? { created: input.createdAt } : {}),
    ...(input.updatedAt ? { updated: input.updatedAt } : {}),
    ...(input.deactivated ? { deactivated: true } : {}),
  }
}

/** Convert a did:beam DID back to a beam_id. Returns null if not a valid did:beam. */
export function didToBeamId(did: string): string | null {
  if (!did.startsWith('did:beam:')) return null
  const parts = did.slice('did:beam:'.length).split(':')
  if (parts.length === 2) {
    // did:beam:org:agent → agent@org.beam.directory
    return `${parts[1]}@${parts[0]}.beam.directory`
  }
  if (parts.length === 1 && parts[0]) {
    // did:beam:agent → agent@beam.directory (personal)
    return `${parts[0]}@beam.directory`
  }
  return null
}

export function toBeamDID(beamId: string): string {
  if (beamId.startsWith('did:beam:')) {
    return beamId
  }

  if (beamId.startsWith('z')) {
    return `did:beam:${beamId}`
  }

  if (beamId.includes('@')) {
    const handle = extractAgentHandle(beamId)
    const org = extractOrgName(beamId)
    if (org) {
      return `did:beam:${org}:${handle}`
    }

    const [, domain] = beamId.split('@')
    if (domain === 'beam.directory') {
      return `did:beam:${handle}`
    }
  }

  return `did:beam:${beamId}`
}

export function generateDIDDocument(agent: AgentRow): DIDDocument {
  const did = toBeamDID(agent.beam_id)
  const baseUrl = getDirectoryBaseUrl()

  return createDocument({
    did,
    publicKeyBase64: agent.public_key,
    createdAt: agent.created_at,
    updatedAt: agent.last_seen,
    alsoKnownAs: agent.beam_id.includes('@') ? [agent.beam_id] : undefined,
    service: [
      {
        id: `${did}#directory`,
        type: 'BeamDirectoryService',
        serviceEndpoint: `${baseUrl}/agents/${encodeURIComponent(agent.beam_id)}`,
      },
      {
        id: `${did}#did-resolution`,
        type: 'DIDResolutionService',
        serviceEndpoint: `${baseUrl}/did/${encodeURIComponent(did)}`,
      },
    ],
  })
}

export function generateKeyBasedDIDDocument(did: string): DIDDocument | null {
  if (!did.startsWith('did:beam:z')) {
    return null
  }

  try {
    const multibase = did.slice('did:beam:'.length)
    const rawKey = multibaseToRawEd25519(multibase)
    return createDocument({
      did,
      publicKeyBase64: rawEd25519ToPublicKeyBase64(rawKey),
      service: [
        {
          id: `${did}#resolver`,
          type: 'DIDResolutionService',
          serviceEndpoint: `${getDirectoryBaseUrl()}/did/${encodeURIComponent(did)}`,
        },
      ],
    })
  } catch {
    return null
  }
}

export function generateDirectoryDIDDocument(): DIDDocument {
  return createDocument({
    did: getDirectoryIssuerDid(),
    publicKeyBase64: getDirectoryIssuerPublicKeyBase64(),
    service: [
      {
        id: `${getDirectoryIssuerDid()}#api`,
        type: 'BeamDirectoryService',
        serviceEndpoint: getDirectoryBaseUrl(),
      },
    ],
  })
}

export function deactivateDIDDocument(document: DIDDocument): DIDDocument {
  return {
    ...document,
    deactivated: true,
    updated: new Date().toISOString(),
  }
}

function resolvePersonalDID(methodSpecificId: string): DIDDocument | null {
  const stored = resolverConfig.getStoredDocument?.(`did:beam:${methodSpecificId}`) ?? null
  if (stored) {
    return stored
  }

  const agent = resolverConfig.findAgentByHandle?.(methodSpecificId) ?? null
  return agent ? generateDIDDocument(agent) : null
}

function resolveOrgBoundDID(org: string, agentName: string): DIDDocument | null {
  const did = `did:beam:${org}:${agentName}`
  const stored = resolverConfig.getStoredDocument?.(did) ?? null
  if (stored) {
    return stored
  }

  const beamId = `${agentName}@${org}.beam.directory`
  const agent = resolverConfig.getAgentByBeamId?.(beamId) ?? null
  return agent ? generateDIDDocument(agent) : null
}

export function resolveDID(did: string): DIDDocument | null {
  if (!did.startsWith('did:beam:')) {
    return null
  }

  const stored = resolverConfig.getStoredDocument?.(did) ?? null
  if (stored) {
    return stored
  }

  if (did.startsWith('did:beam:z')) {
    return generateKeyBasedDIDDocument(did)
  }

  const methodSpecificId = did.slice('did:beam:'.length)
  const segments = methodSpecificId.split(':')

  if (segments.length === 1) {
    return resolvePersonalDID(segments[0] ?? '')
  }

  if (segments.length === 2) {
    return resolveOrgBoundDID(segments[0] ?? '', segments[1] ?? '')
  }

  return null
}

async function fetchDidDocument(url: string): Promise<DIDDocument | null> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/did+json, application/json' },
    })

    if (!response.ok) {
      return null
    }

    return await response.json() as DIDDocument
  } catch {
    return null
  }
}

export async function resolveDIDWithFallbacks(did: string): Promise<DIDDocument | null> {
  const local = resolveDID(did)
  if (local) {
    return local
  }

  const baseUrl = getDirectoryBaseUrl()
  const apiDocument = await fetchDidDocument(`${baseUrl}/did/${encodeURIComponent(did)}`)
  if (apiDocument) {
    return apiDocument
  }

  const methodSpecificId = did.slice('did:beam:'.length)
  const segments = methodSpecificId.split(':')
  if (segments.length === 2) {
    const [org] = segments
    const dnsFallback = await fetchDidDocument(`https://${org}.beam.directory/.well-known/did.json`)
    if (dnsFallback) {
      return dnsFallback.id === did ? dnsFallback : null
    }

    return fetchDidDocument(`https://${org}.beam.directory/did/${encodeURIComponent(did)}`)
  }

  return null
}
