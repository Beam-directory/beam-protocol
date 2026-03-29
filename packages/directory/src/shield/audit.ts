/**
 * Beam Shield — Wall 5: Audit Log
 * Records every external intent interaction for security monitoring.
 */

import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'

export interface AuditEvent {
  nonce?: string | null
  timestamp: string
  senderBeamId: string
  senderTrust: number
  intentType: string
  payloadHash: string
  decision: 'pass' | 'hold' | 'reject'
  riskScore: number
  responseSize: number
  anomalyFlags: string[]
}

export function hashPayload(payload: unknown): string {
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {})
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}

export function logShieldEvent(db: Database, event: AuditEvent): void {
  if (event.nonce) {
    db.prepare('DELETE FROM shield_audit_log WHERE nonce = ?').run(event.nonce)
  }

  db.prepare(`
    INSERT INTO shield_audit_log
    (nonce, timestamp, sender_beam_id, sender_trust, intent_type, payload_hash, decision, risk_score, response_size, anomaly_flags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.nonce ?? null,
    event.timestamp,
    event.senderBeamId,
    event.senderTrust,
    event.intentType,
    event.payloadHash,
    event.decision,
    event.riskScore,
    event.responseSize,
    JSON.stringify(event.anomalyFlags),
    new Date().toISOString(),
  )
}

interface AuditRow {
  nonce: string | null
  timestamp: string
  sender_beam_id: string
  sender_trust: number
  intent_type: string
  payload_hash: string
  decision: string
  risk_score: number
  response_size: number
  anomaly_flags: string
  created_at: string
}

export function getRecentEvents(
  db: Database,
  beamId: string,
  hours = 24,
): AuditEvent[] {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString()
  const rows = db.prepare(
    'SELECT * FROM shield_audit_log WHERE sender_beam_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 100',
  ).all(beamId, cutoff) as AuditRow[]

  return rows.map((r) => ({
    nonce: r.nonce,
    timestamp: r.timestamp,
    senderBeamId: r.sender_beam_id,
    senderTrust: r.sender_trust,
    intentType: r.intent_type,
    payloadHash: r.payload_hash,
    decision: r.decision as AuditEvent['decision'],
    riskScore: r.risk_score,
    responseSize: r.response_size,
    anomalyFlags: JSON.parse(r.anomaly_flags || '[]') as string[],
  }))
}

export function getAuditStats(
  db: Database,
  hours = 24,
): { total: number; passed: number; held: number; rejected: number } {
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString()
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN decision = 'pass' THEN 1 ELSE 0 END) as passed,
      SUM(CASE WHEN decision = 'hold' THEN 1 ELSE 0 END) as held,
      SUM(CASE WHEN decision = 'reject' THEN 1 ELSE 0 END) as rejected
    FROM shield_audit_log WHERE created_at > ?
  `).get(cutoff) as { total: number; passed: number; held: number; rejected: number }

  return {
    total: row?.total ?? 0,
    passed: row?.passed ?? 0,
    held: row?.held ?? 0,
    rejected: row?.rejected ?? 0,
  }
}
