import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import type {
  AgentIntentStats,
  AgentKeyRow,
  AgentRow,
  AuditLogRow,
  BusinessVerificationRow,
  DelegationRow,
  DomainVerificationRow,
  DirectoryRoleRow,
  DnsCacheRow,
  FederatedAgentRow,
  FederatedTrustRow,
  IntentFrame,
  IntentLogRow,
  OrgAgentRow,
  OrgRow,
  ReportRow,
  RegisterRequest,
  TrustScoreRow,
  VerificationTier,
} from './types.js'
import { generateDIDDocument, type DIDDocument } from './did.js'

const BEAM_DOMAIN_SUFFIX = 'beam.directory'

export function createDatabase(dbPath = process.env.DB_PATH || './beam-directory.db'): DB {
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
      personal INTEGER NOT NULL DEFAULT 0,
      display_name TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      public_key TEXT NOT NULL,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      logo_url TEXT,
      trust_score REAL NOT NULL DEFAULT 0.5,
      verified INTEGER NOT NULL DEFAULT 0,
      verification_tier TEXT NOT NULL DEFAULT 'basic' CHECK(verification_tier IN ('basic', 'verified', 'business', 'enterprise')),
      email_token TEXT,
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org);
    CREATE INDEX IF NOT EXISTS idx_agents_trust ON agents(trust_score DESC);
    CREATE INDEX IF NOT EXISTS idx_agents_email_verified ON agents(email_verified, trust_score DESC);

    CREATE TABLE IF NOT EXISTS did_documents (
      did TEXT PRIMARY KEY,
      document TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_did_documents_updated_at
      ON did_documents(updated_at DESC);

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

    CREATE TABLE IF NOT EXISTS agent_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beam_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      UNIQUE(beam_id, public_key)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_keys_beam_id ON agent_keys(beam_id);

    CREATE TABLE IF NOT EXISTS domain_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beam_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      challenge_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      verified_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_domain_verifications_beam_id ON domain_verifications(beam_id);

    CREATE TABLE IF NOT EXISTS business_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beam_id TEXT NOT NULL,
      country TEXT NOT NULL,
      registration_number TEXT NOT NULL,
      legal_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      verification_source TEXT,
      source_reference TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL,
      verified_at TEXT,
      FOREIGN KEY (beam_id) REFERENCES agents(beam_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_business_verifications_beam_id
      ON business_verifications(beam_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grantor_beam_id TEXT NOT NULL,
      grantee_beam_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_delegations_grantor ON delegations(grantor_beam_id);
    CREATE INDEX IF NOT EXISTS idx_delegations_grantee ON delegations(grantee_beam_id);

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_beam_id TEXT NOT NULL,
      target_beam_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );

    CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_beam_id);
  `)

  ensureColumn(db, 'agents', 'email', 'TEXT')
  ensureColumn(db, 'agents', 'email_verified', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'agents', 'description', 'TEXT')
  ensureColumn(db, 'agents', 'logo_url', 'TEXT')
  ensureColumn(db, 'agents', 'email_token', 'TEXT')
  ensureColumn(db, 'agents', 'verification_tier', "TEXT NOT NULL DEFAULT 'basic'")
  ensureColumn(db, 'agents', 'flagged', 'INTEGER NOT NULL DEFAULT 0')

  // Create indexes that depend on ensureColumn'd columns
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_verification_tier ON agents(verification_tier, trust_score DESC)`)
  ensureColumn(db, 'agents', 'personal', 'INTEGER NOT NULL DEFAULT 0')

  db.prepare(`
    UPDATE agents
    SET verification_tier = CASE
      WHEN verification_tier IS NULL OR verification_tier = '' OR verification_tier = 'unverified' THEN 'basic'
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
  if (!data.org || data.personal) {
    return
  }

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
  const personal = data.personal === true ? 1 : 0

  const existing = getAgent(db, data.beamId)
  const normalizedEmail = data.email?.trim().toLowerCase() || null
  const emailChanged = normalizedEmail !== (existing?.email ?? null)
  const emailVerified = normalizedEmail
    ? (data.emailVerified ? 1 : emailChanged ? 0 : existing?.email_verified ?? 0)
    : 0
  const verificationTier: VerificationTier = data.verificationTier ?? (emailVerified === 1 ? 'verified' : 'basic')
  const verified = verificationTier !== 'basic' || emailVerified === 1 ? 1 : 0
  const emailToken = normalizedEmail ? (emailChanged ? null : existing?.email_token ?? null) : null

  if (existing) {
    db.prepare(`
      UPDATE agents
      SET org = ?,
          personal = ?,
          display_name = ?,
          capabilities = ?,
          public_key = ?,
          email = ?,
          email_verified = ?,
          verification_tier = ?,
          description = ?,
          logo_url = ?,
          verified = ?,
          email_token = ?,
          last_seen = ?
      WHERE beam_id = ?
    `).run(
      data.org ?? null,
      personal,
      data.displayName,
      capabilitiesJson,
      data.publicKey,
      normalizedEmail,
      emailVerified,
      verificationTier,
      data.description ?? null,
      data.logoUrl ?? null,
      verified,
      emailToken,
      now,
      data.beamId,
    )
  } else {
    db.prepare(`
      INSERT INTO agents (
        beam_id,
        org,
        personal,
        display_name,
        capabilities,
        public_key,
        email,
        email_verified,
        description,
        logo_url,
        trust_score,
        verified,
        verification_tier,
        flagged,
        email_token,
        created_at,
        last_seen
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.3, ?, ?, 0, ?, ?, ?)
    `).run(
      data.beamId,
      data.org ?? null,
      personal,
      data.displayName,
      capabilitiesJson,
      data.publicKey,
      normalizedEmail,
      emailVerified,
      data.description ?? null,
      data.logoUrl ?? null,
      verified,
      verificationTier,
      emailToken,
      now,
      now,
    )
  }

  syncOrgAgent(db, data, existing?.created_at ?? now)
  ensureAgentKeyRecorded(db, data.beamId, data.publicKey, createdAtMs)

  const score = calculateTrustScore(db, data.beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, data.beamId)

  const agent = getAgent(db, data.beamId) as AgentRow
  upsertDIDDocument(db, generateDIDDocument(agent))
  return agent
}

export function getAgent(db: DB, beamId: string): AgentRow | null {
  const row = db.prepare('SELECT * FROM agents WHERE beam_id = ?').get(beamId) as AgentRow | undefined
  return row ?? null
}

export function setAgentEmailToken(db: DB, beamId: string, token: string | null): AgentRow | null {
  db.prepare(`
    UPDATE agents
    SET email_token = ?,
        email_verified = CASE WHEN ? IS NULL THEN email_verified ELSE 0 END
    WHERE beam_id = ?
  `).run(token, token, beamId)

  return getAgent(db, beamId)
}

export function updateAgentProfile(
  db: DB,
  beamId: string,
  updates: {
    displayName?: string
    capabilities?: string[]
    email?: string | null
    emailVerified?: boolean
    verificationTier?: VerificationTier
    description?: string | null
    logoUrl?: string | null
  },
): AgentRow | null {
  const existing = getAgent(db, beamId)
  if (!existing) {
    return null
  }

  const normalizedEmail = updates.email === undefined
    ? existing.email
    : updates.email?.trim().toLowerCase() || null
  const emailChanged = normalizedEmail !== existing.email
  const emailVerified = normalizedEmail
    ? (updates.emailVerified === true ? 1 : emailChanged ? 0 : existing.email_verified)
    : 0
  const verificationTier = updates.verificationTier ?? existing.verification_tier
  const verified = verificationTier !== 'basic' || emailVerified === 1 ? 1 : 0
  const capabilities = updates.capabilities === undefined ? existing.capabilities : JSON.stringify(updates.capabilities)
  const emailToken = normalizedEmail ? (emailChanged ? null : existing.email_token) : null

  db.prepare(`
    UPDATE agents
    SET display_name = ?,
        capabilities = ?,
        email = ?,
        email_verified = ?,
        verification_tier = ?,
        description = ?,
        logo_url = ?,
        verified = ?,
        email_token = ?,
        last_seen = ?
    WHERE beam_id = ?
  `).run(
    updates.displayName ?? existing.display_name,
    capabilities,
    normalizedEmail,
    emailVerified,
    verificationTier,
    updates.description === undefined ? existing.description : updates.description,
    updates.logoUrl === undefined ? existing.logo_url : updates.logoUrl,
    verified,
    emailToken,
    nowIso(),
    beamId,
  )

  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)
  return getAgent(db, beamId)
}

export function createVerificationToken(
  db: DB,
  input: { token?: string; beam_id: string; email: string; expires_at: number },
): { token: string; beam_id: string; email: string; created_at: number; expires_at: number } {
  const token = input.token ?? randomBytes(24).toString('hex')
  const createdAt = nowMs()

  db.prepare('DELETE FROM verification_tokens WHERE beam_id = ?').run(input.beam_id)
  db.prepare(`
    INSERT INTO verification_tokens (token, beam_id, email, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, input.beam_id, input.email, createdAt, input.expires_at)

  return {
    token,
    beam_id: input.beam_id,
    email: input.email,
    created_at: createdAt,
    expires_at: input.expires_at,
  }
}

