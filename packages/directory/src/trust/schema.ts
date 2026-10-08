import type { Database } from 'better-sqlite3'

function columnNames(db: Database, tableName: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return new Set(columns.map((column) => column.name))
}

function ensureColumn(db: Database, tableName: string, columnName: string, definition: string): void {
  const columns = columnNames(db, tableName)
  if (columns.size === 0 || columns.has(columnName)) {
    return
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}

export function ensureTrustOrgSchema(db: Database): void {
  ensureColumn(db, 'orgs', 'domain_verified_via', 'TEXT')
  ensureColumn(db, 'orgs', 'requested_name', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_registry_filings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('handelsregister', 'lei')),
      country TEXT NOT NULL,
      registration_number TEXT NOT NULL,
      register_court TEXT,
      legal_name TEXT NOT NULL,
      applicant_name TEXT NOT NULL,
      applicant_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      review_note TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (org_name) REFERENCES orgs(name) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_org_registry_org
      ON org_registry_filings(org_name, created_at DESC, id DESC);
  `)

  const duplicates = db.prepare(`
    SELECT domain
    FROM orgs
    WHERE domain IS NOT NULL AND domain != ''
    GROUP BY domain
    HAVING COUNT(*) > 1
  `).all() as Array<{ domain: string }>
  if (duplicates.length === 0) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_domain_unique
      ON orgs(domain)
      WHERE domain IS NOT NULL AND domain != ''
    `)
  } else {
    const domains = duplicates.map((row) => row.domain).join(', ')
    console.error(`[trust] SKIPPED unique index idx_orgs_domain_unique because these domains are duplicated: ${domains}`)
    db.prepare(`
      INSERT INTO audit_log (action, actor, target, timestamp, details)
      VALUES ('org.domain_index.skipped', 'system', 'idx_orgs_domain_unique', ?, ?)
    `).run(new Date().toISOString(), JSON.stringify({ domains: duplicates.map((row) => row.domain) }))
  }
  ensureTrustPersonSchema(db)
}

function ensureTrustPersonSchema(db: Database): void {
  ensureColumn(db, 'agents', 'responsible_person_id', 'TEXT')
  ensureColumn(db, 'agents', 'suspended_at', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      id TEXT PRIMARY KEY,
      org_name TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      supervisor_person_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'offboarded')),
      kyc_status TEXT NOT NULL DEFAULT 'unverified' CHECK(kyc_status IN ('unverified', 'pending', 'verified', 'rejected')),
      kyc_provider TEXT,
      kyc_reference TEXT,
      public_key TEXT,
      rights_json TEXT NOT NULL DEFAULT '{"actions":[]}',
      external_source TEXT,
      external_id TEXT,
      offboarded_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (org_name) REFERENCES orgs(name) ON DELETE CASCADE,
      FOREIGN KEY (supervisor_person_id) REFERENCES persons(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_org_email ON persons(org_name, email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_external
      ON persons(org_name, external_source, external_id)
      WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_persons_supervisor ON persons(supervisor_person_id);

    CREATE TABLE IF NOT EXISTS mandates (
      id TEXT PRIMARY KEY,
      jti TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL,
      person_id TEXT NOT NULL,
      agent_beam_id TEXT NOT NULL,
      org_name TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      escalation_person_id TEXT,
      signature TEXT NOT NULL,
      payload_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (person_id) REFERENCES persons(id),
      FOREIGN KEY (agent_beam_id) REFERENCES agents(beam_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mandates_agent_status ON mandates(agent_beam_id, status);
    CREATE INDEX IF NOT EXISTS idx_mandates_person_status ON mandates(person_id, status);

    CREATE TABLE IF NOT EXISTS acceptance_rules (
      owner_beam_id TEXT PRIMARY KEY,
      allowed_org_domains TEXT NOT NULL DEFAULT '[]',
      allowed_scopes TEXT NOT NULL DEFAULT '[]',
      allowed_agents TEXT NOT NULL DEFAULT '[]',
      require_known_contact INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (owner_beam_id) REFERENCES agents(beam_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS person_invitations (
      id TEXT PRIMARY KEY,
      org_name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      supervisor_person_id TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      rights_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (org_name) REFERENCES orgs(name) ON DELETE CASCADE
    );
  `)
  ensureColumn(db, 'acceptance_rules', 'version', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'delegations', 'payload_hash', 'TEXT')
  ensureColumn(db, 'intent_log', 'result_signature', 'TEXT')
  ensureColumn(db, 'orgs', 'suspended_at', 'TEXT')
  ensureColumn(db, 'beam_connections', 'held_for_person_id', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_approvals (
      id TEXT PRIMARY KEY,
      nonce TEXT NOT NULL UNIQUE,
      from_beam_id TEXT NOT NULL,
      to_beam_id TEXT NOT NULL,
      intent_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
      escalation_person_id TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_intent_approvals_person
      ON intent_approvals(escalation_person_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS mandate_order_spend (
      nonce TEXT PRIMARY KEY,
      mandate_jti TEXT NOT NULL,
      day TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mandate_order_spend_day
      ON mandate_order_spend(mandate_jti, day);

    CREATE TABLE IF NOT EXISTS abuse_reports (
      id TEXT PRIMARY KEY,
      reporter_beam_id TEXT NOT NULL,
      target_beam_id TEXT NOT NULL,
      message_id TEXT,
      intent_nonce TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'blocked', 'dismissed')),
      block_scope TEXT CHECK(block_scope IN ('agent', 'person', 'org')),
      review_note TEXT,
      reviewed_by TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_abuse_reports_target
      ON abuse_reports(target_beam_id, created_at DESC);
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegations_payload_hash
      ON delegations(payload_hash)
      WHERE payload_hash IS NOT NULL
  `)
}
