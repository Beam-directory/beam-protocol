import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import type {
  AgentBrowseResult,
  AgentRow,
  AgentStats,
  IntentFrame,
  IntentLogRow,
  OrgAgentRow,
  OrgRow,
  RegisterRequest,
  TrustScoreRow,
  VerificationTokenRow,
} from './types.js'

const BEAM_DOMAIN_SUFFIX = 'beam.directory'

export function createDatabase(dbPath = './beam-directory.db'): DB {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

function initSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orgs (
      name TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      domain TEXT,
      beam_domain TEXT NOT NULL UNIQUE,
      api_key_hash TEXT NOT NULL,
      verification_token TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      verified_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orgs_domain ON orgs(domain);
    CREATE INDEX IF NOT EXISTS idx_orgs_verified ON orgs(verified, created_at DESC);

    CREATE TABLE IF NOT EXISTS org_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_name TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      beam_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      public_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (org_name) REFERENCES orgs(name) ON DELETE CASCADE,
      UNIQUE(org_name, agent_name)
    );

    CREATE INDEX IF NOT EXISTS idx_org_agents_org_name ON org_agents(org_name, agent_name);

    CREATE TABLE IF NOT EXISTS agents (
      beam_id TEXT PRIMARY KEY,
      org TEXT,
      display_name TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      public_key TEXT NOT NULL,
      trust_score REAL NOT NULL DEFAULT 0.5,
      verified INTEGER NOT NULL DEFAULT 0,
      email TEXT,
      description TEXT,
      logo_url TEXT,
      website TEXT,
      verification_tier TEXT NOT NULL DEFAULT 'basic' CHECK(verification_tier IN ('basic', 'verified', 'business', 'enterprise')),
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_token TEXT,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org);
    CREATE INDEX IF NOT EXISTS idx_agents_trust ON agents(trust_score DESC);
    CREATE INDEX IF NOT EXISTS idx_agents_verification_tier ON agents(verification_tier, trust_score DESC);
    CREATE INDEX IF NOT EXISTS idx_agents_email_verified ON agents(email_verified, trust_score DESC);

    CREATE TABLE IF NOT EXISTS nonces (
      nonce TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nonces_expires ON nonces(expires_at);

    CREATE TABLE IF NOT EXISTS verification_tokens (
      token TEXT PRIMARY KEY,
      beam_id TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (beam_id) REFERENCES agents(beam_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_verification_tokens_beam_id ON verification_tokens(beam_id);
    CREATE INDEX IF NOT EXISTS idx_verification_tokens_expires_at ON verification_tokens(expires_at);

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

  migrateAgentsSchema(db)
}

function getTableInfo(db: DB, tableName: string): Array<{ name: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; notnull: number }>
}

function hasTable(db: DB, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name: string } | undefined

  return Boolean(row)
}

function hasColumn(db: DB, tableName: string, columnName: string): boolean {
  return getTableInfo(db, tableName).some((column) => column.name === columnName)
}

function migrateAgentsSchema(db: DB): void {
  if (!hasTable(db, 'agents')) {
    return
  }

  const columns = getTableInfo(db, 'agents')
  const orgColumn = columns.find((column) => column.name === 'org')

  if (orgColumn?.notnull === 1) {
    rebuildAgentsTable(db)
  }

  const addColumnStatements = [
    `ALTER TABLE agents ADD COLUMN email TEXT`,
    `ALTER TABLE agents ADD COLUMN description TEXT`,
    `ALTER TABLE agents ADD COLUMN logo_url TEXT`,
    `ALTER TABLE agents ADD COLUMN website TEXT`,
    `ALTER TABLE agents ADD COLUMN verification_tier TEXT NOT NULL DEFAULT 'basic' CHECK(verification_tier IN ('basic', 'verified', 'business', 'enterprise'))`,
    `ALTER TABLE agents ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN email_token TEXT`,
  ]

  for (const statement of addColumnStatements) {
    const columnName = statement.split(' ADD COLUMN ')[1]?.split(' ')[0]
    if (!columnName || hasColumn(db, 'agents', columnName)) {
      continue
    }
    db.exec(statement)
  }

  db.exec(`
    UPDATE agents
    SET verification_tier = 'basic'
    WHERE verification_tier IS NULL OR verification_tier = ''
  `)
}

function rebuildAgentsTable(db: DB): void {
  db.pragma('foreign_keys = OFF')

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE agents__migrated (
        beam_id TEXT PRIMARY KEY,
        org TEXT,
        display_name TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]',
        public_key TEXT NOT NULL,
        trust_score REAL NOT NULL DEFAULT 0.5,
        verified INTEGER NOT NULL DEFAULT 0,
        email TEXT,
        description TEXT,
        logo_url TEXT,
        website TEXT,
        verification_tier TEXT NOT NULL DEFAULT 'basic' CHECK(verification_tier IN ('basic', 'verified', 'business', 'enterprise')),
        email_verified INTEGER NOT NULL DEFAULT 0,
        email_token TEXT,
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );

      INSERT INTO agents__migrated (
        beam_id,
        org,
        display_name,
        capabilities,
        public_key,
        trust_score,
        verified,
        created_at,
        last_seen
      )
      SELECT
        beam_id,
        org,
        display_name,
        capabilities,
        public_key,
        trust_score,
        verified,
        created_at,
        last_seen
      FROM agents;

      DROP TABLE agents;
      ALTER TABLE agents__migrated RENAME TO agents;
      CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org);
      CREATE INDEX IF NOT EXISTS idx_agents_trust ON agents(trust_score DESC);
      CREATE INDEX IF NOT EXISTS idx_agents_verification_tier ON agents(verification_tier, trust_score DESC);
      CREATE INDEX IF NOT EXISTS idx_agents_email_verified ON agents(email_verified, trust_score DESC);
    `)
  })

  try {
    migrate()
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

export function buildBeamDomain(orgName: string): string {
  return `${orgName}.${BEAM_DOMAIN_SUFFIX}`
}

export function createOrg(
  db: DB,
  input: {
    name: string
    displayName: string
    domain?: string | null
    apiKeyHash: string
    verificationToken: string
  }
): OrgRow {
  const now = new Date().toISOString()
  const beamDomain = buildBeamDomain(input.name)

  db.prepare(`
    INSERT INTO orgs (
      name,
      display_name,
      domain,
      beam_domain,
      api_key_hash,
      verification_token,
      verified,
      created_at,
      verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)
  `).run(
    input.name,
    input.displayName,
    input.domain ?? null,
    beamDomain,
    input.apiKeyHash,
    input.verificationToken,
    now
  )

  return getOrg(db, input.name) as OrgRow
}

export function getOrg(db: DB, name: string): OrgRow | null {
  const row = db.prepare('SELECT * FROM orgs WHERE name = ?').get(name) as OrgRow | undefined
  return row ?? null
}

export function listOrgAgents(db: DB, orgName: string): Array<OrgAgentRow & Partial<AgentRow>> {
  return db.prepare(`
    SELECT
      oa.id,
      oa.org_name,
      oa.agent_name,
      oa.beam_id,
      oa.display_name,
      oa.capabilities,
      oa.public_key,
      oa.created_at,
      oa.updated_at,
      a.org,
      a.trust_score,
      a.verified,
      a.last_seen
    FROM org_agents oa
    LEFT JOIN agents a ON a.beam_id = oa.beam_id
    WHERE oa.org_name = ?
    ORDER BY oa.agent_name ASC
  `).all(orgName) as Array<OrgAgentRow & Partial<AgentRow>>
}

export function markOrgVerified(db: DB, name: string): OrgRow | null {
  const now = new Date().toISOString()
  db.prepare('UPDATE orgs SET verified = 1, verified_at = ? WHERE name = ?').run(now, name)
  return getOrg(db, name)
}

function orgExists(db: DB, name: string): boolean {
  const row = db.prepare('SELECT 1 FROM orgs WHERE name = ? LIMIT 1').get(name) as { 1: number } | undefined
  return Boolean(row)
}

function extractAgentName(beamId: string): string {
  return beamId.split('@')[0] ?? beamId
}

function syncOrgAgent(db: DB, data: RegisterRequest, createdAt: string): void {
  if (!data.org) {
    return
  }

  if (!orgExists(db, data.org)) {
    return
  }

  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO org_agents (
      org_name,
      agent_name,
      beam_id,
      display_name,
      capabilities,
      public_key,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_name, agent_name) DO UPDATE SET
      beam_id = excluded.beam_id,
      display_name = excluded.display_name,
      capabilities = excluded.capabilities,
      public_key = excluded.public_key,
      updated_at = excluded.updated_at
  `).run(
    data.org,
    extractAgentName(data.beamId),
    data.beamId,
    data.displayName,
    JSON.stringify(data.capabilities),
    data.publicKey,
    createdAt,
    now
  )
}

