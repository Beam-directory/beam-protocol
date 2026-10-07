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
  }
}
