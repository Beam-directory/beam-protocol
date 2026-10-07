import type { Database } from 'better-sqlite3'
import { getAgent, getOrg } from '../db.js'

export function senderOrgSuspended(db: Database, beamId: string): boolean {
  const agent = getAgent(db, beamId)
  if (!agent?.org) return false
  return Boolean(getOrg(db, agent.org)?.suspended_at)
}

export function suspendOrg(db: Database, orgName: string, at = new Date().toISOString()): boolean {
  const result = db.prepare(`
    UPDATE orgs
    SET suspended_at = COALESCE(suspended_at, ?)
    WHERE name = ?
  `).run(at, orgName)
  return result.changes === 1
}

export function orgIsSuspended(db: Database, orgName: string): boolean {
  return Boolean(getOrg(db, orgName)?.suspended_at)
}
