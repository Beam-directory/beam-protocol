/**
 * Beam Shield — Routes
 * Per-agent shield config, audit log, and anomaly detection endpoints.
 */

import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { getRecentEvents, getAuditStats } from '../shield/audit.js'

export interface ShieldConfig {
  mode: 'whitelist' | 'open' | 'closed'
  allowlist: string[]
  blocklist: string[]
  minTrust: number
  rateLimit: number
}

const DEFAULT_SHIELD_CONFIG: ShieldConfig = {
  mode: 'open',
  allowlist: [],
  blocklist: [],
  minTrust: 0.3,
  rateLimit: 20,
}

export function parseShieldConfig(raw: string | null | undefined): ShieldConfig {
  if (!raw) return { ...DEFAULT_SHIELD_CONFIG }
  try {
    const parsed = JSON.parse(raw) as Partial<ShieldConfig>
    return {
      mode: parsed.mode === 'whitelist' || parsed.mode === 'closed' ? parsed.mode : 'open',
      allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [],
      blocklist: Array.isArray(parsed.blocklist) ? parsed.blocklist : [],
      minTrust: typeof parsed.minTrust === 'number' ? Math.max(0, Math.min(1, parsed.minTrust)) : 0.3,
      rateLimit: typeof parsed.rateLimit === 'number' ? Math.max(1, Math.min(1000, parsed.rateLimit)) : 20,
    }
  } catch {
    return { ...DEFAULT_SHIELD_CONFIG }
  }
}

export function shieldRouter(db: Database): Hono {
  const router = new Hono()

  function requireAdmin(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): boolean {
    const key = c.req.header('x-admin-key') ?? c.req.query('key') ?? ''
    return key === process.env.BEAM_ADMIN_KEY
  }

  // GET /shield/config/:beamId — Get shield config for an agent
  router.get('/config/:beamId', (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')
    const row = db.prepare('SELECT shield_config FROM agents WHERE beam_id = ?').get(beamId) as { shield_config: string | null } | undefined

    if (!row) return c.json({ error: 'Agent not found' }, 404)

    const config = parseShieldConfig(row.shield_config)
    return c.json({ beamId, shield: config })
  })

  // PATCH /shield/config/:beamId — Update shield config (admin-key or Ed25519 required)
  router.patch('/config/:beamId', async (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')

    // Auth: admin key or agent's own Ed25519 signature
    const isAdmin = requireAdmin(c)
    if (!isAdmin) {
      // Check Ed25519 signature auth
      const sigHeader = c.req.header('x-beam-signature')
      const nonceHeader = c.req.header('x-beam-nonce')
      if (!sigHeader || !nonceHeader) {
        return c.json({ error: 'Admin key or Ed25519 signature required', errorCode: 'UNAUTHORIZED' }, 401)
      }

      // Verify signature over beamId + nonce
      const { verifyPayload } = await import('../crypto.js')
      const agentRow = db.prepare('SELECT public_key FROM agents WHERE beam_id = ?').get(beamId) as { public_key: string } | undefined
      if (!agentRow?.public_key) return c.json({ error: 'Agent not found or no key' }, 404)

      const payload = { action: 'shield', beamId, nonce: nonceHeader }
      const valid = verifyPayload(payload, sigHeader, agentRow.public_key)
      if (!valid) return c.json({ error: 'Invalid signature', errorCode: 'INVALID_SIGNATURE' }, 403)

      // K1 FIX: Record nonce to prevent replay attacks
      const existingNonce = db.prepare('SELECT nonce FROM nonces WHERE nonce = ?').get(nonceHeader)
      if (existingNonce) return c.json({ error: 'Nonce already used', errorCode: 'NONCE_REPLAY' }, 409)
      db.prepare('INSERT INTO nonces (nonce, beam_id, created_at) VALUES (?, ?, ?)').run(nonceHeader, beamId, new Date().toISOString())
    }

    // Validate agent exists
    const agent = db.prepare('SELECT beam_id FROM agents WHERE beam_id = ?').get(beamId) as { beam_id: string } | undefined
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    // Parse and validate body
    let body: Record<string, unknown>
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    // Build config
    const currentRaw = (db.prepare('SELECT shield_config FROM agents WHERE beam_id = ?').get(beamId) as { shield_config: string | null } | undefined)?.shield_config
    const current = parseShieldConfig(currentRaw)

    const updated: ShieldConfig = {
      mode: body.mode === 'whitelist' || body.mode === 'open' || body.mode === 'closed' ? body.mode : current.mode,
      allowlist: Array.isArray(body.allowlist) ? (body.allowlist as string[]).filter(s => typeof s === 'string') : current.allowlist,
      blocklist: Array.isArray(body.blocklist) ? (body.blocklist as string[]).filter(s => typeof s === 'string') : current.blocklist,
      minTrust: typeof body.minTrust === 'number' ? Math.max(0, Math.min(1, body.minTrust)) : current.minTrust,
      rateLimit: typeof body.rateLimit === 'number' ? Math.max(1, Math.min(1000, body.rateLimit)) : current.rateLimit,
    }

    db.prepare('UPDATE agents SET shield_config = ? WHERE beam_id = ?').run(JSON.stringify(updated), beamId)

    return c.json({ beamId, shield: updated, updated: true })
  })

  // GET /shield/audit/:beamId — Recent audit events for a sender
  router.get('/audit/:beamId', (c) => {
    if (!requireAdmin(c)) {
      return c.json({ error: 'Admin key required', errorCode: 'UNAUTHORIZED' }, 401)
    }

    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')
    const hours = parseInt(c.req.query('hours') ?? '24', 10)

    try {
      const events = getRecentEvents(db, beamId, hours)
      return c.json({ events, total: events.length, beamId, hours })
    } catch (err) {
      console.error('Shield audit error:', err)
      return c.json({ error: 'Failed to fetch audit events', errorCode: 'DB_ERROR' }, 500)
    }
  })

  // GET /shield/stats — Aggregate shield statistics
  router.get('/stats', (c) => {
    if (!requireAdmin(c)) {
      return c.json({ error: 'Admin key required', errorCode: 'UNAUTHORIZED' }, 401)
    }

    const hours = parseInt(c.req.query('hours') ?? '24', 10)

    try {
      const stats = getAuditStats(db, hours)
      return c.json({ ...stats, hours })
    } catch (err) {
      console.error('Shield stats error:', err)
      return c.json({ error: 'Failed to fetch shield stats', errorCode: 'DB_ERROR' }, 500)
    }
  })

  return router
}