export function findAgentByHandle(db: DB, handle: string): AgentRow | null {
  const rows = db.prepare(`
    SELECT *
    FROM agents
    WHERE beam_id = ? OR beam_id GLOB ?
    ORDER BY created_at ASC
    LIMIT 2
  `).all(`${handle}@beam.directory`, `${handle}@*.beam.directory`) as AgentRow[]

  if (rows.length !== 1) {
    return null
  }

  return rows[0] ?? null
}

export function upsertDIDDocument(db: DB, document: DIDDocument): DIDDocument {
  const now = new Date().toISOString()
  const existing = getDIDDocument(db, document.id)
  db.prepare(`
    INSERT INTO did_documents (did, document, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(did) DO UPDATE SET
      document = excluded.document,
      updated_at = excluded.updated_at
  `).run(
    document.id,
    JSON.stringify(document),
    existing?.created ?? now,
    now
  )

  return getDIDDocument(db, document.id) as DIDDocument
}

export function getDIDDocument(db: DB, did: string): DIDDocument | null {
  const row = db.prepare('SELECT document FROM did_documents WHERE did = ?').get(did) as { document: string } | undefined
  if (!row) {
    return null
  }

  return JSON.parse(row.document) as DIDDocument
}

/**
 * Search agents with optional filters. Capabilities filtering is done in JavaScript
 * for compatibility with SQLite versions that lack full JSON function support.
 */
