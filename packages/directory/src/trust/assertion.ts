import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { canonicalizeJson, signPayload } from '../crypto.js'
import { getAgent, getOrg } from '../db.js'
import { requireStableDirectoryIssuer } from '../issuer.js'
import { getActiveMandate, type MandateRow } from './mandate-store.js'
import { getPerson } from './person-store.js'
import { listOrgRegistryFilings } from './registry-store.js'
import { parseScopeGrant, type ScopeGrant } from './scopes.js'

export const ASSERTION_TTL_MS = 15 * 60 * 1000
const MIN_ASSERTION_TTL_MS = 60 * 1000
const DEFAULT_MAX_ASSERTION_TTL_MS = 24 * 60 * 60 * 1000
const HARD_MAX_ASSERTION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Longest lifetime an agent may request for its own stapled assertion. */
export function maxAssertionTtlMs(): number {
  const raw = Number(process.env['BEAM_TRUST_ASSERTION_MAX_TTL_SECONDS'])
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_ASSERTION_TTL_MS
  return Math.min(Math.max(raw * 1000, MIN_ASSERTION_TTL_MS), HARD_MAX_ASSERTION_TTL_MS)
}

/** Clamp a requested lifetime in seconds. Invalid or missing values fall back to the short default. */
export function requestedAssertionTtlMs(raw: string | undefined): number {
  if (raw === undefined || !/^\d{1,7}$/.test(raw)) return ASSERTION_TTL_MS
  return Math.min(Math.max(Number(raw) * 1000, MIN_ASSERTION_TTL_MS), maxAssertionTtlMs())
}

export type TrustAssertion = {
  v: 1
  beamId: string
  /** The agent's current Ed25519 key (SPKI, base64). Binds stapled assertions to message signatures. */
  agentKey: string
  org: {
    name: string
    domain: string | null
    verified: boolean
    registryStatus: 'none' | 'pending' | 'approved' | 'rejected'
  } | null
  person: { ref: string; role: string; kycStatus: string } | null
  mandate: {
    jti: string
    scopes: ScopeGrant
    expiresAt: string
    escalationPersonRef: string | null
  } | null
  suspended: boolean
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

function personRef(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

function mandateView(row: MandateRow | null): TrustAssertion['mandate'] {
  if (!row) return null
  const scopes = parseScopeGrant(JSON.parse(row.scopes_json) as unknown)
  if (!scopes) return null
  return {
    jti: row.jti,
    scopes,
    expiresAt: row.expires_at,
    escalationPersonRef: row.escalation_person_id ? personRef(row.escalation_person_id) : null,
  }
}

export function buildTrustAssertion(
  db: Database,
  beamId: string,
  now = new Date(),
  ttlMs = ASSERTION_TTL_MS,
): TrustAssertion {
  const issuer = requireStableDirectoryIssuer()
  const agent = getAgent(db, beamId)
  if (!agent) {
    throw new Error(`Agent ${beamId} not found`)
  }

  const org = agent.org ? getOrg(db, agent.org) : null
  const person = agent.responsible_person_id ? getPerson(db, agent.responsible_person_id) : null
  const mandate = getActiveMandate(db, beamId, now.toISOString())
  const issuedAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  const unsigned = {
    v: 1 as const,
    beamId,
    agentKey: agent.public_key,
    org: org
      ? {
          name: org.name,
          domain: org.domain,
          verified: org.verified === 1,
          registryStatus: registryStatus(db, org.name),
        }
      : null,
    person: person
      ? { ref: personRef(person.id), role: person.role, kycStatus: person.kyc_status }
      : null,
    mandate: mandateView(mandate),
    suspended: Boolean(agent.suspended_at) || person?.status === 'offboarded' || Boolean(org?.suspended_at),
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
