import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import { getOrg, logAuditEvent } from '../db.js'
import { getOrgRegistryFiling, reviewOrgRegistryFiling, serializeOrgRegistryFiling } from '../trust/registry-store.js'

export function orgRegistryAdminRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:name/registry/:id/review', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }
    const name = c.req.param('name').trim().toLowerCase()
    const id = Number.parseInt(c.req.param('id'), 10)
    if (!getOrg(db, name) || !Number.isInteger(id) || id < 1) {
      return c.json({ error: 'Registry filing not found', errorCode: 'NOT_FOUND' }, 404)
    }

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
    const decision = raw['decision'] === 'approved' || raw['decision'] === 'rejected' ? raw['decision'] : null
    const note = typeof raw['note'] === 'string' ? raw['note'].trim() : ''
    if (!decision || note.length < 3 || note.length > 2000) {
      return c.json({
        error: 'decision must be approved or rejected and note must explain the representation check',
        errorCode: 'INVALID_REVIEW',
      }, 400)
    }

    const existing = getOrgRegistryFiling(db, id)
    if (!existing || existing.org_name !== name) {
      return c.json({ error: 'Registry filing not found', errorCode: 'NOT_FOUND' }, 404)
    }
    if (existing.status !== 'pending') {
      return c.json({ error: 'Registry filing was already reviewed', errorCode: 'REGISTRY_ALREADY_REVIEWED' }, 409)
    }

    const filing = reviewOrgRegistryFiling(db, {
      id,
      orgName: name,
      decision,
      reviewer: auth.session.email,
      note,
    })
    if (!filing) {
      return c.json({ error: 'Registry filing was already reviewed', errorCode: 'REGISTRY_ALREADY_REVIEWED' }, 409)
    }
    logAuditEvent(db, {
      action: 'org.registry.reviewed',
      actor: auth.session.email,
      target: `${name}:${id}`,
      details: {
        decision,
        kind: filing.kind,
        registrationNumber: filing.registration_number,
        applicantName: filing.applicant_name,
        applicantRole: filing.applicant_role,
      },
    })
    return c.json({ filing: serializeOrgRegistryFiling(filing) })
  })

  return router
}
