import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import type {
  AgentRow,
  AuditLogRow,
  DirectoryRoleRow,
  DnsCacheRow,
  FederatedAgentRow,
  FederatedTrustRow,
  IntentFrame,
  IntentLogRow,
  OrgAgentRow,
  OrgRow,
  RegisterRequest,
  TrustScoreRow,
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

    CREATE TABLE IF NOT EXISTS federation_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      directory_url TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      trust_level REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_seen TEXT,
      synced_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_federation_peers_status
      ON federation_peers(status, trust_level DESC);

    CREATE TABLE IF NOT EXISTS federated_agents (
      beam_id TEXT PRIMARY KEY,
      home_directory_url TEXT NOT NULL,
      cached_document TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      ttl INTEGER NOT NULL DEFAULT 300
    );

    CREATE INDEX IF NOT EXISTS idx_federated_agents_home
      ON federated_agents(home_directory_url, cached_at DESC);

    CREATE TABLE IF NOT EXISTS directory_roles (
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')),
      directory_url TEXT NOT NULL,
      PRIMARY KEY (user_id, directory_url)
    );

    CREATE INDEX IF NOT EXISTS idx_directory_roles_role
      ON directory_roles(role, directory_url);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      target TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp
      ON audit_log(timestamp DESC);

    CREATE TABLE IF NOT EXISTS dns_cache (
      cache_key TEXT PRIMARY KEY,
      record_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      cached_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dns_cache_expires
      ON dns_cache(expires_at);

    CREATE TABLE IF NOT EXISTS federated_trust (
      beam_id TEXT NOT NULL,
      source_directory_url TEXT NOT NULL,
      origin_directory_url TEXT NOT NULL,
      asserted_trust REAL NOT NULL,
      effective_trust REAL NOT NULL,
      hop_count INTEGER NOT NULL DEFAULT 1,
      asserted_at TEXT NOT NULL,
      PRIMARY KEY (beam_id, source_directory_url, origin_directory_url)
    );

    CREATE INDEX IF NOT EXISTS idx_federated_trust_lookup
      ON federated_trust(beam_id, asserted_at DESC, effective_trust DESC);
  `)
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

export function upsertFederatedAgentCache(
  db: DB,
  input: {
    beamId: string
    homeDirectoryUrl: string
    document: object
    cachedAt?: string
    ttl?: number
  }
): FederatedAgentRow {
  const cachedAt = input.cachedAt ?? new Date().toISOString()
  const ttl = Math.max(1, Math.trunc(input.ttl ?? 300))

  db.prepare(`
    INSERT INTO federated_agents (beam_id, home_directory_url, cached_document, cached_at, ttl)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(beam_id) DO UPDATE SET
      home_directory_url = excluded.home_directory_url,
      cached_document = excluded.cached_document,
      cached_at = excluded.cached_at,
      ttl = excluded.ttl
  `).run(
    input.beamId,
    input.homeDirectoryUrl,
    JSON.stringify(input.document),
    cachedAt,
    ttl
  )

  return db.prepare('SELECT * FROM federated_agents WHERE beam_id = ?').get(input.beamId) as FederatedAgentRow
}

export function getFederatedAgentCache(db: DB, beamId: string): FederatedAgentRow | null {
  const row = db.prepare('SELECT * FROM federated_agents WHERE beam_id = ?').get(beamId) as FederatedAgentRow | undefined
  return row ?? null
}

export function deleteFederatedAgentCache(db: DB, beamId: string): void {
  db.prepare('DELETE FROM federated_agents WHERE beam_id = ?').run(beamId)
}

export function assignDirectoryRole(
  db: DB,
  input: { userId: string; role: DirectoryRoleRow['role']; directoryUrl: string }
): DirectoryRoleRow {
  db.prepare(`
    INSERT INTO directory_roles (user_id, role, directory_url)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, directory_url) DO UPDATE SET
      role = excluded.role
  `).run(input.userId, input.role, input.directoryUrl)

  return db.prepare(`
    SELECT * FROM directory_roles
    WHERE user_id = ? AND directory_url = ?
  `).get(input.userId, input.directoryUrl) as DirectoryRoleRow
}

export function getDirectoryRole(db: DB, userId: string, directoryUrl: string): DirectoryRoleRow | null {
  const row = db.prepare(`
    SELECT * FROM directory_roles
    WHERE user_id = ? AND directory_url = ?
  `).get(userId, directoryUrl) as DirectoryRoleRow | undefined

  return row ?? null
}

export function logAuditEvent(
  db: DB,
  input: { action: string; actor: string; target: string; details?: unknown; timestamp?: string }
): AuditLogRow {
  const timestamp = input.timestamp ?? new Date().toISOString()
  const details = input.details === undefined ? null : JSON.stringify(input.details)

  const result = db.prepare(`
    INSERT INTO audit_log (action, actor, target, timestamp, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.action, input.actor, input.target, timestamp, details)

  return db.prepare('SELECT * FROM audit_log WHERE id = ?').get(Number(result.lastInsertRowid)) as AuditLogRow
}