export function searchAgents(
  db: DB,
  query: {
    org?: string
    personal?: boolean
    capabilities?: string[]
    minTrustScore?: number
    limit?: number
  },
): AgentRow[] {
  const params: Array<string | number> = []
  const conditions: string[] = []

  if (query.personal === true) {
    conditions.push('personal = 1')
  } else if (query.org) {
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

  if (row.verification_tier !== 'basic') {
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

export function createBusinessVerification(
  db: DB,
  input: {
    beamId: string
    country: string
    registrationNumber: string
    legalName: string
    status?: string
    verificationSource?: string | null
    sourceReference?: string | null
    evidence?: unknown
    verifiedAt?: string | null
  },
): BusinessVerificationRow {
  const createdAt = nowIso()
  const status = input.status ?? 'pending'
  const verifiedAt = input.verifiedAt ?? (status === 'verified' ? createdAt : null)

  const result = db.prepare(`
    INSERT INTO business_verifications (
      beam_id,
      country,
      registration_number,
      legal_name,
      status,
      verification_source,
      source_reference,
      evidence,
      created_at,
      verified_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.beamId,
    input.country,
    input.registrationNumber,
    input.legalName,
    status,
    input.verificationSource ?? null,
    input.sourceReference ?? null,
    input.evidence === undefined ? null : JSON.stringify(input.evidence),
    createdAt,
    verifiedAt,
  )

  return db.prepare('SELECT * FROM business_verifications WHERE id = ?').get(Number(result.lastInsertRowid)) as BusinessVerificationRow
}

export function getLatestBusinessVerification(db: DB, beamId: string): BusinessVerificationRow | null {
  const row = db.prepare(`
    SELECT *
    FROM business_verifications
    WHERE beam_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(beamId) as BusinessVerificationRow | undefined

  return row ?? null
}

export function markAgentBusinessVerified(db: DB, beamId: string): AgentRow | null {
  db.prepare(`
    UPDATE agents
    SET verification_tier = 'business',
        verified = 1,
        flagged = 0,
        last_seen = ?
    WHERE beam_id = ?
  `).run(nowIso(), beamId)

  const score = calculateTrustScore(db, beamId)
  db.prepare('UPDATE agents SET trust_score = ? WHERE beam_id = ?').run(score, beamId)
  return getAgent(db, beamId)
}

export function markAgentDomainVerified(db: DB, beamId: string): AgentRow | null {
  db.prepare(`
    UPDATE agents
    SET verification_tier = 'verified',
        verified = 1,
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

export function getAgentIntentStats(db: DB, beamId: string): AgentIntentStats {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS received,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS responded,
      AVG(CASE WHEN status = 'success' THEN round_trip_latency_ms END) AS avg_response_time_ms
    FROM intent_log
    WHERE to_beam_id = ?
  `).get(beamId) as {
    received: number | null
    responded: number | null
    avg_response_time_ms: number | null
  } | undefined

  return {
    received: row?.received ?? 0,
    responded: row?.responded ?? 0,
    avg_response_time_ms: row?.avg_response_time_ms == null ? null : Math.round(row.avg_response_time_ms),
  }
}

export function getAgentDirectoryStats(db: DB): {
  total_agents: number
  verified_agents: number
  intents_processed: number
  avg_response_time_ms: number | null
} {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_agents,
      SUM(CASE WHEN verified = 1 OR verification_tier != 'basic' THEN 1 ELSE 0 END) AS verified_agents,
      (
        SELECT COUNT(*)
        FROM intent_log
      ) AS intents_processed,
      (
        SELECT AVG(round_trip_latency_ms)
        FROM intent_log
        WHERE status = 'success' AND round_trip_latency_ms IS NOT NULL
      ) AS avg_response_time_ms
    FROM agents
  `).get() as {
    total_agents: number | null
    verified_agents: number | null
    intents_processed: number | null
    avg_response_time_ms: number | null
  } | undefined

  return {
    total_agents: row?.total_agents ?? 0,
    verified_agents: row?.verified_agents ?? 0,
    intents_processed: row?.intents_processed ?? 0,
    avg_response_time_ms: row?.avg_response_time_ms == null ? null : Math.round(row.avg_response_time_ms),
  }
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
