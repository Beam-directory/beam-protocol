import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentRow, OrgAgentRow, OrgRow, RegisterRequest } from '../types.js'
import { toBeamDID } from '../did.js'
import {
  createOrg,
  deleteExpiredOrgClaim,
  getOrg,
  getOrgByDomain,
  listOrgAgents,
  logAuditEvent,
  markOrgVerified,
  registerAgent,
} from '../db.js'
import { seedAclsFromCatalog } from '../acl.js'
import { createAgentApiKey, hashApiKey as hashAgentApiKey } from '../api-key.js'
import { isEd25519Spki } from '../key-validation.js'
import { namespaceForDomain, namespaceMatchesDomain, registrableDomain } from '../trust/org-domain.js'
import { parseRegistryClaim } from '../trust/registry-format.js'
import {
  createOrgRegistryFiling,
  listOrgRegistryFilings,
  serializeOrgRegistryFiling,
} from '../trust/registry-store.js'
import { bodyContainsVerification, fetchWellKnownVerification, verificationRecord, wellKnownUrl } from '../trust/well-known.js'

const ORG_NAME_RE = /^[a-z0-9_-]+$/
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
const AGENT_NAME_RE = /^[a-z0-9_-]+$/

function normalizeOrgName(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function claimExpired(org: OrgRow, now = Date.now()): boolean {
  return org.verified !== 1
    && org.claim_expires_at !== null
    && Date.parse(org.claim_expires_at) <= now
}

function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex')
}

function createApiKey(): string {
  return `beam_org_${randomBytes(24).toString('base64url')}`
}

function createVerificationToken(): string {
  return randomBytes(18).toString('hex')
}

function getSuppliedApiKey(req: Request): string {
  const bearer = req.headers.get('authorization') ?? ''
  if (bearer.toLowerCase().startsWith('bearer ')) {
    return bearer.slice(7).trim()
  }
  return req.headers.get('x-api-key')?.trim() ?? ''
}

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function requireOrgApiKey(c: Context, org: OrgRow): Response | null {
  const supplied = getSuppliedApiKey(c.req.raw)
  if (!supplied) {
    return c.json({ error: 'Missing API key', errorCode: 'UNAUTHORIZED' }, 401)
  }

  const suppliedHash = hashApiKey(supplied)
  if (!safeCompare(suppliedHash, org.api_key_hash)) {
    return c.json({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }, 401)
  }

  return null
}

function serializeOrg(row: OrgRow): object {
  return {
    name: row.name,
    displayName: row.display_name,
    domain: row.domain,
    beamDomain: row.beam_domain,
    verified: row.verified === 1,
    claimExpiresAt: row.claim_expires_at,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    domainVerifiedVia: row.domain_verified_via,
    verification: row.domain
      ? {
          txtName: `_beam-verification.${row.domain}`,
          txtValue: verificationRecord(row.verification_token),
          wellKnownUrl: wellKnownUrl(row.domain),
          wellKnownBody: verificationRecord(row.verification_token),
        }
      : null,
  }
}

function serializeOrgAgent(row: OrgAgentRow & Partial<AgentRow>): object {
  return {
    beamId: row.beam_id,
    did: toBeamDID(row.beam_id),
    agentName: row.agent_name,
    displayName: row.display_name,
    org: row.org_name,
    capabilities: JSON.parse(row.capabilities) as string[],
    publicKey: row.public_key,
    trustScore: row.trust_score ?? 0.3,
    verified: row.verified === 1 || row.verification_tier !== 'basic',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeen: row.last_seen ?? row.created_at,
  }
}

