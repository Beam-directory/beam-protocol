import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { ScopeGrant } from './scopes.js'

export type MandateRow = {
  id: string
  jti: string
  version: number
  person_id: string
  agent_beam_id: string
  org_name: string
  scopes_json: string
  expires_at: string
  escalation_person_id: string | null
  signature: string
  payload_hash: string
  status: 'active' | 'revoked'
  revoked_at: string | null
  created_at: string
}

export class MandateError extends Error {
  constructor(readonly code: 'MANDATE_REPLAY' | 'MANDATE_EXISTS', message: string) {
    super(message)
  }
}

export function hashCanonical(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function getMandateByJti(db: Database, jti: string): MandateRow | null {
  const row = db.prepare('SELECT * FROM mandates WHERE jti = ?').get(jti) as MandateRow | undefined
  return row ?? null
}

export function getMandateByHash(db: Database, payloadHash: string): MandateRow | null {
  const row = db.prepare('SELECT * FROM mandates WHERE payload_hash = ?').get(payloadHash) as MandateRow | undefined
  return row ?? null
}

export function getActiveMandate(db: Database, agentBeamId: string, at = new Date().toISOString()): MandateRow | null {
  const row = db.prepare(`
    SELECT * FROM mandates
    WHERE agent_beam_id = ? AND status = 'active' AND expires_at > ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(agentBeamId, at) as MandateRow | undefined
  return row ?? null
}

export function insertMandate(
  db: Database,
  input: {
    jti: string
    personId: string
    agentBeamId: string
    orgName: string
    scopes: ScopeGrant
    expiresAt: string
    escalationPersonId: string | null
    signature: string
    payloadHash: string
  },
): MandateRow {
  const existingHash = getMandateByHash(db, input.payloadHash)
  if (existingHash) {
    throw new MandateError('MANDATE_REPLAY', 'This signed mandate was already recorded and cannot be created again')
  }
  if (getMandateByJti(db, input.jti)) {
    throw new MandateError('MANDATE_EXISTS', 'A mandate with this jti already exists')
  }

  const id = randomUUID()
  const createdAt = new Date().toISOString()
  db.prepare(`
    INSERT INTO mandates (
      id, jti, version, person_id, agent_beam_id, org_name, scopes_json, expires_at,
      escalation_person_id, signature, payload_hash, status, created_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    id,
    input.jti,
    input.personId,
    input.agentBeamId,
    input.orgName,
    JSON.stringify(input.scopes),
    input.expiresAt,
    input.escalationPersonId,
    input.signature,
    input.payloadHash,
    createdAt,
  )
  return getMandateByJti(db, input.jti) as MandateRow
}

export function revokeMandate(db: Database, jti: string, at = new Date().toISOString()): MandateRow | null {
  db.prepare(`
    UPDATE mandates
    SET status = 'revoked', revoked_at = ?
    WHERE jti = ? AND status = 'active'
  `).run(at, jti)
  return getMandateByJti(db, jti)
}

export function revokeActiveMandatesForPerson(db: Database, personId: string, at: string): number {
  const result = db.prepare(`
    UPDATE mandates
    SET status = 'revoked', revoked_at = ?
    WHERE person_id = ? AND status = 'active'
  `).run(at, personId)
  return result.changes
}

export function serializeMandate(row: MandateRow): object {
  return {
    id: row.id,
    jti: row.jti,
    version: row.version,
    personId: row.person_id,
    agentBeamId: row.agent_beam_id,
    org: row.org_name,
    scopes: JSON.parse(row.scopes_json) as ScopeGrant,
    expiresAt: row.expires_at,
    escalationPersonId: row.escalation_person_id,
    status: row.status,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }
}