/**
 * Insert or update an agent record. Returns the resulting row.
 */
export function registerAgent(db: DB, data: RegisterRequest): AgentRow {
  const now = new Date().toISOString()
  const capabilitiesJson = JSON.stringify(data.capabilities)

  const existing = getAgent(db, data.beamId)
  const normalizedEmail = data.email?.trim().toLowerCase() || null
  const emailChanged = normalizedEmail !== (existing?.email ?? null)
  const emailVerified = normalizedEmail
    ? (emailChanged ? 0 : existing?.email_verified ?? 0)
    : 0
  const verified = normalizedEmail
    ? (emailChanged ? 0 : existing?.verified ?? 0)
    : 0
  const emailToken = emailChanged ? null : existing?.email_token ?? null

  if (existing) {
    db.prepare(`
      UPDATE agents
      SET org = ?,
          display_name = ?,
          capabilities = ?,
          public_key = ?,
          email = ?,
          email_verified = ?,
          email_token = ?,
          verified = ?,
          last_seen = ?
      WHERE beam_id = ?
    `).run(
      data.org ?? null,
      data.displayName,
      capabilitiesJson,
      data.publicKey,
      normalizedEmail,
      emailVerified,
      emailToken,
      verified,
      now,
      data.beamId
    )
  } else {
    db.prepare(`
      INSERT INTO agents (
        beam_id,
        org,
        display_name,
        capabilities,
        public_key,
        trust_score,
        verified,
        email,
        email_verified,
        email_token,
        created_at,
        last_seen
      )
      VALUES (?, ?, ?, ?, ?, 0.3, ?, ?, ?, ?, ?, ?)
    `).run(
      data.beamId,
      data.org ?? null,
      data.displayName,
      capabilitiesJson,
      data.publicKey,
      verified,
      normalizedEmail,
      emailVerified,
      emailToken,
      now,
      now
    )
  }

  syncOrgAgent(db, data, existing?.created_at ?? now)

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

export function setAgentEmailToken(db: DB, beamId: string, token: string | null): void {
  db.prepare('UPDATE agents SET email_token = ? WHERE beam_id = ?').run(token, beamId)
}

export function createVerificationToken(
  db: DB,
  input: Omit<VerificationTokenRow, 'created_at'> & { created_at?: number }
): VerificationTokenRow {
  const createdAt = input.created_at ?? Date.now()

  db.prepare('DELETE FROM verification_tokens WHERE beam_id = ? OR email = ?').run(input.beam_id, input.email)
  db.prepare(`
    INSERT INTO verification_tokens (token, beam_id, email, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.token, input.beam_id, input.email, createdAt, input.expires_at)

  return {
    token: input.token,
    beam_id: input.beam_id,
    email: input.email,
    created_at: createdAt,
    expires_at: input.expires_at,
  }
}

export function getVerificationToken(db: DB, token: string): VerificationTokenRow | null {
  const row = db.prepare(`
    SELECT token, beam_id, email, created_at, expires_at
    FROM verification_tokens
    WHERE token = ?
  `).get(token) as VerificationTokenRow | undefined

  return row ?? null
}

export function deleteVerificationToken(db: DB, token: string): void {
  db.prepare('DELETE FROM verification_tokens WHERE token = ?').run(token)
}

export function markAgentEmailVerified(db: DB, beamId: string, email: string): AgentRow | null {
  db.prepare(`
    UPDATE agents
    SET email = ?,
        email_verified = 1,
        email_token = NULL,
        verified = 1
    WHERE beam_id = ?
  `).run(email, beamId)

  db.prepare('DELETE FROM verification_tokens WHERE beam_id = ?').run(beamId)

  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)

  return getAgent(db, beamId)
}

export function updateAgentProfile(
  db: DB,
  beamId: string,
  profile: {
    description?: string | null
    logo_url?: string | null
    website?: string | null
  }
): AgentRow | null {
  const assignments: string[] = []
  const values: Array<string | null> = []

  for (const key of ['description', 'logo_url', 'website'] as const) {
    if (!(key in profile)) {
      continue
    }
    assignments.push(`${key} = ?`)
    values.push(profile[key] ?? null)
  }

  if (assignments.length === 0) {
    return getAgent(db, beamId)
  }

  db.prepare(`
    UPDATE agents
    SET ${assignments.join(', ')}
    WHERE beam_id = ?
  `).run(...values, beamId)

  return getAgent(db, beamId)
}

export function browseAgents(
  db: DB,
  query: {
    capability?: string[]
    verificationTier?: AgentRow['verification_tier']
    verifiedOnly?: boolean
    page?: number
    limit?: number
  }
): AgentBrowseResult {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (query.verificationTier) {
    conditions.push('verification_tier = ?')
    params.push(query.verificationTier)
  }

  if (query.verifiedOnly) {
    conditions.push('email_verified = 1')
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const allRows = db.prepare(`
    SELECT *
    FROM agents
    ${where}
    ORDER BY trust_score DESC, created_at DESC
  `).all(...params) as AgentRow[]

  const requiredCapabilities = query.capability?.filter(Boolean) ?? []
  const filteredRows = requiredCapabilities.length === 0
    ? allRows
    : allRows.filter((row) => {
      try {
        const parsed = JSON.parse(row.capabilities) as unknown
        if (!Array.isArray(parsed)) {
          return false
        }
        const capabilities = new Set(parsed.filter((value): value is string => typeof value === 'string'))
        return requiredCapabilities.every((capability) => capabilities.has(capability))
      } catch {
        return false
      }
    })

  const page = Math.max(1, Math.trunc(query.page ?? 1) || 1)
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit ?? 20) || 20))
  const offset = (page - 1) * limit

  return {
    rows: filteredRows.slice(offset, offset + limit),
    total: filteredRows.length,
    page,
    limit,
  }
}

export function getAgentStats(db: DB): AgentStats {
  const agentCounts = db.prepare(`
    SELECT
      COUNT(*) AS total_agents,
      SUM(CASE WHEN email_verified = 1 THEN 1 ELSE 0 END) AS verified_agents
    FROM agents
  `).get() as { total_agents: number; verified_agents: number | null }

  const intentCounts = db.prepare(`
    SELECT
      COUNT(*) AS total_intents,
      AVG(round_trip_latency_ms) AS avg_response_ms
    FROM intent_log
  `).get() as { total_intents: number; avg_response_ms: number | null }

  return {
    total_agents: agentCounts.total_agents ?? 0,
    verified_agents: agentCounts.verified_agents ?? 0,
    total_intents: intentCounts.total_intents ?? 0,
    avg_response_ms: intentCounts.avg_response_ms === null ? 0 : Math.round(intentCounts.avg_response_ms),
  }
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
