import type { Database } from 'better-sqlite3'
import { canonicalizeJson, signPayload } from '../crypto.js'
import { getAgent, getOrg } from '../db.js'
import { requireStableDirectoryIssuer } from '../issuer.js'
import { getActiveMandate, type MandateRow } from './mandate-store.js'
import { getPerson } from './person-store.js'
import { listOrgRegistryFilings } from './registry-store.js'
import { parseScopeGrant, type ScopeGrant } from './scopes.js'

const ASSERTION_TTL_MS = 15 * 60 * 1000

export type TrustAssertion = {
  v: 1
  beamId: string
  org: {
    name: string
    domain: string | null
    verified: boolean
    registryStatus: 'none' | 'pending' | 'approved' | 'rejected'
  } | null
  person: { id: string; role: string; kycStatus: string } | null
  mandate: {
    jti: string
    scopes: ScopeGrant
    expiresAt: string
    escalationPersonId: string | null
  } | null
  issuedAt: string
  expiresAt: string
  signature: string
  publicKey: string
}

function registryStatus(db: Database, orgName: string): 'none' | 'pending' | 'approved' | 'rejected' {
  const filings = listOrgRegistryFilings(db, orgName)
  if (filings.some((filing) => filing.status === 'approved')) {
    return 'approved'
  }
  return filings[0]?.status ?? 'none'
}

function mandateView(row: MandateRow | null): TrustAssertion['mandate'] {
  if (!row) return null
  const scopes = parseScopeGrant(JSON.parse(row.scopes_json) as unknown)
  if (!scopes) return null
  return {
    jti: row.jti,
    scopes,
    expiresAt: row.expires_at,
    escalationPersonId: row.escalation_person_id,
  }
}

export function buildTrustAssertion(db: Database, beamId: string, now = new Date()): TrustAssertion {
  const issuer = requireStableDirectoryIssuer()
  const agent = getAgent(db, beamId)
  if (!agent) {
    throw new Error(`Agent ${beamId} not found`)
  }

  const org = agent.org ? getOrg(db, agent.org) : null
  const person = agent.responsible_person_id ? getPerson(db, agent.responsible_person_id) : null
  const mandate = getActiveMandate(db, beamId, now.toISOString())
  const issuedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + ASSERTION_TTL_MS).toISOString()
  const unsigned = {
    v: 1 as const,
    beamId,
    org: org
      ? {
          name: org.name,
          domain: org.domain,
          verified: org.verified === 1,
          registryStatus: registryStatus(db, org.name),
        }
      : null,
    person: person
      ? { id: person.id, role: person.role, kycStatus: person.kyc_status }
      : null,
    mandate: mandateView(mandate),
    issuedAt,
    expiresAt,
  }
  const signature = signPayload(unsigned, issuer.privateKey)
  return {
    ...unsigned,
    signature,
    publicKey: issuer.publicKeyBase64,
  }
}

export function loadTrustAssertion(db: Database, beamId: string): TrustAssertion | null {
  try {
    return buildTrustAssertion(db, beamId)
  } catch {
    return null
  }
}

export function assertionSignedPayload(assertion: TrustAssertion): string {
  const { signature: _signature, publicKey: _publicKey, ...unsigned } = assertion
  return canonicalizeJson(unsigned)
}
