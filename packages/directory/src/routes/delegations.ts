import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { DelegationRow } from '../types.js'
import { createDelegation, getAgent, listActiveDelegations, revokeDelegation } from '../db.js'
import { verifySignedPayload } from '../crypto.js'

const BEAM_ID_RE = /^[a-z0-9_-]+@[a-z0-9_-]+\.beam\.directory$/

function serializeDelegation(row: DelegationRow): object {
  return {
    id: row.id,
    grantorBeamId: row.grantor_beam_id,
    granteeBeamId: row.grantee_beam_id,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revoked: row.revoked === 1,
  }
}

export function delegationsRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:beamId/delegate', async (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const grantor = getAgent(db, beamId)
    if (!grantor) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
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
    const granteeBeamId = String(raw.grantee_beam_id ?? '').trim()
    const scope = String(raw.scope ?? '').trim()
    const expiresAt = Number(raw.expires_at ?? 0)
    const signature = String(raw.signature ?? '').trim()

    if (!BEAM_ID_RE.test(granteeBeamId) || !scope || !Number.isFinite(expiresAt) || !signature) {
      return c.json({ error: 'grantee_beam_id, scope, expires_at and signature are required', errorCode: 'INVALID_DELEGATION' }, 400)
    }

    if (expiresAt <= Date.now()) {
      return c.json({ error: 'expires_at must be in the future', errorCode: 'INVALID_DELEGATION' }, 400)
    }

    const grantee = getAgent(db, granteeBeamId)
    if (!grantee) {
      return c.json({ error: `Agent ${granteeBeamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    const payload = JSON.stringify({
      type: 'delegation',
      grantor_beam_id: beamId,
      grantee_beam_id: granteeBeamId,
      scope,
      expires_at: expiresAt,
    })

    if (!verifySignedPayload(grantor.public_key, payload, signature)) {
      return c.json({ error: 'signature is invalid', errorCode: 'INVALID_SIGNATURE' }, 400)
    }

    const delegation = createDelegation(db, {
      grantorBeamId: beamId,
      granteeBeamId,
      scope,
      expiresAt,
    })

    return c.json(serializeDelegation(delegation), 201)
  })

  router.get('/:beamId/delegations', (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const rows = listActiveDelegations(db, beamId)
    return c.json({
      delegations: rows.map(serializeDelegation),
      total: rows.length,
    })
  })

  router.delete('/:beamId/delegations/:id', async (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    const id = Number.parseInt(c.req.param('id'), 10)
    if (!BEAM_ID_RE.test(beamId) || !Number.isInteger(id) || id < 1) {
      return c.json({ error: 'Invalid delegation identifier', errorCode: 'INVALID_DELEGATION' }, 400)
    }

    const grantor = getAgent(db, beamId)
    if (!grantor) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    let body: unknown = null
    try {
      body = await c.req.json()
    } catch {
      body = null
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object with signature', errorCode: 'INVALID_BODY' }, 400)
    }

    const signature = String((body as Record<string, unknown>).signature ?? '').trim()
    if (!signature) {
      return c.json({ error: 'signature is required', errorCode: 'INVALID_SIGNATURE' }, 400)
    }

    const payload = JSON.stringify({
      type: 'delegation-revoke',
      grantor_beam_id: beamId,
      delegation_id: id,
    })

    if (!verifySignedPayload(grantor.public_key, payload, signature)) {
      return c.json({ error: 'signature is invalid', errorCode: 'INVALID_SIGNATURE' }, 400)
    }

    const revoked = revokeDelegation(db, beamId, id)
    if (!revoked) {
      return c.json({ error: 'Delegation not found', errorCode: 'NOT_FOUND' }, 404)
    }

    return c.json({ revoked: true, id })
  })

  return router
}
