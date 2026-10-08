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
}
