import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import { hashApiKey } from '../api-key.js'
import { verifyPayload } from '../crypto.js'
import { getAgent, getOrg, logAuditEvent, recordNonce } from '../db.js'
import { decideApproval, getApproval, listApprovalsForOrg } from '../trust/consequential.js'
import { getPerson, type PersonRow } from '../trust/person-store.js'

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000

function jsonError(error: string, errorCode: string, status: 400 | 401 | 409): Response {
  return new Response(JSON.stringify({ error, errorCode }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function readPersonSignature(
  db: Database,
  person: PersonRow,
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): 'valid' | 'absent' | Response {
  const signature = typeof raw['signature'] === 'string' ? raw['signature'].trim() : ''
  if (!signature) return 'absent'
  const timestamp = typeof raw['timestamp'] === 'string' ? raw['timestamp'] : ''
  const timestampMs = Date.parse(timestamp)
  const nonce = typeof raw['nonce'] === 'string' && NONCE_RE.test(raw['nonce']) ? raw['nonce'] : ''
  if (!person.public_key || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > SIGNATURE_WINDOW_MS || !nonce) {
    return jsonError('A fresh person signature is required', 'INVALID_PROOF', 400)
  }
  if (!verifyPayload({ ...payload, timestamp, nonce }, signature, person.public_key)) {
    return jsonError('signature is invalid', 'INVALID_SIGNATURE', 400)
  }
  if (!recordNonce(db, nonce)) {
    return jsonError('This signed request has already been used', 'NONCE_REPLAY', 409)
  }
  return 'valid'
}

function orgApiKey(c: Context, db: Database): { name: string } | Response {
  const name = (c.req.param('name') ?? '').trim().toLowerCase()
  const org = getOrg(db, name)
  if (!org) return c.json({ error: `Organization ${name} not found`, errorCode: 'NOT_FOUND' }, 404)
  const supplied = c.req.header('x-api-key')?.trim()
    ?? (c.req.header('authorization')?.toLowerCase().startsWith('bearer ')
      ? c.req.header('authorization')!.slice(7).trim()
      : '')
  if (!supplied.startsWith('beam_org_')) return c.json({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }, 401)
  const left = Buffer.from(hashApiKey(supplied))
  const right = Buffer.from(org.api_key_hash)
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return c.json({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }, 401)
  }
  return { name }
}

export function trustInboxRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/:name/people/:id/contact-requests', (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const person = getPerson(db, c.req.param('id'))
    if (!person || person.org_name !== owned.name) {
      return c.json({ error: 'Person not found', errorCode: 'NOT_FOUND' }, 404)
    }
    const rows = db.prepare(`
      SELECT connection_id, requester_beam_id, recipient_beam_id, status, request_message, created_at
      FROM beam_connections
      WHERE held_for_person_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `).all(person.id) as Array<{
      connection_id: string
      requester_beam_id: string
      recipient_beam_id: string
      status: string
      request_message: string | null
      created_at: string
    }>
    return c.json({
      requests: rows.map((row) => ({
        connectionId: row.connection_id,
        requesterBeamId: row.requester_beam_id,
        recipientBeamId: row.recipient_beam_id,
        status: row.status,
        message: row.request_message,
        createdAt: row.created_at,
      })),
      total: rows.length,
    })
  })

  router.post('/:name/people/:id/contact-requests/:connectionId', async (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const person = getPerson(db, c.req.param('id'))
    if (!person || person.org_name !== owned.name || person.status !== 'active') {
      return c.json({ error: 'Person not found', errorCode: 'NOT_FOUND' }, 404)
    }
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }
    const decision = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['decision']
      : null
    if (decision !== 'accepted' && decision !== 'declined') {
      return c.json({ error: 'decision must be accepted or declined', errorCode: 'INVALID_DECISION' }, 400)
    }
    const body = raw as Record<string, unknown>
    const signed = readPersonSignature(db, person, body, {
      type: 'contact-request.review',
      connectionId: c.req.param('connectionId'),
      personId: person.id,
      decision,
    })
    if (signed instanceof Response) return signed
    const now = new Date().toISOString()
    const result = db.prepare(`
      UPDATE beam_connections
      SET status = ?, held_for_person_id = NULL, updated_at = ?, responded_at = ?
      WHERE connection_id = ? AND held_for_person_id = ? AND status = 'pending'
    `).run(decision, now, now, c.req.param('connectionId'), person.id)
    if (result.changes !== 1) {
      return c.json({ error: 'Contact request not found', errorCode: 'NOT_FOUND' }, 404)
    }
    logAuditEvent(db, {
      action: 'network.contact_request.reviewed',
      actor: signed === 'valid' ? `person:${person.id}` : `org:${owned.name}`,
      target: c.req.param('connectionId'),
      details: { decision, via: signed === 'valid' ? 'person' : 'org-key' },
    })
    return c.json({ connectionId: c.req.param('connectionId'), status: decision })
  })

  router.get('/:name/approvals', (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const rows = listApprovalsForOrg(db, owned.name)
    return c.json({
      approvals: rows.map((row) => ({
        id: row.id,
        nonce: row.nonce,
        from: row.from_beam_id,
        to: row.to_beam_id,
        intent: row.intent_type,
        reason: row.reason,
        status: row.status,
        escalationPersonId: row.escalation_person_id,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        executed: false,
      })),
      total: rows.length,
    })
  })

  router.post('/:name/approvals/:id', async (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }
    const decision = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['decision']
      : null
    if (decision !== 'approved' && decision !== 'rejected') {
      return c.json({ error: 'decision must be approved or rejected', errorCode: 'INVALID_DECISION' }, 400)
    }
    const pending = getApproval(db, c.req.param('id'))
    if (!pending || pending.status !== 'pending') {
      return c.json({ error: 'Pending approval not found', errorCode: 'NOT_FOUND' }, 404)
    }
    const signerId = pending.escalation_person_id ?? getAgent(db, pending.from_beam_id)?.responsible_person_id ?? null
    const signer = signerId ? getPerson(db, signerId) : null
    const body = raw as Record<string, unknown>
    const signature = typeof body['signature'] === 'string' ? body['signature'].trim() : ''
    let via: 'person' | 'org-key' = 'org-key'
    if (signature) {
      if (!signer || signer.org_name !== owned.name || signer.status !== 'active') {
        return c.json({ error: 'The escalation person must sign this approval', errorCode: 'INVALID_SIGNATURE' }, 400)
      }
      const signed = readPersonSignature(db, signer, body, {
        type: 'intent.approval',
        approvalId: pending.id,
        decision,
        personId: signer.id,
      })
      if (signed instanceof Response) return signed
      if (signed !== 'valid') {
        return c.json({ error: 'The escalation person must sign this approval', errorCode: 'INVALID_SIGNATURE' }, 400)
      }
      via = 'person'
    }
    const row = decideApproval(db, { id: pending.id, orgName: owned.name, decision })
    if (!row) return c.json({ error: 'Pending approval not found', errorCode: 'NOT_FOUND' }, 404)
    logAuditEvent(db, {
      action: 'intent.approval.decided',
      actor: via === 'person' ? `person:${signer?.id}` : `org:${owned.name}`,
      target: row.id,
      details: { decision, executed: false, via },
    })
    return c.json({ id: row.id, status: row.status, executed: false })
  })

  return router
}
