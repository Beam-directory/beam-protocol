import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentRow, RegisterRequest } from '../types.js'
import { seedAclsFromCatalog } from '../acl.js'
import {
  browseAgents,
  createVerificationToken,
  deleteVerificationToken,
  getAgent,
  getAgentStats,
  getVerificationToken,
  markAgentEmailVerified,
  recordNonce,
  registerAgent,
  searchAgents,
  setAgentEmailToken,
  updateAgentProfile,
  updateLastSeen,
} from '../db.js'
import { sendAgentVerificationEmail } from '../email.js'

const requests = new Map<string, { count: number; resetAt: number }>()
const BEAM_ID_RE = /^[a-z0-9_-]+@(?:[a-z0-9_-]+\.)?beam\.directory$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PROFILE_SIGNATURE_WINDOW_MS = 5 * 60 * 1000
const VALID_VERIFICATION_TIERS = new Set(['basic', 'verified', 'business', 'enterprise'])

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

function serializeAgent(row: AgentRow): object {
  const { email_token: _emailToken, ...agent } = row
  return {
    ...agent,
    capabilities: JSON.parse(row.capabilities) as string[],
    verified: row.verified === 1,
    email_verified: row.email_verified === 1,
  }
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

function getOrgFromBeamId(beamId: string): string | null {
  const domain = beamId.split('@')[1] ?? ''
  if (domain === 'beam.directory') {
    return null
  }
  if (!domain.endsWith('.beam.directory')) {
    return null
  }
  return domain.slice(0, -'.beam.directory'.length)
}

function normalizeOptionalText(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeOptionalEmail(value: unknown): string | null | undefined {
  const normalized = normalizeOptionalText(value)
  if (normalized === undefined || normalized === null) {
    return normalized
  }
  return normalized.toLowerCase()
}

function buildProfileSignaturePayload(input: {
  beamId: string
  profile: { description?: string | null; logo_url?: string | null; website?: string | null }
  timestamp: string
  nonce: string
}): string {
  return JSON.stringify({
    type: 'agent_profile_update',
    beamId: input.beamId,
    profile: {
      description: input.profile.description ?? null,
      logo_url: input.profile.logo_url ?? null,
      website: input.profile.website ?? null,
    },
    timestamp: input.timestamp,
    nonce: input.nonce,
  })
}

function verifyProfileSignature(input: {
  publicKeyBase64: string
  beamId: string
  profile: { description?: string | null; logo_url?: string | null; website?: string | null }
  timestamp: string
  nonce: string
  signature: string
}): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(input.publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })

    return verify(
      null,
      Buffer.from(buildProfileSignaturePayload(input), 'utf8'),
      publicKey,
      Buffer.from(input.signature, 'base64')
    )
  } catch {
    return false
  }
}

