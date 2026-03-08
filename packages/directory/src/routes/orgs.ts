import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentRow, OrgAgentRow, OrgRow, RegisterRequest } from '../types.js'
import {
  buildBeamDomain,
  createOrg,
  getOrg,
  listOrgAgents,
  markOrgVerified,
  registerAgent,
} from '../db.js'
import { seedAclsFromCatalog } from '../acl.js'

const ORG_NAME_RE = /^[a-z0-9_-]+$/
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
const AGENT_NAME_RE = /^[a-z0-9_-]+$/

function normalizeOrgName(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
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
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    verification: row.domain
      ? {
          txtName: `_beam-verification.${row.domain}`,
          txtValue: `beam-verification=${row.verification_token}`,
        }
      : null,
  }
}

function serializeOrgAgent(row: OrgAgentRow & Partial<AgentRow>): object {
  return {
    beamId: row.beam_id,
    agentName: row.agent_name,
    displayName: row.display_name,
    org: row.org_name,
    capabilities: JSON.parse(row.capabilities) as string[],
    publicKey: row.public_key,
    trustScore: row.trust_score ?? 0.3,
    verified: row.verified === 1,
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
    const domain = typeof raw['domain'] === 'string' && raw['domain'].trim()
      ? normalizeDomain(raw['domain'])
      : null

    if (!ORG_NAME_RE.test(name)) {
      return c.json({
        error: 'name must contain only lowercase letters, numbers, hyphens, or underscores',
        errorCode: 'INVALID_ORG_NAME',
      }, 400)
    }

    if (domain && !DOMAIN_RE.test(domain)) {
      return c.json({ error: 'domain must be a valid DNS hostname', errorCode: 'INVALID_DOMAIN' }, 400)
    }

    if (getOrg(db, name)) {
      return c.json({ error: `Organization ${name} already exists`, errorCode: 'ORG_EXISTS' }, 409)
    }

    if (domain) {
      const existingDomain = db.prepare('SELECT name FROM orgs WHERE domain = ? LIMIT 1').get(domain) as { name: string } | undefined
      if (existingDomain) {
        return c.json({ error: `Domain ${domain} is already claimed`, errorCode: 'DOMAIN_EXISTS' }, 409)
      }
    }

    const apiKey = createApiKey()
    const verificationToken = createVerificationToken()

    try {
      const org = createOrg(db, {
        name,
        displayName,
        domain,
        apiKeyHash: hashApiKey(apiKey),
        verificationToken,
      })
      return c.json({
        ...serializeOrg(org),
        apiKey,
      }, 201)
    } catch (err) {
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

    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const beamId = `${agentName}@${buildBeamDomain(name)}`
    const publicKeyBase64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
    const privateKeyBase64 = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64')

    const request: RegisterRequest = {
      beamId,
      displayName,
      capabilities,
      publicKey: publicKeyBase64,
      org: name,
    }

    try {
      const agent = registerAgent(db, request)
      seedAclsFromCatalog(db)
      return c.json({
        beamId,
        displayName: agent.display_name,
        org: agent.org,
        capabilities,
        publicKey: publicKeyBase64,
        privateKey: privateKeyBase64,
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

    if (!org.domain) {
      return c.json({ error: 'Organization has no DNS domain to verify', errorCode: 'NO_DOMAIN' }, 400)
    }

    const txtName = `_beam-verification.${org.domain}`
    const expected = `beam-verification=${org.verification_token}`

    try {
      const records = await resolveTxt(txtName)
      const values = records.map((entry) => entry.join(''))
      const matched = values.includes(expected)

      if (!matched) {
        return c.json({
          verified: false,
          txtName,
          expected,
          records: values,
          error: 'DNS TXT record not found',
          errorCode: 'TXT_NOT_FOUND',
        }, 409)
      }

      const updated = markOrgVerified(db, name)
      return c.json({
        verified: true,
        txtName,
        expected,
        org: updated ? serializeOrg(updated) : serializeOrg(org),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'DNS lookup failed'
      return c.json({
        verified: false,
        txtName,
        expected,
        error: message,
        errorCode: 'DNS_LOOKUP_FAILED',
      }, 502)
    }
  })

  return router
}