export function orgsRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const name = normalizeOrgName(String(raw['name'] ?? ''))
    const displayName = typeof raw['displayName'] === 'string' && raw['displayName'].trim()
      ? raw['displayName'].trim()
      : name
    const suppliedDomain = typeof raw['domain'] === 'string' && raw['domain'].trim()
      ? normalizeDomain(raw['domain'])
      : ''

    if (!ORG_NAME_RE.test(name)) {
      return c.json({
        error: 'name must contain only lowercase letters, numbers, hyphens, or underscores',
        errorCode: 'INVALID_ORG_NAME',
      }, 400)
    }

    if (!suppliedDomain || !DOMAIN_RE.test(suppliedDomain)) {
      return c.json({ error: 'domain must be a valid DNS hostname', errorCode: 'INVALID_DOMAIN' }, 400)
    }

    // Claims are anchored at the registrable domain, so a delegated host such
    // as team.example.com cannot claim a different organization than example.com.
    // The namespace may be the domain label or the label plus public suffix.
    // That keeps coppen.de and coppen.at from sharing one identity.
    const domain = registrableDomain(suppliedDomain) ?? ''
    const allowedNamespace = namespaceForDomain(domain)
    if (!domain || !allowedNamespace) {
      return c.json({ error: 'domain must have a registrable DNS suffix', errorCode: 'INVALID_DOMAIN' }, 400)
    }

    if (!namespaceMatchesDomain(name, domain)) {
      return c.json({
        error: `Organization namespace ${name} must be ${allowedNamespace.label} or ${allowedNamespace.disambiguated} for ${domain}`,
        errorCode: 'ORG_NAMESPACE_DOMAIN_MISMATCH',
      }, 403)
    }

    const apiKey = createApiKey()
    const verificationToken = createVerificationToken()
    let reclaimedExpiredClaim = false

    try {
      const org = db.transaction(() => {
        const existingOrg = getOrg(db, name)
        if (existingOrg) {
          const released = claimExpired(existingOrg) && deleteExpiredOrgClaim(db, existingOrg.name)
          reclaimedExpiredClaim ||= released
          if (!released) {
            throw new OrgClaimConflictError(
              existingOrg.verified === 1 ? 'ORG_EXISTS' : 'ORG_CLAIM_PENDING',
              `Organization ${name} already exists`,
            )
          }
        }

        const existingDomain = getOrgByDomain(db, domain)
        if (existingDomain) {
          const released = claimExpired(existingDomain) && deleteExpiredOrgClaim(db, existingDomain.name)
          reclaimedExpiredClaim ||= released
          if (!released) {
            throw new OrgClaimConflictError(
              existingDomain.verified === 1 ? 'DOMAIN_EXISTS' : 'DOMAIN_CLAIM_PENDING',
              `Domain ${domain} is already claimed`,
            )
          }
        }

        return createOrg(db, {
          name,
          displayName,
          domain,
          apiKeyHash: hashApiKey(apiKey),
          verificationToken,
        })
      })()
      logAuditEvent(db, {
        action: reclaimedExpiredClaim ? 'org.claim.reclaimed' : 'org.claim.created',
        actor: `org:${name}`,
        target: name,
        details: { domain, claimExpiresAt: org.claim_expires_at },
      })
      c.header('Cache-Control', 'no-store')
      return c.json({
        ...serializeOrg(org),
        apiKey,
      }, 201)
    } catch (err) {
      if (err instanceof OrgClaimConflictError) {
        return c.json({ error: err.message, errorCode: err.errorCode }, 409)
      }
      console.error('Org registration error:', err)
      return c.json({ error: 'Failed to register organization', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/:name', (c) => {
    const name = normalizeOrgName(c.req.param('name'))
    const org = getOrg(db, name)
    if (!org) {
      return c.json({ error: `Organization ${name} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    const auth = requireOrgApiKey(c, org)
    if (auth) {
      return auth
    }

    try {
      const agents = listOrgAgents(db, name)
      return c.json({
        org: serializeOrg(org),
        agents: agents.map(serializeOrgAgent),
        total: agents.length,
      })
    } catch (err) {
      console.error('Org fetch error:', err)
      return c.json({ error: 'Failed to load organization', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.post('/:name/agents', async (c) => {
    const name = normalizeOrgName(c.req.param('name'))
    const org = getOrg(db, name)
    if (!org) {
      return c.json({ error: `Organization ${name} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    const auth = requireOrgApiKey(c, org)
    if (auth) {
      return auth
    }

    if (claimExpired(org)) {
      return c.json({
        error: 'Organization claim has expired; register the namespace again',
        errorCode: 'ORG_CLAIM_EXPIRED',
      }, 410)
    }

    if (org.verified !== 1) {
      return c.json({
        error: 'Organization domain must be verified before creating organization Beam IDs',
        errorCode: 'ORG_VERIFICATION_REQUIRED',
      }, 403)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const agentName = String(raw['agentName'] ?? '').trim().toLowerCase()
    const displayName = typeof raw['displayName'] === 'string' && raw['displayName'].trim()
      ? raw['displayName'].trim()
      : agentName
    const capabilities = Array.isArray(raw['capabilities'])
      ? raw['capabilities'].filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
      : []

    if (!AGENT_NAME_RE.test(agentName)) {
      return c.json({
        error: 'agentName must contain only lowercase letters, numbers, hyphens, or underscores',
        errorCode: 'INVALID_AGENT_NAME',
      }, 400)
    }

    if (Array.isArray(raw['capabilities']) && capabilities.length !== raw['capabilities'].length) {
      return c.json({ error: 'capabilities must be an array of strings', errorCode: 'INVALID_CAPABILITIES' }, 400)
    }

    const existing = db.prepare(
      'SELECT 1 FROM org_agents WHERE org_name = ? AND agent_name = ? LIMIT 1'
    ).get(name, agentName) as { 1: number } | undefined
    if (existing) {
      return c.json({ error: `Agent ${agentName} already exists`, errorCode: 'AGENT_EXISTS' }, 409)
    }

    const publicKeyBase64 = String(raw['publicKey'] ?? raw['public_key'] ?? '').trim()
    if (!isEd25519Spki(publicKeyBase64)) {
      return c.json({
        error: 'publicKey must be a client-generated Ed25519 SPKI key. The directory does not generate private keys.',
        errorCode: 'PUBLIC_KEY_REQUIRED',
      }, 400)
    }

    const beamId = `${agentName}@${org.beam_domain}`
    const apiKey = createAgentApiKey(beamId)

    const request: RegisterRequest = {
      beamId,
      displayName,
      capabilities,
      publicKey: publicKeyBase64,
      apiKeyHash: hashAgentApiKey(apiKey),
      org: name,
    }

    try {
      const agent = registerAgent(db, request)
      seedAclsFromCatalog(db)
      logAuditEvent(db, {
        action: 'org.agent.created',
        actor: `org:${name}`,
        target: beamId,
        details: { org: name, capabilities },
      })
      c.header('Cache-Control', 'no-store')
      return c.json({
        beamId,
        did: toBeamDID(beamId),
        displayName: agent.display_name,
        org: agent.org,
        capabilities,
        publicKey: publicKeyBase64,
        publicKeyBase64,
        apiKey,
        trustScore: agent.trust_score,
        verified: agent.verified === 1,
        createdAt: agent.created_at,
        lastSeen: agent.last_seen,
      }, 201)
    } catch (err) {
      console.error('Org agent registration error:', err)
      return c.json({ error: 'Failed to register agent', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.post('/:name/verify', async (c) => {
    const name = normalizeOrgName(c.req.param('name'))
    const org = getOrg(db, name)
    if (!org) {
      return c.json({ error: `Organization ${name} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    const auth = requireOrgApiKey(c, org)
    if (auth) {
      return auth
    }

    if (claimExpired(org)) {
      return c.json({
        error: 'Organization claim has expired; register the namespace again',
        errorCode: 'ORG_CLAIM_EXPIRED',
      }, 410)
    }

    if (!org.domain) {
      return c.json({ error: 'Organization has no DNS domain to verify', errorCode: 'NO_DOMAIN' }, 400)
    }

    let method: 'dns' | 'well-known' = 'dns'
    if ((c.req.header('content-type') ?? '').includes('application/json')) {
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
      }
      if (body && typeof body === 'object' && !Array.isArray(body) && 'method' in body) {
        const requested = (body as Record<string, unknown>)['method']
        if (requested !== 'dns' && requested !== 'well-known') {
          return c.json({ error: 'method must be dns or well-known', errorCode: 'INVALID_VERIFICATION_METHOD' }, 400)
        }
        method = requested
      }
    }

    const txtName = `_beam-verification.${org.domain}`
    const expected = verificationRecord(org.verification_token)

    try {
      const matched = method === 'dns'
        ? await dnsTxtMatches(txtName, expected)
        : await wellKnownMatches(org.domain, org.verification_token)
      if (!matched.ok) {
        return c.json({
          verified: false,
          method,
          txtName,
          wellKnownUrl: wellKnownUrl(org.domain),
          expected,
          records: matched.records,
          error: matched.error,
          errorCode: matched.errorCode,
        }, matched.status)
      }

      const updated = markOrgVerified(db, name, method)
      logAuditEvent(db, {
        action: 'org.domain.verified',
        actor: `org:${name}`,
        target: name,
        details: { domain: org.domain, method, txtName },
      })
      return c.json({
        verified: true,
        method,
        txtName,
        wellKnownUrl: wellKnownUrl(org.domain),
        expected,
        org: updated ? serializeOrg(updated) : serializeOrg(org),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Domain verification failed'
      return c.json({
        verified: false,
        method,
        txtName,
        wellKnownUrl: wellKnownUrl(org.domain),
        expected,
        error: message,
        errorCode: method === 'dns' ? 'DNS_LOOKUP_FAILED' : 'WELL_KNOWN_LOOKUP_FAILED',
      }, 502)
    }
  })

  router.post('/:name/registry', async (c) => {
    const loaded = loadOwnedOrg(c, db)
    if (loaded instanceof Response) {
      return loaded
    }
    const { name, org } = loaded
    if (org.verified !== 1) {
      return c.json({
        error: 'Verify the organization domain before submitting a registry filing',
        errorCode: 'ORG_VERIFICATION_REQUIRED',
      }, 403)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }
    const parsed = parseRegistryClaim(body as Record<string, unknown>)
    if ('error' in parsed) {
      return c.json({ error: parsed.error, errorCode: 'INVALID_REGISTRY' }, 400)
    }

    const filing = createOrgRegistryFiling(db, name, parsed.claim)
    logAuditEvent(db, {
      action: 'org.registry.submitted',
      actor: `org:${name}`,
      target: `${name}:${filing.id}`,
      details: {
        kind: filing.kind,
        country: filing.country,
        registrationNumber: filing.registration_number,
        applicantRole: filing.applicant_role,
        status: filing.status,
      },
    })
    return c.json({ filing: serializeOrgRegistryFiling(filing) }, 201)
  })

  router.get('/:name/registry', (c) => {
    const loaded = loadOwnedOrg(c, db)
    if (loaded instanceof Response) {
      return loaded
    }
    const filings = listOrgRegistryFilings(db, loaded.name)
    return c.json({
      filings: filings.map(serializeOrgRegistryFiling),
      total: filings.length,
    })
  })

  return router
}

function loadOwnedOrg(
  c: Context,
  db: Database,
): { name: string; org: OrgRow } | Response {
  const name = normalizeOrgName(c.req.param('name') ?? '')
  const org = getOrg(db, name)
  if (!org) {
    return c.json({ error: `Organization ${name} not found`, errorCode: 'NOT_FOUND' }, 404)
  }
  const auth = requireOrgApiKey(c, org)
  if (auth) {
    return auth
  }
  if (claimExpired(org)) {
    return c.json({
      error: 'Organization claim has expired; register the namespace again',
      errorCode: 'ORG_CLAIM_EXPIRED',
    }, 410)
  }
  return { name, org }
}

async function wellKnownMatches(
  domain: string,
  token: string,
): Promise<{ ok: true } | { ok: false; error: string; errorCode: string; status: 409; records: string[] }> {
  const body = await fetchWellKnownVerification(domain)
  if (!bodyContainsVerification(body, token)) {
    return {
      ok: false,
      error: 'Well-known verification record not found',
      errorCode: 'WELL_KNOWN_NOT_FOUND',
      status: 409,
      records: [],
    }
  }
  return { ok: true }
}

async function dnsTxtMatches(
  txtName: string,
  expected: string,
): Promise<{ ok: true } | { ok: false; error: string; errorCode: string; status: 409; records: string[] }> {
  const records = await resolveTxt(txtName)
  const values = records.map((entry) => entry.join(''))
  if (!values.includes(expected)) {
    return {
      ok: false,
      error: 'DNS TXT record not found',
      errorCode: 'TXT_NOT_FOUND',
      status: 409,
      records: values,
    }
  }
  return { ok: true }
}

class OrgClaimConflictError extends Error {
  constructor(
    readonly errorCode: 'ORG_EXISTS' | 'ORG_CLAIM_PENDING' | 'DOMAIN_EXISTS' | 'DOMAIN_CLAIM_PENDING',
    message: string,
  ) {
    super(message)
    this.name = 'OrgClaimConflictError'
  }
}
