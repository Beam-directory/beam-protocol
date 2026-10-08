import type { Database } from 'better-sqlite3'
import type { RegistryClaim } from './registry-format.js'

export type OrgRegistryFilingRow = {
  id: number
  org_name: string
  kind: 'handelsregister' | 'lei'
  country: string
  registration_number: string
  register_court: string | null
  legal_name: string
  applicant_name: string
  applicant_role: string
  status: 'pending' | 'approved' | 'rejected'
  review_note: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
}

export function createOrgRegistryFiling(
  db: Database,
  orgName: string,
  claim: RegistryClaim,
): OrgRegistryFilingRow {
  const createdAt = new Date().toISOString()
  const result = db.prepare(`
    INSERT INTO org_registry_filings (
      org_name, kind, country, registration_number, register_court, legal_name,
      applicant_name, applicant_role, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    orgName,
    claim.kind,
    claim.country,
    claim.registrationNumber,
    claim.registerCourt,
    claim.legalName,
    claim.applicantName,
    claim.applicantRole,
    createdAt,
  )
  return getOrgRegistryFiling(db, Number(result.lastInsertRowid)) as OrgRegistryFilingRow
}

export function getOrgRegistryFiling(db: Database, id: number): OrgRegistryFilingRow | null {
  const row = db.prepare('SELECT * FROM org_registry_filings WHERE id = ?').get(id) as OrgRegistryFilingRow | undefined
  return row ?? null
}

export function listOrgRegistryFilings(db: Database, orgName: string): OrgRegistryFilingRow[] {
  return db.prepare(`
    SELECT * FROM org_registry_filings
    WHERE org_name = ?
    ORDER BY created_at DESC, id DESC
  `).all(orgName) as OrgRegistryFilingRow[]
}

export function reviewOrgRegistryFiling(
  db: Database,
  input: { id: number; orgName: string; decision: 'approved' | 'rejected'; reviewer: string; note: string },
): OrgRegistryFilingRow | null {
  const reviewedAt = new Date().toISOString()
  const result = db.prepare(`
    UPDATE org_registry_filings
    SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?
    WHERE id = ? AND org_name = ? AND status = 'pending'
  `).run(input.decision, input.note, input.reviewer, reviewedAt, input.id, input.orgName)
  if (result.changes !== 1) {
    return null
  }
  return getOrgRegistryFiling(db, input.id)
}

export function serializeOrgRegistryFiling(row: OrgRegistryFilingRow): object {
  return {
    id: row.id,
    org: row.org_name,
    kind: row.kind,
    country: row.country,
    registrationNumber: row.registration_number,
    registerCourt: row.register_court,
    legalName: row.legal_name,
    applicantName: row.applicant_name,
    applicantRole: row.applicant_role,
    status: row.status,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  }
}