export function listAuditLog(
  db: DB,
  query: { limit?: number; action?: string; actor?: string; target?: string } = {}
): AuditLogRow[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)))
  const conditions: string[] = []
  const params: string[] = []

  if (query.action) {
    conditions.push('action = ?')
    params.push(query.action)
  }

  if (query.actor) {
    conditions.push('actor = ?')
    params.push(query.actor)
  }

  if (query.target) {
    conditions.push('target = ?')
    params.push(query.target)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return db.prepare(`
    SELECT *
    FROM audit_log
    ${where}
    ORDER BY timestamp DESC, id DESC
    LIMIT ${limit}
  `).all(...params) as AuditLogRow[]
}

export function getDnsCache(db: DB, cacheKey: string, recordType: string): DnsCacheRow | null {
  const row = db.prepare(`
    SELECT *
    FROM dns_cache
    WHERE cache_key = ? AND record_type = ? AND expires_at > ?
  `).get(cacheKey, recordType, Date.now()) as DnsCacheRow | undefined

  return row ?? null
}

export function setDnsCache(
  db: DB,
  input: { cacheKey: string; recordType: string; payload: unknown; ttlSeconds: number }
): DnsCacheRow {
  const cachedAt = new Date().toISOString()
  const ttlSeconds = Math.max(1, Math.trunc(input.ttlSeconds))
  const expiresAt = Date.now() + ttlSeconds * 1000

  db.prepare(`
    INSERT INTO dns_cache (cache_key, record_type, payload, expires_at, cached_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      record_type = excluded.record_type,
      payload = excluded.payload,
      expires_at = excluded.expires_at,
      cached_at = excluded.cached_at
  `).run(input.cacheKey, input.recordType, JSON.stringify(input.payload), expiresAt, cachedAt)

  return db.prepare('SELECT * FROM dns_cache WHERE cache_key = ?').get(input.cacheKey) as DnsCacheRow
}

export function cleanExpiredDnsCache(db: DB): void {
  db.prepare('DELETE FROM dns_cache WHERE expires_at <= ?').run(Date.now())
}

export function upsertFederatedTrust(
  db: DB,
  input: {
    beamId: string
    sourceDirectoryUrl: string
    originDirectoryUrl: string
    assertedTrust: number
    effectiveTrust: number
    hopCount: number
    assertedAt?: string
  }
): FederatedTrustRow {
  const assertedAt = input.assertedAt ?? new Date().toISOString()

  db.prepare(`
    INSERT INTO federated_trust (
      beam_id,
      source_directory_url,
      origin_directory_url,
      asserted_trust,
      effective_trust,
      hop_count,
      asserted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(beam_id, source_directory_url, origin_directory_url) DO UPDATE SET
      asserted_trust = excluded.asserted_trust,
      effective_trust = excluded.effective_trust,
      hop_count = excluded.hop_count,
      asserted_at = excluded.asserted_at
  `).run(
    input.beamId,
    input.sourceDirectoryUrl,
    input.originDirectoryUrl,
    input.assertedTrust,
    input.effectiveTrust,
    input.hopCount,
    assertedAt
  )

  return db.prepare(`
    SELECT *
    FROM federated_trust
    WHERE beam_id = ? AND source_directory_url = ? AND origin_directory_url = ?
  `).get(input.beamId, input.sourceDirectoryUrl, input.originDirectoryUrl) as FederatedTrustRow
}

export function listFederatedTrust(db: DB, beamId?: string): FederatedTrustRow[] {
  if (beamId) {
    return db.prepare(`
      SELECT *
      FROM federated_trust
      WHERE beam_id = ?
      ORDER BY asserted_at DESC, effective_trust DESC
    `).all(beamId) as FederatedTrustRow[]
  }

  return db.prepare(`
    SELECT *
    FROM federated_trust
    ORDER BY asserted_at DESC, effective_trust DESC
  `).all() as FederatedTrustRow[]
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
