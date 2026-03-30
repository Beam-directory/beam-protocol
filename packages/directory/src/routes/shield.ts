/**
 * Beam Shield — Routes
 * Per-agent shield config, public endpoint policy, audit log, and anomaly endpoints.
 */

import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { getAdminSessionFromRequest, requireAdminRole, roleSatisfies } from '../admin-auth.js'
import {
  getPublicEndpointShieldPolicy,
  logAuditEvent,
  recordNonce,
  updatePublicEndpointShieldPolicy,
} from '../db.js'
import { verifyPayload } from '../crypto.js'
import { getRecentEvents, getAuditStats } from '../shield/audit.js'
import {
  parseShieldConfig,
  type PublicEndpointShieldPolicy,
  type ShieldConfig,
} from '../shield/policies.js'

export function shieldRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/config/:beamId', (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')
    const row = db.prepare('SELECT shield_config FROM agents WHERE beam_id = ?').get(beamId) as { shield_config: string | null } | undefined

    if (!row) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    return c.json({ beamId, shield: parseShieldConfig(row.shield_config) })
  })

  router.patch('/config/:beamId', async (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')

    const adminSession = getAdminSessionFromRequest(db, c.req.raw)
    const isAdmin = Boolean(adminSession && roleSatisfies(adminSession.role, 'admin'))
    if (!isAdmin) {
      const sigHeader = c.req.header('x-beam-signature')
      const nonceHeader = c.req.header('x-beam-nonce')
      if (!sigHeader || !nonceHeader) {
        return c.json({ error: 'Admin session or Ed25519 signature required', errorCode: 'UNAUTHORIZED' }, 401)
      }

      const agentRow = db.prepare('SELECT public_key FROM agents WHERE beam_id = ?').get(beamId) as { public_key: string } | undefined
      if (!agentRow?.public_key) {
        return c.json({ error: 'Agent not found or no key' }, 404)
      }

      const payload = { action: 'shield', beamId, nonce: nonceHeader }
      const valid = verifyPayload(payload, sigHeader, agentRow.public_key)
      if (!valid) {
        return c.json({ error: 'Invalid signature', errorCode: 'INVALID_SIGNATURE' }, 403)
      }

      if (!recordNonce(db, nonceHeader)) {
        return c.json({ error: 'Nonce already used', errorCode: 'NONCE_REPLAY' }, 409)
      }
    }

    const agent = db.prepare('SELECT beam_id FROM agents WHERE beam_id = ?').get(beamId) as { beam_id: string } | undefined
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404)
    }

    let body: Record<string, unknown>
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const currentRaw = (db.prepare('SELECT shield_config FROM agents WHERE beam_id = ?').get(beamId) as { shield_config: string | null } | undefined)?.shield_config
    const current = parseShieldConfig(currentRaw)

    const updated: ShieldConfig = {
      mode: body.mode === 'whitelist' || body.mode === 'open' || body.mode === 'closed' ? body.mode : current.mode,
      allowlist: Array.isArray(body.allowlist) ? (body.allowlist as unknown[]).filter((value): value is string => typeof value === 'string') : current.allowlist,
      blocklist: Array.isArray(body.blocklist) ? (body.blocklist as unknown[]).filter((value): value is string => typeof value === 'string') : current.blocklist,
      minTrust: typeof body.minTrust === 'number' ? Math.max(0, Math.min(1, body.minTrust)) : current.minTrust,
      rateLimit: typeof body.rateLimit === 'number' ? Math.max(1, Math.min(1000, body.rateLimit)) : current.rateLimit,
    }

    db.prepare('UPDATE agents SET shield_config = ? WHERE beam_id = ?').run(JSON.stringify(updated), beamId)

    if (adminSession) {
      logAuditEvent(db, {
        action: 'shield.config.updated',
        actor: adminSession.email,
        target: beamId,
        details: {
          role: adminSession.role,
          mode: updated.mode,
          minTrust: updated.minTrust,
          rateLimit: updated.rateLimit,
        },
      })
    }

    return c.json({ beamId, shield: updated, updated: true })
  })

  router.get('/policies/public-endpoints', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const { policy, updatedAt } = getPublicEndpointShieldPolicy(db)
    return c.json({ policy, updatedAt })
  })

  router.patch('/policies/public-endpoints', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    let body: Partial<PublicEndpointShieldPolicy>
    try {
      body = await c.req.json() as Partial<PublicEndpointShieldPolicy>
    } catch {
      return c.json({ error: 'Invalid JSON', errorCode: 'INVALID_JSON' }, 400)
    }

    const { policy, updatedAt } = updatePublicEndpointShieldPolicy(db, body)
    logAuditEvent(db, {
      action: 'shield.public_policy.updated',
      actor: auth.session.email,
      target: 'public-endpoints',
      details: {
        role: auth.session.role,
        policy,
      },
    })
    return c.json({ policy, updatedAt, updated: true })
  })

  router.get('/audit/:beamId', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')
    const hours = Number.parseInt(c.req.query('hours') ?? '24', 10)

    try {
      const events = getRecentEvents(db, beamId, hours)
      return c.json({ events, total: events.length, beamId, hours })
    } catch (err) {
      console.error('Shield audit error:', err)
      return c.json({ error: 'Failed to fetch audit events', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/stats', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const hours = Number.parseInt(c.req.query('hours') ?? '24', 10)

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
