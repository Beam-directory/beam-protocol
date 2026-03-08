import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import type {
  AgentKeyRow,
  AgentRow,
  DelegationRow,
  DomainVerificationRow,
  IntentFrame,
  IntentLogRow,
  OrgAgentRow,
  OrgRow,
  RegisterRequest,
  ReportRow,
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

    CREATE TABLE IF NOT EXISTS domain_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beam_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      challenge_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (beam_id) REFERENCES agents(beam_id)
    );

    CREATE INDEX IF NOT EXISTS idx_domain_verifications_beam
      ON domain_verifications(beam_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_domain_verifications_status
      ON domain_verifications(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_keys (
      id INTEGER PRIMARY KEY,
      beam_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (beam_id) REFERENCES agents(beam_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_keys_unique
      ON agent_keys(beam_id, public_key);
    CREATE INDEX IF NOT EXISTS idx_agent_keys_beam_revoked
      ON agent_keys(beam_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_agent_keys_revoked
      ON agent_keys(revoked_at DESC);

    CREATE TABLE IF NOT EXISTS delegations (
      id INTEGER PRIMARY KEY,
      grantor_beam_id TEXT NOT NULL,
      grantee_beam_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (grantor_beam_id) REFERENCES agents(beam_id),
      FOREIGN KEY (grantee_beam_id) REFERENCES agents(beam_id)
    );

    CREATE INDEX IF NOT EXISTS idx_delegations_grantor
      ON delegations(grantor_beam_id, revoked, expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_delegations_grantee
      ON delegations(grantee_beam_id, revoked, expires_at DESC);

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY,
      reporter_beam_id TEXT NOT NULL,
      target_beam_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY (reporter_beam_id) REFERENCES agents(beam_id),
      FOREIGN KEY (target_beam_id) REFERENCES agents(beam_id),
      UNIQUE(reporter_beam_id, target_beam_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reports_target_status
      ON reports(target_beam_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_reporter_target
      ON reports(reporter_beam_id, target_beam_id);
  `)

  ensureColumn(db, 'agents', 'verification_tier', "TEXT NOT NULL DEFAULT 'unverified'")
  ensureColumn(db, 'agents', 'flagged', 'INTEGER NOT NULL DEFAULT 0')

  db.prepare(`
    UPDATE agents
    SET verification_tier = CASE
      WHEN verification_tier IS NULL OR verification_tier = '' THEN 'unverified'
      ELSE verification_tier
    END
  `).run()

  const backfillKeysCreatedAt = Date.now()
  db.prepare(`
    INSERT OR IGNORE INTO agent_keys (beam_id, public_key, created_at, revoked_at)
    SELECT beam_id, public_key, ?, NULL
    FROM agents
  `).run(backfillKeysCreatedAt)
}

function ensureColumn(db: DB, tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  if (columns.some((column) => column.name === columnName)) {
    return
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}

function nowIso(): string {
  return new Date().toISOString()
}

function nowMs(): number {
  return Date.now()
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
  const now = nowIso()
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
    now,
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
      a.verification_tier,
      a.flagged,
      a.last_seen
    FROM org_agents oa
    LEFT JOIN agents a ON a.beam_id = oa.beam_id
    WHERE oa.org_name = ?
    ORDER BY oa.agent_name ASC
  `).all(orgName) as Array<OrgAgentRow & Partial<AgentRow>>
}

export function markOrgVerified(db: DB, name: string): OrgRow | null {
  const now = nowIso()
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

  const now = nowIso()
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
    now,
  )
}

function syncOrgAgentPublicKey(db: DB, beamId: string, publicKey: string): void {
  db.prepare(`
    UPDATE org_agents
    SET public_key = ?, updated_at = ?
    WHERE beam_id = ?
  `).run(publicKey, nowIso(), beamId)
}

function ensureAgentKeyRecorded(db: DB, beamId: string, publicKey: string, createdAt: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO agent_keys (beam_id, public_key, created_at, revoked_at)
    VALUES (?, ?, ?, NULL)
  `).run(beamId, publicKey, createdAt)
}

export function registerAgent(db: DB, data: RegisterRequest): AgentRow {
  const now = nowIso()
  const createdAtMs = nowMs()
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
      data.beamId,
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
        verification_tier,
        flagged,
        created_at,
        last_seen
      )
      VALUES (?, ?, ?, ?, ?, 0.3, 0, 'unverified', 0, ?, ?)
    `).run(
      data.beamId,
      data.org,
      data.displayName,
      capabilitiesJson,
      data.publicKey,
      now,
      now,
    )
  }

  syncOrgAgent(db, data, existing?.created_at ?? now)
  ensureAgentKeyRecorded(db, data.beamId, data.publicKey, createdAtMs)

  const score = calculateTrustScore(db, data.beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, data.beamId)

  return getAgent(db, data.beamId) as AgentRow
}

export function getAgent(db: DB, beamId: string): AgentRow | null {
  const row = db.prepare('SELECT * FROM agents WHERE beam_id = ?').get(beamId) as AgentRow | undefined
  return row ?? null
}

export function searchAgents(
  db: DB,
  query: {
    org?: string
    capabilities?: string[]
    minTrustScore?: number
    limit?: number
  },
): AgentRow[] {
  const params: Array<string | number> = []
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
      for (const capability of required) {
        if (!agentCaps.has(capability)) return false
      }
      return true
    })
  }

  return rows
}

