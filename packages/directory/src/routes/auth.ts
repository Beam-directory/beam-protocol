/**
 * Auth routes — Magic Link authentication for dashboard users.
 * 
 * Flow:
 * 1. POST /auth/magic-link { email } → sends magic link email (or returns token in dev)
 * 2. GET  /auth/verify?token=xxx → validates token, returns JWT session
 * 3. GET  /auth/me → returns current user (requires Authorization: Bearer <jwt>)
 * 4. POST /auth/logout → invalidates session
 */
import { randomBytes, createHmac } from 'node:crypto'
import { Hono } from 'hono'
import type { Database as DB } from 'better-sqlite3'

const JWT_SECRET = process.env.JWT_SECRET || process.env.BEAM_ADMIN_KEY || 'beam-dev-secret-change-me'
const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000 // 15 minutes
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const APP_URL = process.env.APP_URL || 'https://dashboard.beam.directory'

interface AuthSession {
  email: string
  beamIds: string[]
  exp: number
}

function ensureAuthTables(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_magic_links (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_auth_magic_email ON auth_magic_links(email);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_email ON auth_sessions(email);
  `)
}

function createJWT(payload: AuthSession): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url')
  return `${header}.${body}.${signature}`
}

function verifyJWT(token: string): AuthSession | null {
  try {
    const [header, body, signature] = token.split('.')
    if (!header || !body || !signature) return null
    
    const expectedSig = createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url')
    
    if (signature !== expectedSig) return null
    
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as AuthSession
    if (payload.exp < Date.now()) return null
    
    return payload
  } catch {
    return null
  }
}

function getAgentsByEmail(db: DB, email: string): string[] {
  const rows = db.prepare('SELECT beam_id FROM agents WHERE email = ? AND email_verified = 1').all(email) as { beam_id: string }[]
  if (rows.length > 0) return rows.map(r => r.beam_id)
  
  // Also match unverified email (for initial login)
  const unverified = db.prepare('SELECT beam_id FROM agents WHERE email = ?').all(email) as { beam_id: string }[]
  return unverified.map(r => r.beam_id)
}

export function authRouter(db: DB) {
  ensureAuthTables(db)
  
  const router = new Hono()

  // POST /auth/magic-link — Request a magic link
  router.post('/magic-link', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { email?: string }
    const email = body.email?.trim().toLowerCase()
    
    if (!email || !email.includes('@')) {
      return c.json({ error: 'Valid email required' }, 400)
    }

    // Check if any agents are registered with this email
    const agents = getAgentsByEmail(db, email)
    if (agents.length === 0) {
      // Don't reveal if email exists — always say "sent"
      // But log for debugging
      console.log(`[auth] Magic link requested for unknown email: ${email}`)
      return c.json({ ok: true, message: 'If an agent is registered with this email, you will receive a login link.' })
    }

    // Generate token
    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS).toISOString()
    
    db.prepare('INSERT INTO auth_magic_links (token, email, expires_at) VALUES (?, ?, ?)').run(token, email, expiresAt)

    // Clean up old tokens
    db.prepare("DELETE FROM auth_magic_links WHERE expires_at < datetime('now') OR used = 1").run()

    const magicUrl = `${APP_URL}/auth/callback?token=${token}`

    // In production: send email via SMTP/SendGrid/Resend
    // For now: return the URL (dev mode) + log it
    const isDev = !process.env.FLY_APP_NAME
    console.log(`[auth] Magic link for ${email}: ${magicUrl}`)

    if (isDev) {
      return c.json({ ok: true, message: 'Magic link generated.', url: magicUrl, token, dev: true })
    }

    // TODO: Send email via Resend/SendGrid
    // For now, even in prod, return success (email sending not yet implemented)
    return c.json({ ok: true, message: 'If an agent is registered with this email, you will receive a login link.' })
  })

  // POST /auth/verify — Exchange magic link token for JWT session
  router.post('/verify', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { token?: string }
    const token = body.token?.trim()
    
    if (!token) {
      return c.json({ error: 'Token required' }, 400)
    }

    const link = db.prepare(
      "SELECT * FROM auth_magic_links WHERE token = ? AND used = 0 AND expires_at > datetime('now')"
    ).get(token) as { token: string; email: string } | undefined

    if (!link) {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    // Mark as used
    db.prepare('UPDATE auth_magic_links SET used = 1 WHERE token = ?').run(token)

    // Get user's agents
    const beamIds = getAgentsByEmail(db, link.email)

    // Create session JWT
    const session: AuthSession = {
      email: link.email,
      beamIds,
      exp: Date.now() + SESSION_EXPIRY_MS,
    }

    const jwt = createJWT(session)

    // Store session
    const sessionToken = randomBytes(16).toString('hex')
    db.prepare('INSERT INTO auth_sessions (token, email, expires_at) VALUES (?, ?, ?)').run(
      sessionToken,
      link.email,
      new Date(session.exp).toISOString()
    )

    return c.json({
      ok: true,
      token: jwt,
      email: link.email,
      beamIds,
      expiresAt: new Date(session.exp).toISOString(),
    })
  })

  // GET /auth/me — Get current user info
  router.get('/me', (c) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const session = verifyJWT(authHeader.slice(7))
    if (!session) {
      return c.json({ error: 'Invalid or expired session' }, 401)
    }

    // Refresh beam IDs (in case new agents were added)
    const beamIds = getAgentsByEmail(db, session.email)

    // Get agent details
    const agents = beamIds.map(id => {
      const agent = db.prepare('SELECT * FROM agents WHERE beam_id = ?').get(id) as any
      if (!agent) return null
      return {
        beamId: agent.beam_id,
        displayName: agent.display_name,
        org: agent.org,
        capabilities: JSON.parse(agent.capabilities || '[]'),
        trustScore: agent.trust_score,
        verificationTier: agent.verification_tier,
        visibility: agent.visibility || 'unlisted',
        shieldConfig: agent.shield_config ? JSON.parse(agent.shield_config) : null,
        plan: agent.plan || 'free',
        httpEndpoint: agent.http_endpoint,
        lastSeen: agent.last_seen,
        createdAt: agent.created_at,
      }
    }).filter(Boolean)

    return c.json({
      email: session.email,
      agents,
      expiresAt: new Date(session.exp).toISOString(),
    })
  })

  // POST /auth/logout — Revoke session
  router.post('/logout', (c) => {
    const authHeader = c.req.header('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const session = verifyJWT(authHeader.slice(7))
      if (session) {
        db.prepare('UPDATE auth_sessions SET revoked = 1 WHERE email = ?').run(session.email)
      }
    }
    return c.json({ ok: true })
  })

  return router
}

export { verifyJWT, type AuthSession }
