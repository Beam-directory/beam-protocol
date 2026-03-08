import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentRow, RegisterRequest } from '../types.js'
import { seedAclsFromCatalog } from '../acl.js'
import { toBeamDID } from '../did.js'
import {
  registerAgent,
  getAgent,
  searchAgents,
  updateLastSeen,
} from '../db.js'

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

const requests = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string, limit = 60): boolean {
  const now = Date.now()
  const entry = requests.get(ip)
  if (!entry || now > entry.resetAt) {
    requests.set(ip, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (entry.count >= limit) return false
  entry.count++
  return true
}

// Periodically prune stale entries to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of requests.entries()) {
    if (now > entry.resetAt) requests.delete(key)
  }
}, 5 * 60_000)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BEAM_ID_RE = /^[a-z0-9_-]+@[a-z0-9_-]+\.beam\.directory$/

function serializeAgent(row: AgentRow): object {
  return {
    ...row,
    did: toBeamDID(row.beam_id),
    capabilities: JSON.parse(row.capabilities) as string[],
    verified: row.verified === 1,
  }
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function agentsRouter(db: Database): Hono {
  const router = new Hono()

  // -------------------------------------------------------------------------
  // POST /agents/register
  // -------------------------------------------------------------------------
  router.post('/register', async (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip, 30)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body)
    ) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>

    // Validate beamId
    if (typeof raw['beamId'] !== 'string' || !BEAM_ID_RE.test(raw['beamId'])) {
      return c.json({
        error: 'beamId must match pattern agent@org.beam.directory (lowercase alphanumeric, hyphens, underscores)',
        errorCode: 'INVALID_BEAM_ID',
      }, 400)
    }

    // Validate publicKey
    if (typeof raw['publicKey'] !== 'string' || raw['publicKey'].trim().length === 0) {
      return c.json({ error: 'publicKey must be a non-empty string', errorCode: 'INVALID_PUBLIC_KEY' }, 400)
    }

    // Validate capabilities
    if (
      !Array.isArray(raw['capabilities']) ||
      !(raw['capabilities'] as unknown[]).every((c) => typeof c === 'string')
    ) {
      return c.json({ error: 'capabilities must be an array of strings', errorCode: 'INVALID_CAPABILITIES' }, 400)
    }

    // Validate displayName
    if (typeof raw['displayName'] !== 'string' || raw['displayName'].trim().length === 0) {
      return c.json({ error: 'displayName must be a non-empty string', errorCode: 'INVALID_DISPLAY_NAME' }, 400)
    }

    // Validate org
    if (typeof raw['org'] !== 'string' || raw['org'].trim().length === 0) {
      return c.json({ error: 'org must be a non-empty string', errorCode: 'INVALID_ORG' }, 400)
    }

    const beamId = raw['beamId'] as string
    const org = raw['org'] as string

    // Ensure org in beamId matches provided org
    const orgFromId = beamId.split('@')[1]  // e.g. "acme.beam.directory"
    const orgSlug = orgFromId?.split('.')[0] // e.g. "acme"
    if (orgSlug !== org) {
      return c.json({
        error: `org field (${org}) does not match org extracted from beamId (${orgSlug ?? 'unknown'})`,
        errorCode: 'ORG_MISMATCH',
      }, 400)
    }

    const request: RegisterRequest = {
      beamId,
      displayName: (raw['displayName'] as string).trim(),
      capabilities: raw['capabilities'] as string[],
      publicKey: (raw['publicKey'] as string).trim(),
      org,
    }

    try {
      const agent = registerAgent(db, request)
      seedAclsFromCatalog(db)
      return c.json(serializeAgent(agent), 201)
    } catch (err) {
      console.error('Registration error:', err)
      return c.json({ error: 'Failed to register agent', errorCode: 'DB_ERROR' }, 500)
    }
  })

  // -------------------------------------------------------------------------
  // GET /agents/search
  // -------------------------------------------------------------------------
  router.get('/search', (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    const orgParam = c.req.query('org')
    const capabilitiesParam = c.req.query('capabilities')
    const minTrustScoreParam = c.req.query('minTrustScore')
    const limitParam = c.req.query('limit')

    const capabilities = capabilitiesParam
      ? capabilitiesParam.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined

    let minTrustScore: number | undefined
    if (minTrustScoreParam !== undefined) {
      const parsed = parseFloat(minTrustScoreParam)
      if (isNaN(parsed) || parsed < 0 || parsed > 1) {
        return c.json({ error: 'minTrustScore must be a number between 0 and 1', errorCode: 'INVALID_PARAM' }, 400)
      }
      minTrustScore = parsed
    }

    let limit: number | undefined
    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam, 10)
      if (isNaN(parsed) || parsed < 1) {
        return c.json({ error: 'limit must be a positive integer', errorCode: 'INVALID_PARAM' }, 400)
      }
      limit = parsed
    }

    try {
      const rows = searchAgents(db, {
        org: orgParam,
        capabilities,
        minTrustScore,
        limit,
      })
      return c.json({ agents: rows.map(serializeAgent), total: rows.length })
    } catch (err) {
      console.error('Search error:', err)
      return c.json({ error: 'Search failed', errorCode: 'DB_ERROR' }, 500)
    }
  })

  // -------------------------------------------------------------------------
  // GET /agents/:beamId
  // -------------------------------------------------------------------------
  router.get('/:beamId', (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    const rawId = c.req.param('beamId')
    const beamId = decodeURIComponent(rawId)

    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    try {
      const agent = getAgent(db, beamId)
      if (!agent) {
        return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
      }
      return c.json(serializeAgent(agent))
    } catch (err) {
      console.error('Get agent error:', err)
      return c.json({ error: 'Failed to retrieve agent', errorCode: 'DB_ERROR' }, 500)
    }
  })

  // -------------------------------------------------------------------------
  // POST /agents/:beamId/heartbeat
  // -------------------------------------------------------------------------
  router.post('/:beamId/heartbeat', (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    const rawId = c.req.param('beamId')
    const beamId = decodeURIComponent(rawId)

    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    try {
      const existing = getAgent(db, beamId)
      if (!existing) {
        return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
      }

      updateLastSeen(db, beamId)

      const updated = getAgent(db, beamId) as AgentRow
      return c.json(serializeAgent(updated))
    } catch (err) {
      console.error('Heartbeat error:', err)
      return c.json({ error: 'Heartbeat failed', errorCode: 'DB_ERROR' }, 500)
    }
  })

  return router
}
