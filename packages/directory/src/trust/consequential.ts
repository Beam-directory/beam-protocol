import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { IntentFrame } from '../types.js'
import { isAllowedAttachmentMime } from './attachments.js'
import { getActiveMandate } from './mandate-store.js'
import { getAgent } from '../db.js'
import { getPerson } from './person-store.js'
import { amountToCents, moneyWithinLimit, parseScopeGrant, scopeActionForIntent, type ScopeAction, type ScopeGrant } from './scopes.js'

export type ApprovalRow = {
  id: string
  nonce: string
  from_beam_id: string
  to_beam_id: string
  intent_type: string
  payload_json: string
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  escalation_person_id: string | null
  created_at: string
  decided_at: string | null
}

function limitReason(action: ScopeAction, scopes: ScopeGrant, payload: Record<string, unknown>): string | null {
  if (!scopes.actions.includes(action)) {
    return 'outside mandate scope'
  }
  if (action === 'order') {
    const amount = typeof payload['amount'] === 'string' ? payload['amount'].trim() : ''
    const currency = typeof payload['currency'] === 'string' ? payload['currency'].trim().toUpperCase() : ''
    if (!scopes.order || !moneyWithinLimit(amount, currency, scopes.order)) {
      return 'order limit exceeded'
    }
  }
  if (action === 'file.send') {
    const byteSize = payload['byteSize']
    if (!scopes.file || typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > scopes.file.maxBytes) {
      return 'file limit exceeded'
    }
  }
  return null
}

export function holdConsequentialIntent(
  db: Database,
  frame: IntentFrame,
): { kind: 'approval'; approvalId: string; reason: string } | { kind: 'reject'; message: string } | null {
  const action = scopeActionForIntent(frame.intent)
  if (!action) return null
  if (action === 'file.send') {
    const mimeType = typeof frame.payload['mimeType'] === 'string' ? frame.payload['mimeType'] : ''
    if (!isAllowedAttachmentMime(mimeType)) {
      return { kind: 'reject', message: 'Attachment type is not allowed and is not executed' }
    }
  }

  const existing = db.prepare('SELECT id, reason FROM intent_approvals WHERE nonce = ?').get(frame.nonce) as { id: string; reason: string } | undefined
  if (existing) {
    return { kind: 'approval', approvalId: existing.id, reason: existing.reason }
  }

  const agent = getAgent(db, frame.from)
  const mandate = getActiveMandate(db, frame.from)
  const scopes = mandate ? parseScopeGrant(JSON.parse(mandate.scopes_json) as unknown) : null
  let reason = scopes ? limitReason(action, scopes, frame.payload) : 'outside mandate scope'
  if (!reason && action === 'order' && mandate && scopes?.order) {
    reason = reserveOrderSpend(db, mandate.jti, frame, scopes.order)
  }
  if (!reason) return null

  const escalationPersonId = mandate?.escalation_person_id
    ?? (agent?.responsible_person_id && getPerson(db, agent.responsible_person_id)?.status === 'active'
      ? agent.responsible_person_id
      : null)
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  db.prepare(`
    INSERT INTO intent_approvals (
      id, nonce, from_beam_id, to_beam_id, intent_type, payload_json, reason, status, escalation_person_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    id,
    frame.nonce,
    frame.from,
    frame.to,
    frame.intent,
    JSON.stringify(frame.payload),
    reason,
    escalationPersonId,
    createdAt,
  )
  return { kind: 'approval', approvalId: id, reason }
}

export function getApproval(db: Database, id: string): ApprovalRow | null {
  const row = db.prepare('SELECT * FROM intent_approvals WHERE id = ?').get(id) as ApprovalRow | undefined
  return row ?? null
}

export function listApprovalsForOrg(db: Database, orgName: string): ApprovalRow[] {
  return db.prepare(`
    SELECT a.*
    FROM intent_approvals a
    LEFT JOIN agents sender ON sender.beam_id = a.from_beam_id
    LEFT JOIN persons p ON p.id = a.escalation_person_id
    WHERE sender.org = ? OR p.org_name = ?
    ORDER BY a.created_at DESC
  `).all(orgName, orgName) as ApprovalRow[]
}

export function decideApproval(
  db: Database,
  input: { id: string; orgName: string; decision: 'approved' | 'rejected' },
): ApprovalRow | null {
  const decidedAt = new Date().toISOString()
  const result = db.prepare(`
    UPDATE intent_approvals
    SET status = ?, decided_at = ?
    WHERE id = ? AND status = 'pending'
      AND (
        escalation_person_id IN (SELECT id FROM persons WHERE org_name = ?)
        OR from_beam_id IN (SELECT beam_id FROM agents WHERE org = ?)
      )
  `).run(input.decision, decidedAt, input.id, input.orgName, input.orgName)
  if (result.changes !== 1) return null
  return db.prepare('SELECT * FROM intent_approvals WHERE id = ?').get(input.id) as ApprovalRow
}

function reserveOrderSpend(
  db: Database,
  mandateJti: string,
  frame: IntentFrame,
  limit: { maxAmount: string; currency: string },
): string | null {
  const amount = typeof frame.payload['amount'] === 'string' ? frame.payload['amount'].trim() : ''
  const currency = typeof frame.payload['currency'] === 'string' ? frame.payload['currency'].trim().toUpperCase() : ''
  if (!moneyWithinLimit(amount, currency, limit)) return 'order limit exceeded'
  const cents = amountToCents(amount)
  const day = new Date(frame.timestamp).toISOString().slice(0, 10)
  const already = db.prepare('SELECT nonce FROM mandate_order_spend WHERE nonce = ?').get(frame.nonce)
  if (already) return null
  const spent = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS total
    FROM mandate_order_spend
    WHERE mandate_jti = ? AND day = ?
  `).get(mandateJti, day) as { total: number }
  if (BigInt(spent.total) + cents > amountToCents(limit.maxAmount)) {
    return 'daily order limit exceeded'
  }
  db.prepare(`
    INSERT INTO mandate_order_spend (nonce, mandate_jti, day, amount_cents, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(frame.nonce, mandateJti, day, Number(cents), new Date().toISOString())
  return null
}
