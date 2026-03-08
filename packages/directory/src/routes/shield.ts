/**
 * Beam Shield — Admin Routes
 * Audit log and anomaly detection endpoints (admin-key required).
 */

import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { getRecentEvents, getAuditStats } from '../shield/audit.js'

export function shieldRouter(db: Database): Hono {
  const router = new Hono()

  function requireAdmin(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): boolean {
    const key = c.req.header('x-admin-key') ?? c.req.query('key') ?? ''
    return key === process.env.BEAM_ADMIN_KEY
  }

  // GET /shield/audit/:beamId — Recent audit events for a sender
  router.get('/audit/:beamId', (c) => {
    if (!requireAdmin(c)) {
      return c.json({ error: 'Admin key required', errorCode: 'UNAUTHORIZED' }, 401)
    }

    const beamId = decodeURIComponent(c.req.param('beamId'))
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
