import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { createAgentApiKey, hashApiKey } from '../api-key.js'
import {
  completeIdentityClaim,
  createIdentityClaim,
  deleteIdentityClaim,
  getIdentityClaim,
  listAgentKeys,
} from '../db.js'
import { sendIdentityClaimEmail } from '../email.js'
import { serializeAgent } from '../utils/serialize.js'
import { isEd25519Spki, isX25519Spki } from '../key-validation.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/
const CLAIM_TTL_MS = 30 * 60 * 1000
const LOCAL_CLAIM_LINKS_ENABLED = () => process.env['BEAM_ALLOW_LOCAL_CLAIM_URLS'] === 'true'

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function publicSiteUrl(): string {
  return process.env['PUBLIC_SITE_URL']?.trim() || 'https://beam.directory'
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  const visible = local.slice(0, Math.min(2, local.length))
  return `${visible}${'*'.repeat(Math.max(2, local.length - visible.length))}@${domain}`
}

export function identityClaimsRouter(db: Database): Hono {
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
    const email = typeof raw['email'] === 'string' ? raw['email'].trim().toLowerCase() : ''
    const handle = typeof raw['handle'] === 'string' ? raw['handle'].trim().toLowerCase() : ''
    const displayName = typeof raw['displayName'] === 'string' ? raw['displayName'].trim() : ''

    if (!EMAIL_RE.test(email)) {
      return c.json({ error: 'Enter a valid email address', errorCode: 'INVALID_EMAIL' }, 400)
    }
    if (!HANDLE_RE.test(handle)) {
      return c.json({
        error: 'Beam name must be 3–32 characters and use lowercase letters, numbers, hyphens, or underscores',
        errorCode: 'INVALID_HANDLE',
      }, 400)
    }
    if (displayName.length < 2 || displayName.length > 80) {
      return c.json({ error: 'Display name must be 2–80 characters', errorCode: 'INVALID_DISPLAY_NAME' }, 400)
    }

    const token = randomBytes(32).toString('base64url')
    const claim = createIdentityClaim(db, {
      tokenHash: tokenHash(token),
      email,
      handle,
      displayName,
      expiresAt: Date.now() + CLAIM_TTL_MS,
    })

    if (!claim) {
      return c.json({ error: 'This Beam name is not available', errorCode: 'HANDLE_UNAVAILABLE' }, 409)
    }

    const claimUrl = new URL('/claim', publicSiteUrl())
    // Keep the one-time token in the URL fragment so it never reaches the
    // static-site access log or a Referer header.
    claimUrl.hash = new URLSearchParams({ token }).toString()

    try {
      const delivered = await sendIdentityClaimEmail({
        email,
        displayName,
        beamId: `${handle}@beam.directory`,
        url: claimUrl.toString(),
      })

      if (!delivered && !LOCAL_CLAIM_LINKS_ENABLED()) {
        deleteIdentityClaim(db, claim.token_hash)
        return c.json({ error: 'Claim email delivery is temporarily unavailable', errorCode: 'EMAIL_UNAVAILABLE' }, 503)
      }
    } catch {
      deleteIdentityClaim(db, claim.token_hash)
      console.error('Identity claim email delivery failed')
      return c.json({ error: 'Claim email delivery is temporarily unavailable', errorCode: 'EMAIL_UNAVAILABLE' }, 503)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      status: 'verification_required',
      beamId: `${handle}@beam.directory`,
      expiresInSeconds: CLAIM_TTL_MS / 1000,
      ...(LOCAL_CLAIM_LINKS_ENABLED() ? { claimUrl: claimUrl.toString() } : {}),
    }, 202)
  })

  router.post('/inspect', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid or expired claim link', errorCode: 'INVALID_CLAIM' }, 404)
    }
    const token = body && typeof body === 'object' && !Array.isArray(body)
      && typeof (body as Record<string, unknown>)['token'] === 'string'
      ? ((body as Record<string, unknown>)['token'] as string).trim()
      : ''
    if (!token || token.length < 32 || token.length > 128) {
      return c.json({ error: 'Invalid or expired claim link', errorCode: 'INVALID_CLAIM' }, 404)
    }

    const claim = getIdentityClaim(db, tokenHash(token))
    if (!claim) {
      return c.json({ error: 'Invalid or expired claim link', errorCode: 'INVALID_CLAIM' }, 404)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      status: 'ready',
      beamId: `${claim.handle}@beam.directory`,
      displayName: claim.display_name,
      email: maskEmail(claim.email),
      expiresAt: new Date(claim.expires_at).toISOString(),
    })
  })

  router.post('/complete', async (c) => {
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
    const token = typeof raw['token'] === 'string' ? raw['token'].trim() : ''
    if (!token || token.length < 32 || token.length > 128) {
      return c.json({ error: 'Invalid or expired claim link', errorCode: 'INVALID_CLAIM' }, 404)
    }

    const publicKey = typeof raw['publicKey'] === 'string'
      ? raw['publicKey'].trim()
      : ''
    if (!publicKey || !isEd25519Spki(publicKey)) {
      return c.json({ error: 'A valid Ed25519 identity key is required', errorCode: 'INVALID_PUBLIC_KEY' }, 400)
    }
    const dhPublicKey = typeof raw['dhPublicKey'] === 'string' ? raw['dhPublicKey'].trim() : ''
    if (!dhPublicKey || !isX25519Spki(dhPublicKey)) {
      return c.json({ error: 'A valid X25519 encryption key is required', errorCode: 'INVALID_ENCRYPTION_KEY' }, 400)
    }

    const claim = getIdentityClaim(db, tokenHash(token))
    if (!claim) {
      return c.json({ error: 'Invalid or expired claim link', errorCode: 'INVALID_CLAIM' }, 404)
    }

    const apiKey = createAgentApiKey(`${claim.handle}@beam.directory`)
    const agent = completeIdentityClaim(db, {
      tokenHash: tokenHash(token),
      publicKey,
      dhPublicKey,
      apiKeyHash: hashApiKey(apiKey),
      capabilities: ['identity.personal', 'contact.receive'],
    })

    if (!agent) {
      return c.json({ error: 'This claim has already been completed', errorCode: 'CLAIM_ALREADY_USED' }, 409)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      status: 'claimed',
      identity: serializeAgent(agent, { keys: listAgentKeys(db, agent.beam_id) }),
      credential: {
        apiKey,
        directoryUrl: process.env['BEAM_DIRECTORY_URL']?.trim() || 'https://api.beam.directory',
      },
    }, 201)
  })

  return router
}
