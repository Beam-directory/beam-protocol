import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import type { AgentRow, IntentFrame, IntentLogRow, RegisterRequest, TrustScoreRow } from './types.js'

export function createDatabase(dbPath = './beam-directory.db'): DB {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

function initSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      beam_id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      display_name TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      public_key TEXT NOT NULL,
      trust_score REAL NOT NULL DEFAULT 0.5,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org);
    CREATE INDEX IF NOT EXISTS idx_agents_trust ON agents(trust_score DESC);

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

    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      source TEXT,
      company TEXT,
      agent_count INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_waitlist_created_at
      ON waitlist(created_at DESC);
    CREATE TABLE IF NOT EXISTS intent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nonce TEXT NOT NULL UNIQUE,
      from_beam_id TEXT NOT NULL,
      to_beam_id TEXT NOT NULL,
      intent_type TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      completed_at TEXT,
      round_trip_latency_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      error_code TEXT,
      FOREIGN KEY (from_beam_id) REFERENCES agents(beam_id),
      FOREIGN KEY (to_beam_id) REFERENCES agents(beam_id)
    );

    CREATE INDEX IF NOT EXISTS idx_intent_log_requested_at
      ON intent_log(requested_at DESC);

    CREATE INDEX IF NOT EXISTS idx_intent_log_from_to
      ON intent_log(from_beam_id, to_beam_id);

    CREATE TABLE IF NOT EXISTS trust_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_beam_id TEXT NOT NULL,
      target_beam_id TEXT NOT NULL,
      score REAL NOT NULL,
      last_updated TEXT NOT NULL,
      FOREIGN KEY (source_beam_id) REFERENCES agents(beam_id),
      FOREIGN KEY (target_beam_id) REFERENCES agents(beam_id),
      UNIQUE(source_beam_id, target_beam_id)
    );

    CREATE INDEX IF NOT EXISTS idx_trust_scores_updated
      ON trust_scores(last_updated DESC);
  `)
}

/**
 * Insert or update an agent record. Returns the resulting row.
 */
export function registerAgent(db: DB, data: RegisterRequest): AgentRow {
  const now = new Date().toISOString()
  const capabilitiesJson = JSON.stringify(data.capabilities)

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
      VALUES (?, ?, ?, ?, ?, 0.3, 0, ?, ?)
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

  // Recompute trust score after upsert
  const score = calculateTrustScore(db, data.beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, data.beamId)

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

  // Filter by capabilities in JS (safe JSON array intersection)
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

  // Recompute trust score since activity affects it
  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)
}

/**
 * Record a nonce to prevent replay attacks.
 * Returns false if the nonce has already been seen (replay detected).
 * Nonces expire after 5 minutes.
 */
export function recordNonce(db: DB, nonce: string): boolean {
  const expiresAt = Date.now() + 5 * 60 * 1000  // 5 minutes

  try {
    db.prepare('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt)
    return true
  } catch {
    // INSERT failed — nonce already exists (UNIQUE constraint violation)
    return false
  }
}

/**
 * Remove all expired nonces from the database.
 */
export function cleanExpiredNonces(db: DB): void {
  db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(Date.now())
}

/**
 * Calculate trust score for an agent based on verified status, recent activity,
 * and account age.
 *
 * Formula:
 *   base     = 0.3  (all registered agents)
 *   +0.3     if verified
 *   +0.2     if last_seen within 24h
 *   +0.2     if account older than 7 days
 *   max      = 1.0
 */
export function calculateTrustScore(db: DB, beamId: string): number {
  const row = getAgent(db, beamId)
  if (!row) return 0.0

  let score = 0.3

  if (row.verified === 1) {
    score += 0.3
  }

  const lastSeen = new Date(row.last_seen).getTime()
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
  if (lastSeen >= oneDayAgo) {
    score += 0.2
  }

  const createdAt = new Date(row.created_at).getTime()
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  if (createdAt <= sevenDaysAgo) {
    score += 0.2
  }

  return Math.min(1.0, Math.round(score * 100) / 100)
}

export function logIntentStart(db: DB, frame: IntentFrame): void {
  db.prepare(`
    INSERT INTO intent_log (
      nonce,
      from_beam_id,
      to_beam_id,
      intent_type,
      requested_at,
      status
    ) VALUES (?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(nonce) DO UPDATE SET
      from_beam_id = excluded.from_beam_id,
      to_beam_id = excluded.to_beam_id,
      intent_type = excluded.intent_type,
      requested_at = excluded.requested_at,
      status = 'pending',
      completed_at = NULL,
      round_trip_latency_ms = NULL,
      error_code = NULL
  `).run(
    frame.nonce,
    frame.from,
    frame.to,
    frame.intent,
    frame.timestamp
  )
}

export function finalizeIntentLog(
  db: DB,
  input: {
    nonce: string
    fromBeamId: string
    toBeamId: string
    success: boolean
    latencyMs: number | null
    errorCode?: string
  }
): void {
  const completedAt = new Date().toISOString()
  const status = input.success ? 'success' : 'error'

  db.prepare(`
    UPDATE intent_log
    SET completed_at = ?,
        round_trip_latency_ms = ?,
        status = ?,
        error_code = ?
    WHERE nonce = ?
  `).run(
    completedAt,
    input.latencyMs,
    status,
    input.errorCode ?? null,
    input.nonce
  )

  updatePairTrustScore(db, input)
}

export function listRecentIntentLogs(db: DB, limit = 50): IntentLogRow[] {
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 50))
  return db.prepare(`
    SELECT *
    FROM intent_log
    ORDER BY requested_at DESC
    LIMIT ?
  `).all(safeLimit) as IntentLogRow[]
}

export function listTrustScores(db: DB): TrustScoreRow[] {
  return db.prepare(`
    SELECT *
    FROM trust_scores
    ORDER BY last_updated DESC, score DESC
  `).all() as TrustScoreRow[]
}

function updatePairTrustScore(
  db: DB,
  input: {
    fromBeamId: string
    toBeamId: string
    success: boolean
    latencyMs: number | null
    errorCode?: string
  }
): void {
  const sender = getAgent(db, input.fromBeamId)
  const recipient = getAgent(db, input.toBeamId)
  const existing = db.prepare(`
    SELECT score
    FROM trust_scores
    WHERE source_beam_id = ? AND target_beam_id = ?
  `).get(input.fromBeamId, input.toBeamId) as { score: number } | undefined

  const base = ((sender?.trust_score ?? 0.5) + (recipient?.trust_score ?? 0.5)) / 2
  const latencyPenalty = input.latencyMs === null ? 0 : Math.min(input.latencyMs, 60_000) / 60_000 * 0.15
  const signal = input.success
    ? Math.max(0.55, 0.95 - latencyPenalty)
    : input.errorCode === 'OFFLINE' || input.errorCode === 'TIMEOUT'
      ? 0.3
      : 0.15
  const targetScore = clampScore(base * 0.6 + signal * 0.4)
  const nextScore = clampScore((existing?.score ?? base) * 0.7 + targetScore * 0.3)
  const lastUpdated = new Date().toISOString()

  db.prepare(`
    INSERT INTO trust_scores (source_beam_id, target_beam_id, score, last_updated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source_beam_id, target_beam_id) DO UPDATE SET
      score = excluded.score,
      last_updated = excluded.last_updated
  `).run(input.fromBeamId, input.toBeamId, nextScore, lastUpdated)
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100))
}