export function agentsRouter(db: Database): Hono {
  const router = new Hono()

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
    const beamId = typeof raw['beamId'] === 'string' ? raw['beamId'].trim() : ''
    const displayName = typeof raw['displayName'] === 'string' ? raw['displayName'].trim() : ''
    const publicKey = typeof raw['publicKey'] === 'string' ? raw['publicKey'].trim() : ''
    const suppliedOrg = normalizeOptionalText(raw['org'])
    const email = normalizeOptionalEmail(raw['email'])

    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({
        error: 'beamId must match pattern agent@beam.directory or agent@org.beam.directory',
        errorCode: 'INVALID_BEAM_ID',
      }, 400)
    }

    if (!publicKey) {
      return c.json({ error: 'publicKey must be a non-empty string', errorCode: 'INVALID_PUBLIC_KEY' }, 400)
    }

    if (!Array.isArray(raw['capabilities']) || !(raw['capabilities'] as unknown[]).every((value) => typeof value === 'string')) {
      return c.json({ error: 'capabilities must be an array of strings', errorCode: 'INVALID_CAPABILITIES' }, 400)
    }

    if (!displayName) {
      return c.json({ error: 'displayName must be a non-empty string', errorCode: 'INVALID_DISPLAY_NAME' }, 400)
    }

    if (email !== undefined && email !== null && !EMAIL_RE.test(email)) {
      return c.json({ error: 'email must be a valid email address', errorCode: 'INVALID_EMAIL' }, 400)
    }

    const orgFromBeamId = getOrgFromBeamId(beamId)
    if (orgFromBeamId === null && suppliedOrg) {
      return c.json({
        error: 'org must be omitted for personal Beam IDs using beam.directory',
        errorCode: 'ORG_MISMATCH',
      }, 400)
    }

    if (orgFromBeamId !== null && suppliedOrg && suppliedOrg !== orgFromBeamId) {
      return c.json({
        error: `org field (${suppliedOrg}) does not match org extracted from beamId (${orgFromBeamId})`,
        errorCode: 'ORG_MISMATCH',
      }, 400)
    }

    const request: RegisterRequest = {
      beamId,
      displayName,
      capabilities: raw['capabilities'] as string[],
      publicKey,
      org: orgFromBeamId,
      email: email ?? null,
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

  router.get('/verify', (c) => {
    const token = c.req.query('token')?.trim() ?? ''
    if (!token) {
      return c.json({ error: 'token query parameter is required', errorCode: 'MISSING_TOKEN' }, 400)
    }

    try {
      const verificationToken = getVerificationToken(db, token)
      if (!verificationToken) {
        return c.json({ error: 'Verification token is invalid', errorCode: 'INVALID_TOKEN' }, 404)
      }

      if (verificationToken.expires_at < Date.now()) {
        deleteVerificationToken(db, token)
        return c.json({ error: 'Verification token has expired', errorCode: 'TOKEN_EXPIRED' }, 410)
      }

      const agent = markAgentEmailVerified(db, verificationToken.beam_id, verificationToken.email)
      if (!agent) {
        deleteVerificationToken(db, token)
        return c.json({ error: 'Agent not found', errorCode: 'NOT_FOUND' }, 404)
      }

      return c.json({
        verified: true,
        beam_id: verificationToken.beam_id,
        email: verificationToken.email,
      })
    } catch (error) {
      console.error('Verification error:', error)
      return c.json({ error: 'Failed to verify email', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/stats', (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    try {
      return c.json(getAgentStats(db))
    } catch (error) {
      console.error('Agent stats error:', error)
      return c.json({ error: 'Failed to load agent stats', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/browse', (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    const capabilityParam = c.req.query('capability')
    const verificationTier = c.req.query('verification_tier')
    const verifiedOnlyParam = c.req.query('verified_only')
    const pageParam = c.req.query('page')
    const limitParam = c.req.query('limit')

    if (verificationTier && !VALID_VERIFICATION_TIERS.has(verificationTier)) {
      return c.json({ error: 'verification_tier is invalid', errorCode: 'INVALID_PARAM' }, 400)
    }

    const page = pageParam ? Number.parseInt(pageParam, 10) : 1
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 20
    if (Number.isNaN(page) || page < 1 || Number.isNaN(limit) || limit < 1) {
      return c.json({ error: 'page and limit must be positive integers', errorCode: 'INVALID_PARAM' }, 400)
    }

    const verifiedOnly = verifiedOnlyParam === undefined
      ? false
      : ['1', 'true', 'yes'].includes(verifiedOnlyParam.toLowerCase())

    try {
      const result = browseAgents(db, {
        capability: capabilityParam?.split(',').map((value) => value.trim()).filter(Boolean),
        verificationTier: verificationTier as AgentRow['verification_tier'] | undefined,
        verifiedOnly,
        page,
        limit,
      })

      return c.json({
        agents: result.rows.map(serializeAgent),
        total: result.total,
        page: result.page,
        limit: result.limit,
        total_pages: result.total === 0 ? 0 : Math.ceil(result.total / result.limit),
      })
    } catch (error) {
      console.error('Browse agents error:', error)
      return c.json({ error: 'Failed to browse agents', errorCode: 'DB_ERROR' }, 500)
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

    const capabilities = capabilitiesParam
      ? capabilitiesParam.split(',').map((s) => s.trim()).filter(Boolean)
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
      const rows = searchAgents(db, {
        org: orgParam || undefined,
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
      return c.json(serializeAgent(agent))
    } catch (err) {
      console.error('Get agent error:', err)
      return c.json({ error: 'Failed to retrieve agent', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.patch('/:beamId/profile', async (c) => {
    const ip = getClientIp(c.req.raw)
    if (!checkRateLimit(ip, 30)) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    const beamId = decodeURIComponent(c.req.param('beamId'))
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const agent = getAgent(db, beamId)
    if (!agent) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
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
    const profile = {
      description: normalizeOptionalText(raw['description']),
      logo_url: normalizeOptionalText(raw['logo_url']),
      website: normalizeOptionalText(raw['website']),
    }

    if (Object.values(profile).every((value) => value === undefined)) {
      return c.json({ error: 'At least one profile field must be provided', errorCode: 'INVALID_BODY' }, 400)
    }

    const timestamp = c.req.header('x-beam-timestamp')?.trim() ?? ''
    const nonce = c.req.header('x-beam-nonce')?.trim() ?? ''
    const signature = c.req.header('x-beam-signature')?.trim() ?? ''
    if (!timestamp || !nonce || !signature) {
      return c.json({ error: 'Missing signature headers', errorCode: 'UNAUTHORIZED' }, 401)
    }

    const timestampValue = Date.parse(timestamp)
    if (Number.isNaN(timestampValue) || Math.abs(Date.now() - timestampValue) > PROFILE_SIGNATURE_WINDOW_MS) {
      return c.json({ error: 'Timestamp outside allowed replay window', errorCode: 'INVALID_TIMESTAMP' }, 400)
    }

    if (!recordNonce(db, nonce)) {
      return c.json({ error: 'Replay detected', errorCode: 'REPLAY_DETECTED' }, 409)
    }

    const isValid = verifyProfileSignature({
      publicKeyBase64: agent.public_key,
      beamId,
      profile,
      timestamp,
      nonce,
      signature,
    })

    if (!isValid) {
      return c.json({ error: 'Invalid signature', errorCode: 'UNAUTHORIZED' }, 401)
    }

    try {
      const updated = updateAgentProfile(db, beamId, profile)
      return c.json(serializeAgent(updated as AgentRow))
    } catch (error) {
      console.error('Update agent profile error:', error)
      return c.json({ error: 'Failed to update agent profile', errorCode: 'DB_ERROR' }, 500)
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
      return c.json(serializeAgent(getAgent(db, beamId) as AgentRow))
    } catch (err) {
      console.error('Heartbeat error:', err)
      return c.json({ error: 'Heartbeat failed', errorCode: 'DB_ERROR' }, 500)
    }
  })

  return router
}
