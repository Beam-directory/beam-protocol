import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentRow, RegisterRequest, VerificationTier } from '../types.js'
import { seedAclsFromCatalog } from '../acl.js'
import { toBeamDID } from '../did.js'
import {
  getAgent,
  getAgentDirectoryStats,
  getAgentIntentStats,
  registerAgent,
  searchAgents,
  setAgentEmailToken,
  updateAgentProfile,
  updateLastSeen,
} from '../db.js'

const requests = new Map<string, { count: number; resetAt: number }>()
const BEAM_ID_RE = /^[a-z0-9_-]+@[a-z0-9_-]+\.beam\.directory$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ALLOWED_TIERS = new Set<VerificationTier>(['basic', 'verified', 'business', 'enterprise'])

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

setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of requests.entries()) {
    if (now > entry.resetAt) requests.delete(key)
  }
}, 5 * 60_000)

function parseCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const capabilities = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)

  return capabilities.length === value.length ? capabilities : null
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 32)
}

function deriveOrg(email: string): string {
  const domain = email.split('@')[1] ?? 'public'
  const label = domain.split('.')[0] ?? 'public'
  return slugify(label) || 'public'
}

function buildBeamId(baseName: string, org: string, db: Database): string {
  let candidate = `${baseName}@${org}.beam.directory`
  if (!getAgent(db, candidate)) {
    return candidate
  }

  for (let index = 2; index < 1000; index++) {
    candidate = `${baseName}-${index}@${org}.beam.directory`
    if (!getAgent(db, candidate)) {
      return candidate
    }
  }

  return `${baseName}-${Date.now()}@${org}.beam.directory`
}

