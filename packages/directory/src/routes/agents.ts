import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentRow, RegisterRequest, VerificationTier } from '../types.js'
import { seedAclsFromCatalog } from '../acl.js'
import { toBeamDID } from '../did.js'
import { sendAgentVerificationEmail } from '../email.js'
import { BEAM_ID_RE } from '../validation.js'
import {
  createVerificationToken,
  getAgent,
  getAgentDirectoryStats,
  getAgentIntentStats,
  registerAgent,
  searchAgents,
  setAgentEmailToken,
  updateAgentProfile,
  updateLastSeen,
  verifyAgentEmailToken,
} from '../db.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ALLOWED_TIERS = new Set<VerificationTier>(['basic', 'verified', 'business', 'enterprise'])

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

function deriveOrg(email: string): string | null {
  if (!email) {
    return null
  }

  const domain = email.split('@')[1] ?? ''
  const label = domain.split('.')[0] ?? ''
  return slugify(label) || null
}

function parseBeamId(beamId: string): { org: string; personal: boolean } | null {
  const match = /^([a-z0-9_-]+)@(?:([a-z0-9_-]+)\.)?beam\.directory$/.exec(beamId)
  if (!match) {
    return null
  }

  return {
    org: match[2] ?? 'personal',
    personal: !match[2],
  }
}

function buildBeamId(baseName: string, org: string, personal: boolean, db: Database): string {
  const suffix = personal ? 'beam.directory' : `${org}.beam.directory`
  let candidate = `${baseName}@${suffix}`
  if (!getAgent(db, candidate)) {
    return candidate
  }

  for (let index = 2; index < 1000; index++) {
    candidate = `${baseName}-${index}@${suffix}`
    if (!getAgent(db, candidate)) {
      return candidate
    }
  }

  return `${baseName}-${Date.now()}@${suffix}`
}

function serializeAgent(row: AgentRow): object {
  const { email_token: _emailToken, ...agent } = row
  return {
    ...agent,
    did: toBeamDID(row.beam_id),
    capabilities: JSON.parse(row.capabilities) as string[],
    personal: row.personal === 1,
    verified: row.verified === 1 || row.verification_tier !== 'basic',
    flagged: row.flagged === 1,
    verificationTier: row.verification_tier,
  }
}

