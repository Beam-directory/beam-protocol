import type { Database } from 'better-sqlite3'
import { getAgent, getOrg } from '../db.js'
import type { IntentFrame } from '../types.js'
import { scopeActionForIntent, type ScopeAction } from './scopes.js'

export type AcceptanceRule = {
  owner_beam_id: string
  allowed_org_domains: string[]
  allowed_scopes: string[]
  allowed_agents: string[]
  require_known_contact: number
  updated_at: string
}

type AcceptanceRow = {
  owner_beam_id: string
  allowed_org_domains: string
  allowed_scopes: string
  allowed_agents: string
  require_known_contact: number
  updated_at: string
}

function parseList(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
}

function mapRule(row: AcceptanceRow): AcceptanceRule {
  return {
    owner_beam_id: row.owner_beam_id,
    allowed_org_domains: parseList(row.allowed_org_domains),
    allowed_scopes: parseList(row.allowed_scopes),
    allowed_agents: parseList(row.allowed_agents),
    require_known_contact: row.require_known_contact,
    updated_at: row.updated_at,
  }
}

export function getAcceptanceRule(db: Database, ownerBeamId: string): AcceptanceRule | null {
  const row = db.prepare('SELECT * FROM acceptance_rules WHERE owner_beam_id = ?').get(ownerBeamId) as AcceptanceRow | undefined
  return row ? mapRule(row) : null
}

export function saveAcceptanceRule(
  db: Database,
  input: {
    ownerBeamId: string
    allowedOrgDomains: string[]
    allowedScopes: string[]
    allowedAgents: string[]
    requireKnownContact: boolean
  },
): AcceptanceRule {
  const updatedAt = new Date().toISOString()
  db.prepare(`
    INSERT INTO acceptance_rules (
      owner_beam_id, allowed_org_domains, allowed_scopes, allowed_agents, require_known_contact, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_beam_id) DO UPDATE SET
      allowed_org_domains = excluded.allowed_org_domains,
      allowed_scopes = excluded.allowed_scopes,
      allowed_agents = excluded.allowed_agents,
      require_known_contact = excluded.require_known_contact,
      updated_at = excluded.updated_at
  `).run(
    input.ownerBeamId,
    JSON.stringify(input.allowedOrgDomains),
    JSON.stringify(input.allowedScopes),
    JSON.stringify(input.allowedAgents),
    input.requireKnownContact ? 1 : 0,
    updatedAt,
  )
  return getAcceptanceRule(db, input.ownerBeamId) as AcceptanceRule
}

export function hasAcceptedConnection(db: Database, leftBeamId: string, rightBeamId: string): boolean {
  const row = db.prepare(`
    SELECT connection_id
    FROM beam_connections
    WHERE status = 'accepted'
      AND (
        (requester_beam_id = ? AND recipient_beam_id = ?)
        OR (requester_beam_id = ? AND recipient_beam_id = ?)
      )
    LIMIT 1
  `).get(leftBeamId, rightBeamId, rightBeamId, leftBeamId) as { connection_id: string } | undefined
  return Boolean(row)
}

function scopeAllowed(allowed: string[], intent: string): boolean {
  if (allowed.includes(intent)) {
    return true
  }
  const action: ScopeAction | null = scopeActionForIntent(intent)
  return action !== null && allowed.includes(action)
}

/** A missing rule keeps today's ACL behavior. Empty lists add no filter of that dimension. */
export function acceptanceDenial(db: Database, frame: Pick<IntentFrame, 'from' | 'to' | 'intent'>): string | null {
  const rule = getAcceptanceRule(db, frame.to)
  if (!rule) {
    return null
  }

  if (rule.allowed_org_domains.length > 0) {
    const sender = getAgent(db, frame.from)
    const domain = sender?.org ? getOrg(db, sender.org)?.domain?.toLowerCase() ?? '' : ''
    if (!rule.allowed_org_domains.includes(domain)) {
      return 'Recipient does not accept this sender organization'
    }
  }

  if (rule.allowed_agents.length > 0 && !rule.allowed_agents.includes(frame.from)) {
    return 'Recipient does not accept this sender'
  }

  if (rule.allowed_scopes.length > 0 && !scopeAllowed(rule.allowed_scopes, frame.intent)) {
    return 'Recipient does not accept this scope'
  }

  if (rule.require_known_contact === 1 && !hasAcceptedConnection(db, frame.from, frame.to)) {
    return 'Recipient only accepts known contacts'
  }

  return null
}

export function serializeAcceptanceRule(rule: AcceptanceRule): object {
  return {
    beamId: rule.owner_beam_id,
    allowedOrgDomains: rule.allowed_org_domains,
    allowedScopes: rule.allowed_scopes,
    allowedAgents: rule.allowed_agents,
    requireKnownContact: rule.require_known_contact === 1,
    updatedAt: rule.updated_at,
  }
}
