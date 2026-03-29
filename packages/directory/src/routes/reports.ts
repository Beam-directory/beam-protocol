import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import type { ReportRow } from '../types.js'
import { createReport, getAgent, getPendingReportCount, listReportsForTarget } from '../db.js'
import { BEAM_ID_RE } from '../validation.js'

function serializeReport(row: ReportRow): object {
  return {
    id: row.id,
    reporterBeamId: row.reporter_beam_id,
    targetBeamId: row.target_beam_id,
    reason: row.reason,
    createdAt: row.created_at,
    status: row.status,
  }
}

export function reportsRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:beamId/report', async (c) => {
    const targetBeamId = decodeURIComponent(c.req.param('beamId') ?? '')
    if (!BEAM_ID_RE.test(targetBeamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const targetAgent = getAgent(db, targetBeamId)
    if (!targetAgent) {
      return c.json({ error: `Agent ${targetBeamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const reporterBeamId = String(raw.reporter_beam_id ?? '').trim()
    const reason = String(raw.reason ?? '').trim()

    if (!BEAM_ID_RE.test(reporterBeamId) || !reason) {
      return c.json({ error: 'reporter_beam_id and reason are required', errorCode: 'INVALID_REPORT' }, 400)
    }

    if (reporterBeamId === targetBeamId) {
      return c.json({ error: 'Agents cannot report themselves', errorCode: 'INVALID_REPORT' }, 400)
    }

    const reporter = getAgent(db, reporterBeamId)
    if (!reporter) {
      return c.json({ error: `Agent ${reporterBeamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    const existing = db.prepare(`
      SELECT id
      FROM reports
      WHERE reporter_beam_id = ? AND target_beam_id = ?
      LIMIT 1
    `).get(reporterBeamId, targetBeamId) as { id: number } | undefined

    if (existing) {
      return c.json({ error: 'Reporter has already filed a report for this target', errorCode: 'DUPLICATE_REPORT' }, 409)
    }

    const report = createReport(db, { reporterBeamId, targetBeamId, reason })
    const pendingReports = getPendingReportCount(db, targetBeamId)
    const updatedTarget = getAgent(db, targetBeamId)

    return c.json({
      report: serializeReport(report),
      pendingReports,
      flagged: updatedTarget?.flagged === 1,
      trustScore: updatedTarget?.trust_score ?? targetAgent.trust_score,
    }, 201)
  })

  router.get('/:beamId/reports', (c) => {
    const targetBeamId = decodeURIComponent(c.req.param('beamId') ?? '')
    if (!BEAM_ID_RE.test(targetBeamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const admin = requireAdminRole(db, c.req.raw, 'viewer')
    if (admin instanceof Response) {
      return admin
    }

    const rows = listReportsForTarget(db, targetBeamId)
    return c.json({
      reports: rows.map(serializeReport),
      total: rows.length,
    })
  })

  return router
}
