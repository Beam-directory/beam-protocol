import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { ScopeGrant } from './scopes.js'

export type PersonRow = {
  id: string
  org_name: string
  email: string
  display_name: string
  role: string
  supervisor_person_id: string | null
  status: 'active' | 'offboarded'
  kyc_status: 'unverified' | 'pending' | 'verified' | 'rejected'
  kyc_provider: string | null
  kyc_reference: string | null
  public_key: string | null
  rights_json: string
  external_source: 'personio' | 'entra' | null
  external_id: string | null
  offboarded_at: string | null
  created_at: string
}

export type PersonInvitationRow = {
  id: string
  org_name: string
  email: string
  role: string
  supervisor_person_id: string | null
  token_hash: string
  rights_json: string
  expires_at: string
  accepted_at: string | null
  created_at: string
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createInvitationToken(): string {
  return randomBytes(32).toString('base64url')
}

export function getPerson(db: Database, id: string): PersonRow | null {
  const row = db.prepare('SELECT * FROM persons WHERE id = ?').get(id) as PersonRow | undefined
  return row ?? null
}

export function getPersonByEmail(db: Database, orgName: string, email: string): PersonRow | null {
  const row = db.prepare('SELECT * FROM persons WHERE org_name = ? AND email = ?').get(orgName, email) as PersonRow | undefined
  return row ?? null
}

export function listPeople(db: Database, orgName: string): PersonRow[] {
  return db.prepare('SELECT * FROM persons WHERE org_name = ? ORDER BY created_at ASC, id ASC').all(orgName) as PersonRow[]
}

export function supervisorCreatesCycle(db: Database, personId: string | null, supervisorId: string | null): boolean {
  if (!supervisorId) {
    return false
  }
  let current: string | null = supervisorId
  const seen = new Set<string>()
  while (current) {
    if (current === personId || seen.has(current)) {
      return true
    }
    seen.add(current)
    const row: PersonRow | null = getPerson(db, current)
    current = row?.supervisor_person_id ?? null
  }
  return false
}

export function insertPerson(
  db: Database,
  input: {
    orgName: string
    email: string
    displayName: string
    role: string
    supervisorPersonId: string | null
    publicKey: string | null
    rights: ScopeGrant
    externalSource?: 'personio' | 'entra' | null
    externalId?: string | null
    status?: 'active' | 'offboarded'
  },
): PersonRow {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  const status = input.status ?? 'active'
  db.prepare(`
    INSERT INTO persons (
      id, org_name, email, display_name, role, supervisor_person_id, status,
      kyc_status, kyc_provider, kyc_reference, public_key, rights_json,
      external_source, external_id, offboarded_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified', NULL, NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.orgName,
    input.email,
    input.displayName,
    input.role,
    input.supervisorPersonId,
    status,
    input.publicKey,
    JSON.stringify(input.rights),
    input.externalSource ?? null,
    input.externalId ?? null,
    status === 'offboarded' ? createdAt : null,
    createdAt,
  )
  return getPerson(db, id) as PersonRow
}

export function updatePersonRecord(
  db: Database,
  id: string,
  input: {
    email: string
    displayName: string
    role: string
    supervisorPersonId: string | null
    rights: ScopeGrant
    publicKey?: string | null
  },
): PersonRow | null {
  db.prepare(`
    UPDATE persons
    SET email = ?, display_name = ?, role = ?, supervisor_person_id = ?, rights_json = ?,
        public_key = COALESCE(?, public_key)
    WHERE id = ?
  `).run(
    input.email,
    input.displayName,
    input.role,
    input.supervisorPersonId,
    JSON.stringify(input.rights),
    input.publicKey ?? null,
    id,
  )
  return getPerson(db, id)
}

export function setPersonKyc(
  db: Database,
  id: string,
  input: { status: PersonRow['kyc_status']; provider: string | null; reference: string | null },
): PersonRow | null {
  db.prepare(`
    UPDATE persons
    SET kyc_status = ?, kyc_provider = ?, kyc_reference = ?
    WHERE id = ?
  `).run(input.status, input.provider, input.reference, id)
  return getPerson(db, id)
}

export function createPersonInvitation(
  db: Database,
  input: {
    orgName: string
    email: string
    role: string
    supervisorPersonId: string | null
    rights: ScopeGrant
    tokenHash: string
    expiresAt: string
  },
): PersonInvitationRow {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  db.prepare(`
    INSERT INTO person_invitations (
      id, org_name, email, role, supervisor_person_id, token_hash, rights_json, expires_at, accepted_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(
    id,
    input.orgName,
    input.email,
    input.role,
    input.supervisorPersonId,
    input.tokenHash,
    JSON.stringify(input.rights),
    input.expiresAt,
    createdAt,
  )
  return getInvitationById(db, id) as PersonInvitationRow
}

export function getInvitationByHash(db: Database, tokenHash: string): PersonInvitationRow | null {
  const row = db.prepare('SELECT * FROM person_invitations WHERE token_hash = ?').get(tokenHash) as PersonInvitationRow | undefined
  return row ?? null
}

function getInvitationById(db: Database, id: string): PersonInvitationRow | null {
  const row = db.prepare('SELECT * FROM person_invitations WHERE id = ?').get(id) as PersonInvitationRow | undefined
  return row ?? null
}

export function markInvitationAccepted(db: Database, id: string, acceptedAt: string): void {
  db.prepare('UPDATE person_invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL').run(acceptedAt, id)
}

export function findPersonByExternalId(
  db: Database,
  orgName: string,
  source: 'personio' | 'entra',
  externalId: string,
): PersonRow | null {
  const row = db.prepare(`
    SELECT * FROM persons
    WHERE org_name = ? AND external_source = ? AND external_id = ?
  `).get(orgName, source, externalId) as PersonRow | undefined
  return row ?? null
}

export function agentOperationBlock(
  db: Database,
  agent: { suspended_at: string | null; responsible_person_id: string | null },
): { error: string; errorCode: 'AGENT_SUSPENDED' | 'PERSON_OFFBOARDED' } | null {
  if (agent.suspended_at) {
    return { error: 'This agent is suspended', errorCode: 'AGENT_SUSPENDED' }
  }
  if (agent.responsible_person_id) {
    const person = getPerson(db, agent.responsible_person_id)
    if (!person || person.status !== 'active') {
      return { error: 'The responsible person is not active', errorCode: 'PERSON_OFFBOARDED' }
    }
  }
  return null
}

export function suspendAgentsForPerson(db: Database, personId: string, at: string): number {
  const result = db.prepare(`
    UPDATE agents
    SET suspended_at = ?
    WHERE responsible_person_id = ? AND suspended_at IS NULL
  `).run(at, personId)
  return result.changes
}

export function offboardPerson(db: Database, person: PersonRow): { person: PersonRow; suspendedAgents: number } {
  const at = person.offboarded_at ?? new Date().toISOString()
  if (person.status !== 'offboarded') {
    db.prepare(`
      UPDATE persons
      SET status = 'offboarded', offboarded_at = ?
      WHERE id = ?
    `).run(at, person.id)
  }
  const suspendedAgents = suspendAgentsForPerson(db, person.id, at)
  return { person: getPerson(db, person.id) as PersonRow, suspendedAgents }
}

export function setAgentResponsiblePerson(db: Database, beamId: string, personId: string): void {
  db.prepare('UPDATE agents SET responsible_person_id = ? WHERE beam_id = ?').run(personId, beamId)
}

export function serializePerson(row: PersonRow): object {
  return {
    id: row.id,
    org: row.org_name,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    supervisorPersonId: row.supervisor_person_id,
    status: row.status,
    kycStatus: row.kyc_status,
    kycProvider: row.kyc_provider,
    kycReference: row.kyc_reference,
    publicKey: row.public_key,
    rights: JSON.parse(row.rights_json) as unknown,
    externalSource: row.external_source,
    externalId: row.external_id,
    offboardedAt: row.offboarded_at,
    createdAt: row.created_at,
  }
}
