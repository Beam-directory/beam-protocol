import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import type { AgentRow, AgentStatsRow, OrganizationRow, RegisterRequest } from './types.js'

const MAX_ACCOUNT_AGE_DAYS = 30
const MAX_RECENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MAX_RECENCY_SCORE_MS = 60 * 60 * 1000

export function createDatabase(dbPath = './beam-directory.db'): DB {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

function initSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      contact_email TEXT
    );

    CREATE TABLE IF NOT EXISTS agents (
      beam_id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      display_name TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      public_key TEXT NOT NULL,
      trust_score REAL NOT NULL DEFAULT 0.5,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      FOREIGN KEY (org) REFERENCES organizations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org);
    CREATE INDEX IF NOT EXISTS idx_agents_trust ON agents(trust_score DESC);

    CREATE TABLE IF NOT EXISTS agent_stats (
      beam_id TEXT PRIMARY KEY,
      intents_received INTEGER NOT NULL DEFAULT 0,
      intents_responded INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (beam_id) REFERENCES agents(beam_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nonces_expires ON nonces(expires_at);

    CREATE TABLE IF NOT EXISTS intent_acls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_beam_id TEXT NOT NULL,
      intent_type TEXT NOT NULL,
      allowed_from TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (target_beam_id) REFERENCES agents(beam_id),
      UNIQUE(target_beam_id, intent_type, allowed_from)
    );

    CREATE INDEX IF NOT EXISTS idx_intent_acls_target_intent
      ON intent_acls(target_beam_id, intent_type);
  `)
}

export function registerOrganization(
  db: DB,
  data: { name: string; displayName: string; contactEmail?: string | null }
): OrganizationRow {
  const now = new Date().toISOString()
  const existing = getOrganization(db, data.name)

  if (existing) {
    db.prepare(`
      UPDATE organizations
      SET display_name = ?,
          contact_email = COALESCE(?, contact_email)
      WHERE id = ?
    `).run(data.displayName, data.contactEmail ?? null, data.name)
  } else {
    db.prepare(`
      INSERT INTO organizations (id, name, display_name, verified, created_at, contact_email)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(data.name, data.name, data.displayName, now, data.contactEmail ?? null)
  }

  return getOrganization(db, data.name) as OrganizationRow
}

export function ensureOrganization(
  db: DB,
  data: { name: string; displayName?: string; contactEmail?: string | null }
): OrganizationRow {
  const existing = getOrganization(db, data.name)
  if (existing) {
    return existing
  }

  return registerOrganization(db, {
    name: data.name,
    displayName: data.displayName ?? data.name,
    contactEmail: data.contactEmail ?? null,
  })
}

export function getOrganization(db: DB, orgName: string): OrganizationRow | null {
  const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgName) as OrganizationRow | undefined
  return row ?? null
}

export function listOrganizations(db: DB): OrganizationRow[] {
  return db.prepare('SELECT * FROM organizations ORDER BY name ASC').all() as OrganizationRow[]
}

export function getAgentStats(db: DB, beamId: string): AgentStatsRow | null {
  const row = db.prepare('SELECT * FROM agent_stats WHERE beam_id = ?').get(beamId) as AgentStatsRow | undefined
  return row ?? null
}

export function initializeAgentStats(db: DB, beamId: string): void {
  db.prepare(`
    INSERT INTO agent_stats (beam_id, intents_received, intents_responded)
    VALUES (?, 0, 0)
    ON CONFLICT(beam_id) DO NOTHING
  `).run(beamId)
}

export function incrementAgentStat(
  db: DB,
  beamId: string,
  field: 'intents_received' | 'intents_responded'
): void {
  initializeAgentStats(db, beamId)
  db.prepare(`UPDATE agent_stats SET ${field} = ${field} + 1 WHERE beam_id = ?`).run(beamId)
  recomputeTrustScore(db, beamId)
}

/**
 * Insert or update an agent record. Returns the resulting row.
 */