function serializeAgent(row: AgentRow): object {
  const { email_token: _emailToken, ...agent } = row
  return {
    ...row,
    did: toBeamDID(row.beam_id),
    capabilities: JSON.parse(row.capabilities) as string[],
    verified: row.verified === 1 || row.verification_tier === 'verified',
    flagged: row.flagged === 1,
    verificationTier: row.verification_tier,
  }
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

export function agentsRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/stats', (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    try {
      return c.json(getAgentDirectoryStats(db))
    } catch (err) {
      console.error('Agent stats error:', err)
      return c.json({ error: 'Failed to load agent stats', errorCode: 'DB_ERROR' }, 500)
    }
  })

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

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const capabilities = parseCapabilities(raw.capabilities)
    if (!capabilities) {
      return c.json({ error: 'capabilities must be an array of strings', errorCode: 'INVALID_CAPABILITIES' }, 400)
    }

    const displayName = typeof raw.displayName === 'string'
      ? raw.displayName.trim()
      : typeof raw.display_name === 'string'
        ? raw.display_name.trim()
        : ''
    if (!displayName) {
      return c.json({ error: 'display_name must be a non-empty string', errorCode: 'INVALID_DISPLAY_NAME' }, 400)
    }

    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : ''
    if (!EMAIL_RE.test(email)) {
      return c.json({ error: 'email must be a valid email address', errorCode: 'INVALID_EMAIL' }, 400)
    }

    const publicKey = typeof raw.publicKey === 'string'
      ? raw.publicKey.trim()
      : typeof raw.public_key === 'string'
        ? raw.public_key.trim()
        : ''
    if (!publicKey) {
      return c.json({ error: 'public_key must be a non-empty string', errorCode: 'INVALID_PUBLIC_KEY' }, 400)
    }

    const description = typeof raw.description === 'string' && raw.description.trim()
      ? raw.description.trim()
      : null
    const logoUrl = typeof raw.logoUrl === 'string'
      ? raw.logoUrl.trim()
      : typeof raw.logo_url === 'string'
        ? raw.logo_url.trim()
        : ''
    const cleanedLogoUrl = logoUrl || null
    if (cleanedLogoUrl) {
      try {
        new URL(cleanedLogoUrl)
      } catch {
        return c.json({ error: 'logo_url must be a valid absolute URL', errorCode: 'INVALID_LOGO_URL' }, 400)
      }
    }

    const emailVerified = raw.emailVerified === true || raw.email_verified === true
    const requestedTier = typeof raw.verificationTier === 'string'
      ? raw.verificationTier
      : typeof raw.verification_tier === 'string'
        ? raw.verification_tier
        : undefined
    if (requestedTier && !ALLOWED_TIERS.has(requestedTier as VerificationTier)) {
      return c.json({ error: 'verification_tier is invalid', errorCode: 'INVALID_VERIFICATION_TIER' }, 400)
    }

    let beamId = typeof raw.beamId === 'string' ? raw.beamId.trim().toLowerCase() : ''
    let org = typeof raw.org === 'string' ? raw.org.trim().toLowerCase() : ''

    if (beamId) {
      if (!BEAM_ID_RE.test(beamId)) {
        return c.json({
          error: 'beamId must match pattern agent@org.beam.directory (lowercase alphanumeric, hyphens, underscores)',
          errorCode: 'INVALID_BEAM_ID',
        }, 400)
      }
      org = org || beamId.split('@')[1]?.split('.')[0] || ''
    }

    if (!org) {
      org = deriveOrg(email)
    }

    if (!beamId) {
      const baseName = slugify(displayName) || slugify(email.split('@')[0] ?? '') || 'agent'
      beamId = buildBeamId(baseName, org, db)
    }

    const orgFromId = beamId.split('@')[1]?.split('.')[0]
    if (orgFromId !== org) {
      return c.json({
        error: `org field (${org}) does not match org extracted from beamId (${orgFromId ?? 'unknown'})`,
        errorCode: 'ORG_MISMATCH',
      }, 400)
    }

    const request: RegisterRequest = {
      beamId,
      org,
      displayName,
      capabilities,
      publicKey,
      email,
      emailVerified,
      description,
      logoUrl: cleanedLogoUrl,
      verificationTier: (requestedTier as VerificationTier | undefined) ?? (emailVerified ? 'verified' : 'basic'),
    }

    try {
      let agent = registerAgent(db, request)
      let verificationEmailSent = false

      if (request.email) {
        const token = randomBytes(24).toString('hex')
        createVerificationToken(db, {
          token,
          beam_id: request.beamId,
          email: request.email,
          expires_at: Date.now() + 24 * 60 * 60 * 1000,
        })
        setAgentEmailToken(db, request.beamId, token)
        agent = getAgent(db, request.beamId) as AgentRow

        try {
          verificationEmailSent = await sendAgentVerificationEmail({
            email: request.email,
            beamId: request.beamId,
            token,
          })
        } catch (error) {
          console.error('Verification email error:', error)
        }
      }

      seedAclsFromCatalog(db)
      return c.json({
        ...serializeAgent(agent),
        verification_email_sent: verificationEmailSent,
      }, 201)
    } catch (err) {
      console.error('Registration error:', err)
      return c.json({ error: 'Failed to register agent', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/search', (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    const orgParam = c.req.query('org')
    const capabilitiesParam = c.req.query('capabilities')
    const minTrustScoreParam = c.req.query('minTrustScore')
    const limitParam = c.req.query('limit')
    const q = c.req.query('q')?.trim().toLowerCase()
    const verificationTier = c.req.query('verificationTier')?.trim().toLowerCase()

    const capabilities = capabilitiesParam
      ? capabilitiesParam.split(',').map((value) => value.trim()).filter(Boolean)
      : undefined

    let minTrustScore: number | undefined
    if (minTrustScoreParam !== undefined) {
      const parsed = parseFloat(minTrustScoreParam)
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
        return c.json({ error: 'minTrustScore must be a number between 0 and 1', errorCode: 'INVALID_PARAM' }, 400)
      }
      minTrustScore = parsed
    }

    let limit: number | undefined
    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam, 10)
      if (Number.isNaN(parsed) || parsed < 1) {
        return c.json({ error: 'limit must be a positive integer', errorCode: 'INVALID_PARAM' }, 400)
      }
      limit = parsed
    }

    try {
      let rows = searchAgents(db, {
        org: orgParam,
        capabilities,
        minTrustScore,
        limit,
      })

      if (verificationTier && ALLOWED_TIERS.has(verificationTier as VerificationTier)) {
        rows = rows.filter((row) => row.verification_tier === verificationTier)
      }

      if (q) {
        rows = rows.filter((row) => {
          const haystack = [
            row.beam_id,
            row.display_name,
            row.org,
            row.description ?? '',
            row.capabilities,
          ].join(' ').toLowerCase()
          return haystack.includes(q)
        })
      }

      return c.json({ agents: rows.map(serializeAgent), total: rows.length })
    } catch (err) {
      console.error('Search error:', err)
      return c.json({ error: 'Search failed', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/:beamId', (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    const beamId = decodeURIComponent(c.req.param('beamId'))
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    try {
      const agent = getAgent(db, beamId)
      if (!agent) {
        return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
      }

      return c.json({
        ...serializeAgent(agent),
        intentStats: getAgentIntentStats(db, beamId),
      })
    } catch (err) {
      console.error('Get agent error:', err)
      return c.json({ error: 'Failed to retrieve agent', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.post('/:beamId/heartbeat', (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    const beamId = decodeURIComponent(c.req.param('beamId'))
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