export function updateLastSeen(db: DB, beamId: string): void {
  const now = nowIso()
  db.prepare('UPDATE agents SET last_seen = ? WHERE beam_id = ?').run(now, beamId)

  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)
}

export function recordNonce(db: DB, nonce: string): boolean {
  const expiresAt = Date.now() + 5 * 60 * 1000

  try {
    db.prepare('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt)
    return true
  } catch {
    return false
  }
}

export function cleanExpiredNonces(db: DB): void {
  db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(Date.now())
}

export function calculateTrustScore(db: DB, beamId: string): number {
  const row = getAgent(db, beamId)
  if (!row) return 0.0
  if (row.flagged === 1) return 0.0

  let score = 0.3

  if (row.verified === 1) {
    score += 0.3
  }

  if (row.verification_tier === 'verified') {
    score += 0.2
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

  return clampScore(score)
}

export function createDomainVerification(
  db: DB,
  input: { beamId: string; domain: string; challengeToken: string },
): DomainVerificationRow {
  const createdAt = nowMs()

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE domain_verifications
      SET status = 'superseded'
      WHERE beam_id = ? AND domain = ? AND status = 'pending'
    `).run(input.beamId, input.domain)

    const result = db.prepare(`
      INSERT INTO domain_verifications (beam_id, domain, challenge_token, status, created_at)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(input.beamId, input.domain, input.challengeToken, createdAt)

    return result.lastInsertRowid
  })

  const id = Number(transaction())
  return db.prepare('SELECT * FROM domain_verifications WHERE id = ?').get(id) as DomainVerificationRow
}

