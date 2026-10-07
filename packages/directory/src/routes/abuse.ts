import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import { getAgent, getOrg, logAuditEvent } from '../db.js'
import { checkAgentRateLimit } from '../rate-limit.js'
import { offboardPerson, getPerson } from '../trust/person-store.js'
import { suspendOrg } from '../trust/suspension.js'
import { BEAM_ID_RE } from '../validation.js'
import { authenticateNetworkIdentity, verifyNetworkSignedMutation } from './network.js'

type AbuseRow = {
  id: string
  reporter_beam_id: string
  target_beam_id: string
  message_id: string | null
  intent_nonce: string | null
  reason: string
  status: 'pending' | 'blocked' | 'dismissed'
  block_scope: 'agent' | 'person' | 'org' | null
  review_note: string | null
  reviewed_by: string | null
  created_at: string
  reviewed_at: string | null
}

function serializeAbuse(row: AbuseRow): object {
  return {
    id: row.id,
    reporterBeamId: row.reporter_beam_id,
    targetBeamId: row.target_beam_id,
    messageId: row.message_id,
    intentNonce: row.intent_nonce,
    reason: row.reason,
    status: row.status,
    blockScope: row.block_scope,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }
}

export function abuseNetworkRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/abuse', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    if (!checkAgentRateLimit(`abuse:${auth.agent.beam_id}`)) {
      return c.json({ error: 'Rate limit exceeded', errorCode: 'RATE_LIMITED' }, 429)
    }
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }
    const body = raw as Record<string, unknown>
    const targetBeamId = typeof body['targetBeamId'] === 'string' ? body['targetBeamId'].trim().toLowerCase() : ''
    const messageId = typeof body['messageId'] === 'string' ? body['messageId'].trim() : ''
    const intentNonce = typeof body['intentNonce'] === 'string' ? body['intentNonce'].trim() : ''
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : ''
    if (!BEAM_ID_RE.test(targetBeamId) || targetBeamId === auth.agent.beam_id || reason.length < 3 || reason.length > 2000) {
      return c.json({ error: 'targetBeamId and a reason are required', errorCode: 'INVALID_REPORT' }, 400)
    }
    if (!messageId && !intentNonce) {
      return c.json({ error: 'messageId or intentNonce is required', errorCode: 'INVALID_REPORT' }, 400)
    }
    if (!getAgent(db, targetBeamId)) {
      return c.json({ error: 'Target agent not found', errorCode: 'NOT_FOUND' }, 404)
    }
    if (messageId) {
      const message = db.prepare(`
        SELECT m.sender_beam_id
        FROM beam_messages m
        JOIN beam_conversation_members member ON member.conversation_id = m.conversation_id
        WHERE m.message_id = ? AND member.beam_id = ?
      `).get(messageId, auth.agent.beam_id) as { sender_beam_id: string } | undefined
      if (!message || message.sender_beam_id !== targetBeamId) {
        return c.json({ error: 'Message not found for this recipient', errorCode: 'NOT_FOUND' }, 404)
      }
    }
    if (intentNonce) {
      const intent = db.prepare(`
        SELECT from_beam_id FROM intent_log WHERE nonce = ? AND to_beam_id = ?
      `).get(intentNonce, auth.agent.beam_id) as { from_beam_id: string } | undefined
      if (!intent || intent.from_beam_id !== targetBeamId) {
        return c.json({ error: 'Intent not found for this recipient', errorCode: 'NOT_FOUND' }, 404)
      }
    }
    const proof = verifyNetworkSignedMutation(db, auth.agent, body, {
      type: 'network.abuse.report',
      reporterBeamId: auth.agent.beam_id,
      targetBeamId,
      messageId: messageId || null,
      intentNonce: intentNonce || null,
      reason,
    })
    if (!proof.ok) return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)

    const id = randomUUID()
    const createdAt = new Date().toISOString()
    db.prepare(`
      INSERT INTO abuse_reports (
        id, reporter_beam_id, target_beam_id, message_id, intent_nonce, reason, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, auth.agent.beam_id, targetBeamId, messageId || null, intentNonce || null, reason, createdAt)
    logAuditEvent(db, {
      action: 'abuse.reported',
      actor: auth.agent.beam_id,
      target: targetBeamId,
      details: { id, messageId: messageId || null, intentNonce: intentNonce || null },
    })
    const row = db.prepare('SELECT * FROM abuse_reports WHERE id = ?').get(id) as AbuseRow
    return c.json({ report: serializeAbuse(row) }, 201)
  })

  return router
}

export function abuseAdminRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:id/review', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) return auth
    const id = c.req.param('id')
    const existing = db.prepare('SELECT * FROM abuse_reports WHERE id = ?').get(id) as AbuseRow | undefined
    if (!existing || existing.status !== 'pending') {
      return c.json({ error: 'Pending abuse report not found', errorCode: 'NOT_FOUND' }, 404)
    }
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }
    const body = raw as Record<string, unknown>
    const decision = body['decision']
    const note = typeof body['note'] === 'string' ? body['note'].trim() : ''
    if ((decision !== 'block_agent' && decision !== 'block_person' && decision !== 'block_org' && decision !== 'dismiss') || note.length < 3 || note.length > 2000) {
      return c.json({ error: 'decision and a review note are required', errorCode: 'INVALID_REVIEW' }, 400)
    }

    const reviewedAt = new Date().toISOString()
    const target = getAgent(db, existing.target_beam_id)
    if (decision === 'block_agent' && target) {
      db.prepare(`UPDATE agents SET suspended_at = COALESCE(suspended_at, ?) WHERE beam_id = ?`).run(reviewedAt, target.beam_id)
    }
    if (decision === 'block_person' && target?.responsible_person_id) {
      const person = getPerson(db, target.responsible_person_id)
      if (person) offboardPerson(db, person)
    }
    if (decision === 'block_org' && target?.org) {
      suspendOrg(db, target.org, reviewedAt)
    }
    const status = decision === 'dismiss' ? 'dismissed' : 'blocked'
    const blockScope = decision === 'block_agent' ? 'agent' : decision === 'block_person' ? 'person' : decision === 'block_org' ? 'org' : null
    db.prepare(`
      UPDATE abuse_reports
      SET status = ?, block_scope = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, blockScope, note, auth.session.email, reviewedAt, id)
    logAuditEvent(db, {
      action: 'abuse.reviewed',
      actor: auth.session.email,
      target: existing.target_beam_id,
      details: { id, decision, note },
    })
    const row = db.prepare('SELECT * FROM abuse_reports WHERE id = ?').get(id) as AbuseRow
    return c.json({ report: serializeAbuse(row) })
  })

  return router
}

export function orgSuspensionRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:name/suspension', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) return auth
    const name = (c.req.param('name') ?? '').trim().toLowerCase()
    if (!getOrg(db, name)) return c.json({ error: 'Organization not found', errorCode: 'NOT_FOUND' }, 404)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }
    const note = typeof (raw as Record<string, unknown>)['note'] === 'string'
      ? String((raw as Record<string, unknown>)['note']).trim()
      : ''
    if (note.length < 3 || note.length > 2000) {
      return c.json({ error: 'note must explain the suspension', errorCode: 'INVALID_REVIEW' }, 400)
    }
    const at = new Date().toISOString()
    suspendOrg(db, name, at)
    logAuditEvent(db, {
      action: 'org.suspended',
      actor: auth.session.email,
      target: name,
      details: { note },
    })
    return c.json({ org: name, suspendedAt: getOrg(db, name)?.suspended_at ?? at })
  })

  return router
}