export function agentsRouter(db: Database): Hono {
  const router = new Hono()

  const handleVerifyEmail = (token: string | undefined | null) => {
    const verificationToken = token?.trim()
    if (!verificationToken) {
      return { status: 400 as const, body: { error: 'token is required', errorCode: 'MISSING_TOKEN' } }
    }

    const agent = verifyAgentEmailToken(db, verificationToken)
    if (!agent) {
      return {
        status: 400 as const,
        body: { error: 'Invalid or expired verification token', errorCode: 'INVALID_TOKEN' },
      }
    }

    return {
      status: 200 as const,
      body: {
        verified: true,
        agent: serializeAgent(agent),
      },
    }
  }

  router.get('/stats', (c) => {
    try {
      return c.json(getAgentDirectoryStats(db))
    } catch (err) {
      console.error('Agent stats error:', err)
      return c.json({ error: 'Failed to load agent stats', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.post('/register', async (c) => {
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
    if (email && !EMAIL_RE.test(email)) {
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

    // K5 FIX: Validate that publicKey is a valid Ed25519 SPKI-encoded key
    try {
      const { createPublicKey } = await import('node:crypto')
      createPublicKey({
        key: Buffer.from(publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      })
    } catch {
      return c.json({ error: 'Invalid Ed25519 public key — must be base64-encoded SPKI/DER format', errorCode: 'INVALID_PUBLIC_KEY_FORMAT' }, 400)
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
    let personal = false

    if (beamId) {
      if (!BEAM_ID_RE.test(beamId)) {
        return c.json({
          error: 'beamId must match pattern agent@org.beam.directory or agent@beam.directory (lowercase alphanumeric, hyphens, underscores)',
          errorCode: 'INVALID_BEAM_ID',
        }, 400)
      }

      const parsedBeamId = parseBeamId(beamId)
      if (!parsedBeamId) {
        return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
      }

      personal = parsedBeamId.personal
      org = org || parsedBeamId.org
    }

    if (!org) {
      org = deriveOrg(email) ?? 'personal'
      personal = org === 'personal'
    } else if (org === 'personal') {
      personal = true
    }

    if (!beamId) {
      const baseName = slugify(displayName) || slugify(email.split('@')[0] ?? '') || 'agent'
      beamId = buildBeamId(baseName, org, personal, db)
    }

    const parsedBeamId = parseBeamId(beamId)
    const orgFromId = parsedBeamId?.org
    if (!parsedBeamId || orgFromId !== org || parsedBeamId.personal !== personal) {
      return c.json({
        error: `org field (${org}) does not match org extracted from beamId (${orgFromId ?? 'unknown'})`,
        errorCode: 'ORG_MISMATCH',
      }, 400)
    }

    // Visibility: 'public' or 'unlisted' (default: unlisted for privacy)
    const requestedVisibility = typeof raw.visibility === 'string' ? raw.visibility.trim().toLowerCase() : 'unlisted'
    const visibility = requestedVisibility === 'public' ? 'public' : 'unlisted'

    // S4: Parse HTTP endpoint for P2P direct delivery
    let httpEndpoint: string | null = null
    const rawEndpoint = typeof raw.httpEndpoint === 'string' ? raw.httpEndpoint.trim() : typeof raw.http_endpoint === 'string' ? raw.http_endpoint.trim() : null
    if (rawEndpoint) {
      try {
        const endpointUrl = new URL(rawEndpoint)
        if (endpointUrl.protocol !== 'https:') return c.json({ error: 'httpEndpoint must use HTTPS', errorCode: 'INVALID_HTTP_ENDPOINT' }, 400)
        httpEndpoint = rawEndpoint
      } catch {
        return c.json({ error: 'httpEndpoint must be a valid HTTPS URL', errorCode: 'INVALID_HTTP_ENDPOINT' }, 400)
      }
    }

    // S5: Parse DH public key for E2E encryption (X25519)
    const dhPublicKey = typeof raw.dhPublicKey === 'string' ? raw.dhPublicKey.trim()
      : typeof raw.dh_public_key === 'string' ? raw.dh_public_key.trim()
      : null

    const request: RegisterRequest = {
      beamId,
      org,
      personal,
      displayName,
      capabilities,
      publicKey,
      email: email || undefined,
      emailVerified,
      description,
      logoUrl: cleanedLogoUrl,
      verificationTier: (requestedTier as VerificationTier | undefined) ?? (emailVerified ? 'verified' : 'basic'),
      visibility,
      httpEndpoint,
      dhPublicKey,
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
    const result = handleVerifyEmail(c.req.query('token'))
    return c.json(result.body, result.status)
  })

  router.get('/verify-email', (c) => {
    const result = handleVerifyEmail(c.req.query('token'))
    return c.json(result.body, result.status)
  })

  router.get('/search', (c) => {
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
        personal: orgParam === 'personal',
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
            row.personal === 1 ? 'personal' : '',
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

  // Toggle visibility (requires signed request or admin key)
  router.patch('/:beamId/visibility', async (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const agent = getAgent(db, beamId)
    if (!agent) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    const newVisibility = typeof body.visibility === 'string' ? body.visibility.trim().toLowerCase() : ''
    if (newVisibility !== 'public' && newVisibility !== 'unlisted') {
      return c.json({ error: 'visibility must be "public" or "unlisted"', errorCode: 'INVALID_VISIBILITY' }, 400)
    }

    // Auth: verify Ed25519 signature or admin key
    const signature = typeof body.signature === 'string' ? body.signature : ''
    const adminKey = c.req.header('x-admin-key') ?? ''
    const isAdmin = adminKey === process.env.BEAM_ADMIN_KEY

    if (!isAdmin) {
      const { verifyPayload } = await import('../crypto.js')
      const payload = { beamId, visibility: newVisibility, timestamp: body.timestamp }
      if (!signature || !verifyPayload(payload, signature, agent.public_key)) {
        return c.json({ error: 'Invalid signature or missing admin key', errorCode: 'UNAUTHORIZED' }, 401)
      }
    }

    try {
      db.prepare('UPDATE agents SET visibility = ? WHERE beam_id = ?').run(newVisibility, beamId)
      const updated = getAgent(db, beamId) as AgentRow
      return c.json({ ...serializeAgent(updated), visibility: newVisibility })
    } catch (err) {
      console.error('Visibility update error:', err)
      return c.json({ error: 'Failed to update visibility', errorCode: 'DB_ERROR' }, 500)
    }
  })

  // S4+S5: Update httpEndpoint and/or dhPublicKey
  router.patch('/:beamId/config', async (c) => {
    const beamId = c.req.param('beamId')
    if (!BEAM_ID_RE.test(beamId)) return c.json({ error: 'Invalid beam_id' }, 400)

    const agent = getAgent(db, beamId)
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    // Auth: admin key or Ed25519 signature
    const adminKey = c.req.header('x-admin-key') ?? ''
    const isAdmin = adminKey === process.env.BEAM_ADMIN_KEY

    if (!isAdmin) {
      const { verifyPayload } = await import('../crypto.js')
      const signature = typeof body.signature === 'string' ? body.signature : ''
      const payload = { beamId, action: 'config', timestamp: body.timestamp }
      if (!signature || !verifyPayload(payload, signature, agent.public_key)) {
        return c.json({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }, 401)
      }
    }

    const updates: string[] = []
    const params: unknown[] = []

    // S4: HTTP endpoint
    if ('httpEndpoint' in body || 'http_endpoint' in body) {
      const endpoint = String(body.httpEndpoint ?? body.http_endpoint ?? '').trim()
      if (endpoint) {
        try {
          const u = new URL(endpoint)
          if (u.protocol !== 'https:') return c.json({ error: 'httpEndpoint must use HTTPS' }, 400)
        } catch {
          return c.json({ error: 'Invalid httpEndpoint URL' }, 400)
        }
      }
      updates.push('http_endpoint = ?')
      params.push(endpoint || null)
    }

    // S5: DH public key for E2E
    if ('dhPublicKey' in body || 'dh_public_key' in body) {
      const dhKey = String(body.dhPublicKey ?? body.dh_public_key ?? '').trim()
      updates.push('dh_public_key = ?')
      params.push(dhKey || null)
    }

    if (updates.length === 0) return c.json({ error: 'No config fields to update' }, 400)

    params.push(beamId)
    db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE beam_id = ?`).run(...params)
    const updated = getAgent(db, beamId)!
    return c.json({
      beamId,
      httpEndpoint: updated.http_endpoint,
      dhPublicKey: updated.dh_public_key,
    })
  })

  // S5: Generate X25519 keypair (utility endpoint for agents)
  router.post('/keypair/x25519', async (c) => {
    const { generateX25519KeyPair } = await import('../shield/encryption.js')
    const pair = generateX25519KeyPair()
    return c.json({
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      algorithm: 'x25519',
      note: 'Store privateKey securely. Register publicKey as dhPublicKey on your agent.',
    })
  })

  return router
}