export function getLatestDomainVerification(db: DB, beamId: string): DomainVerificationRow | null {
  const row = db.prepare(`
    SELECT *
    FROM domain_verifications
    WHERE beam_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(beamId) as DomainVerificationRow | undefined

  return row ?? null
}

export function updateDomainVerificationStatus(db: DB, id: number, status: string): DomainVerificationRow | null {
  db.prepare('UPDATE domain_verifications SET status = ? WHERE id = ?').run(status, id)
  const row = db.prepare('SELECT * FROM domain_verifications WHERE id = ?').get(id) as DomainVerificationRow | undefined
  return row ?? null
}

export function markAgentDomainVerified(db: DB, beamId: string): AgentRow | null {
  db.prepare(`
    UPDATE agents
    SET verification_tier = 'verified',
        flagged = 0
    WHERE beam_id = ?
  `).run(beamId)

  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)
  return getAgent(db, beamId)
}

export function rotateAgentKey(db: DB, beamId: string, newPublicKey: string): AgentRow | null {
  const existing = getAgent(db, beamId)
  if (!existing) {
    return null
  }

  const revokedAt = nowMs()
  const transaction = db.transaction(() => {
    db.prepare('UPDATE agents SET public_key = ? WHERE beam_id = ?').run(newPublicKey, beamId)
    db.prepare(`
      UPDATE agent_keys
      SET revoked_at = ?
      WHERE beam_id = ? AND public_key = ? AND revoked_at IS NULL
    `).run(revokedAt, beamId, existing.public_key)
    db.prepare(`
      INSERT OR IGNORE INTO agent_keys (beam_id, public_key, created_at, revoked_at)
      VALUES (?, ?, ?, NULL)
    `).run(beamId, newPublicKey, revokedAt)
    syncOrgAgentPublicKey(db, beamId, newPublicKey)
  })

  transaction()
  return getAgent(db, beamId)
}

export function listRevokedAgentKeys(db: DB): AgentKeyRow[] {
  return db.prepare(`
    SELECT *
    FROM agent_keys
    WHERE revoked_at IS NOT NULL
    ORDER BY revoked_at DESC, id DESC
  `).all() as AgentKeyRow[]
}

export function createDelegation(
  db: DB,
  input: { grantorBeamId: string; granteeBeamId: string; scope: string; expiresAt: number },
): DelegationRow {
  const createdAt = nowMs()
  const result = db.prepare(`
    INSERT INTO delegations (grantor_beam_id, grantee_beam_id, scope, created_at, expires_at, revoked)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(input.grantorBeamId, input.granteeBeamId, input.scope, createdAt, input.expiresAt)

  return db.prepare('SELECT * FROM delegations WHERE id = ?').get(Number(result.lastInsertRowid)) as DelegationRow
}

export function listActiveDelegations(db: DB, beamId: string, currentTime = nowMs()): DelegationRow[] {
  return db.prepare(`
    SELECT *
    FROM delegations
    WHERE grantor_beam_id = ?
      AND revoked = 0
      AND expires_at > ?
    ORDER BY created_at DESC, id DESC
  `).all(beamId, currentTime) as DelegationRow[]
}

export function revokeDelegation(db: DB, grantorBeamId: string, id: number): boolean {
  const result = db.prepare(`
    UPDATE delegations
    SET revoked = 1
    WHERE id = ? AND grantor_beam_id = ? AND revoked = 0
  `).run(id, grantorBeamId)

  return result.changes > 0
}

export function hasActiveDelegation(
  db: DB,
  input: { grantorBeamId: string; granteeBeamId: string; scope: string; currentTime?: number },
): boolean {
  const row = db.prepare(`
    SELECT id
    FROM delegations
    WHERE grantor_beam_id = ?
      AND grantee_beam_id = ?
      AND revoked = 0
      AND expires_at > ?
      AND (scope = '*' OR scope = ?)
    LIMIT 1
  `).get(
    input.grantorBeamId,
    input.granteeBeamId,
    input.currentTime ?? nowMs(),
    input.scope,
  ) as { id: number } | undefined

  return Boolean(row)
}

export function createReport(
  db: DB,
  input: { reporterBeamId: string; targetBeamId: string; reason: string },
): ReportRow {
  const createdAt = nowMs()

  const transaction = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO reports (reporter_beam_id, target_beam_id, reason, created_at, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(input.reporterBeamId, input.targetBeamId, input.reason, createdAt)

    const pendingCount = getPendingReportCount(db, input.targetBeamId)
    if (pendingCount >= 5) {
      db.prepare(`
        UPDATE agents
        SET flagged = 1,
            trust_score = 0.0
        WHERE beam_id = ?
      `).run(input.targetBeamId)
    }

    return result.lastInsertRowid
  })

  const id = Number(transaction())
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow
}

export function getPendingReportCount(db: DB, targetBeamId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM reports
    WHERE target_beam_id = ? AND status = 'pending'
  `).get(targetBeamId) as { count: number } | undefined

  return row?.count ?? 0
}

export function listReportsForTarget(db: DB, targetBeamId: string): ReportRow[] {
  return db.prepare(`
    SELECT *
    FROM reports
    WHERE target_beam_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(targetBeamId) as ReportRow[]
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
    frame.timestamp,
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
  },
): void {
  const completedAt = nowIso()
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
    input.nonce,
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
  },
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
  const lastUpdated = nowIso()

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