export function registerAgent(db: DB, data: RegisterRequest): AgentRow {
  const now = new Date().toISOString()
  const capabilitiesJson = JSON.stringify(data.capabilities)

  ensureOrganization(db, { name: data.org, displayName: data.org })

  const existing = getAgent(db, data.beamId)

  if (existing) {
    db.prepare(`
      UPDATE agents
      SET org = ?,
          display_name = ?,
          capabilities = ?,
          public_key = ?,
          last_seen = ?
      WHERE beam_id = ?
    `).run(
      data.org,
      data.displayName,
      capabilitiesJson,
      data.publicKey,
      now,
      data.beamId
    )
  } else {
    db.prepare(`
      INSERT INTO agents (beam_id, org, display_name, capabilities, public_key, trust_score, verified, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(
      data.beamId,
      data.org,
      data.displayName,
      capabilitiesJson,
      data.publicKey,
      now,
      now
    )
  }

  initializeAgentStats(db, data.beamId)
  recomputeTrustScore(db, data.beamId)

  return getAgent(db, data.beamId) as AgentRow
}

/**
 * Retrieve a single agent by beam ID. Returns null if not found.
 */
export function getAgent(db: DB, beamId: string): AgentRow | null {
  const row = db.prepare('SELECT * FROM agents WHERE beam_id = ?').get(beamId) as AgentRow | undefined
  return row ?? null
}

/**
 * Search agents with optional filters. Capabilities filtering is done in JavaScript
 * for compatibility with SQLite versions that lack full JSON function support.
 */
export function searchAgents(
  db: DB,
  query: {
    org?: string
    capabilities?: string[]
    minTrustScore?: number
    limit?: number
  }
): AgentRow[] {
  const params: (string | number)[] = []
  const conditions: string[] = []

  if (query.org) {
    conditions.push('org = ?')
    params.push(query.org)
  }

  if (query.minTrustScore !== undefined) {
    conditions.push('trust_score >= ?')
    params.push(query.minTrustScore)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limitClause = query.limit !== undefined ? `LIMIT ${Math.max(1, Math.min(500, query.limit))}` : 'LIMIT 100'

  const sql = `SELECT * FROM agents ${where} ORDER BY trust_score DESC ${limitClause}`
  let rows = db.prepare(sql).all(...params) as AgentRow[]

  if (query.capabilities && query.capabilities.length > 0) {
    const required = new Set(query.capabilities)
    rows = rows.filter((row) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.capabilities)
      } catch {
        return false
      }
      if (!Array.isArray(parsed)) return false
      const agentCaps = new Set(parsed as string[])
      for (const cap of required) {
        if (!agentCaps.has(cap)) return false
      }
      return true
    })
  }

  return rows
}

/**
 * Update the last_seen timestamp for an agent.
 */
export function updateLastSeen(db: DB, beamId: string): void {
  const now = new Date().toISOString()
  db.prepare('UPDATE agents SET last_seen = ? WHERE beam_id = ?').run(now, beamId)
  recomputeTrustScore(db, beamId)
}

export function recomputeTrustScore(db: DB, beamId: string): number {
  const row = getAgent(db, beamId)
  if (!row) return 0

  const org = getOrganization(db, row.org)
  const verified = org?.verified === 1 ? 1 : 0
  const score = computeTrustScore(db, beamId)

  db.prepare('UPDATE agents SET trust_score = ?, verified = ? WHERE beam_id = ?').run(score, verified, beamId)
  return score
}

/**
 * Record a nonce to prevent replay attacks.
 * Returns false if the nonce has already been seen (replay detected).
 * Nonces expire after 5 minutes.
 */
export function recordNonce(db: DB, nonce: string): boolean {
  const expiresAt = Date.now() + 5 * 60 * 1000

  try {
    db.prepare('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt)
    return true
  } catch {
    return false
  }
}

/**
 * Remove all expired nonces from the database.
 */
export function cleanExpiredNonces(db: DB): void {
  db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(Date.now())
}

export function computeTrustScore(db: DB, beamId: string): number {
  const row = getAgent(db, beamId)
  if (!row) return 0

  const now = Date.now()
  const createdAt = new Date(row.created_at).getTime()
  const lastSeen = new Date(row.last_seen).getTime()
  const stats = getAgentStats(db, beamId)
  const organization = getOrganization(db, row.org)

  const ageDays = Number.isNaN(createdAt) ? 0 : Math.max(0, (now - createdAt) / (24 * 60 * 60 * 1000))
  const accountAgeScore = Math.min(ageDays, MAX_ACCOUNT_AGE_DAYS) / MAX_ACCOUNT_AGE_DAYS * 0.2

  let recencyScore = 0
  if (!Number.isNaN(lastSeen)) {
    const ageMs = Math.max(0, now - lastSeen)
    if (ageMs <= MAX_RECENCY_SCORE_MS) {
      recencyScore = 0.2
    } else if (ageMs < MAX_RECENCY_WINDOW_MS) {
      const ratio = 1 - ((ageMs - MAX_RECENCY_SCORE_MS) / (MAX_RECENCY_WINDOW_MS - MAX_RECENCY_SCORE_MS))
      recencyScore = Math.max(0, ratio) * 0.2
    }
  }

  const intentsReceived = stats?.intents_received ?? 0
  const intentsResponded = stats?.intents_responded ?? 0
  const responseRateScore = intentsReceived > 0
    ? Math.min(1, intentsResponded / intentsReceived) * 0.3
    : 0

  const organizationVerifiedScore = organization?.verified === 1 ? 0.3 : 0

  const score = accountAgeScore + recencyScore + responseRateScore + organizationVerifiedScore
  return Math.min(1, Math.round(score * 100) / 100)
}
