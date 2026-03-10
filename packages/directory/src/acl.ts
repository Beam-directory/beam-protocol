import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import type { IntentAclRow } from './types.js'

interface CatalogIntent {
  id: string
  from?: string[]
  to?: string[]
}

interface CatalogFile {
  intents?: CatalogIntent[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const catalogPath = resolve(__dirname, '../catalog.yaml')

function loadCatalogIntents(): CatalogIntent[] {
  try {
    const raw = readFileSync(catalogPath, 'utf8')
    const parsed = JSON.parse(raw) as CatalogFile
    return Array.isArray(parsed.intents) ? parsed.intents : []
  } catch {
    return []
  }
}

export function createAcl(db: Database, input: {
  targetBeamId: string
  intentType: string
  allowedFrom: string
}): IntentAclRow {
  const createdAt = new Date().toISOString()

  db.prepare(`
    INSERT INTO intent_acls (target_beam_id, intent_type, allowed_from, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(target_beam_id, intent_type, allowed_from)
    DO UPDATE SET created_at = excluded.created_at
  `).run(input.targetBeamId, input.intentType, input.allowedFrom, createdAt)

  const row = db.prepare(`
    SELECT * FROM intent_acls
    WHERE target_beam_id = ? AND intent_type = ? AND allowed_from = ?
  `).get(input.targetBeamId, input.intentType, input.allowedFrom) as IntentAclRow | undefined

  if (!row) {
    throw new Error('Failed to create ACL row')
  }
  return row
}

export function listAclsForBeam(db: Database, beamId: string): IntentAclRow[] {
  return db.prepare(`
    SELECT * FROM intent_acls
    WHERE target_beam_id = ?
    ORDER BY intent_type ASC, allowed_from ASC
  `).all(beamId) as IntentAclRow[]
}

export function deleteAcl(db: Database, id: number): boolean {
  const result = db.prepare('DELETE FROM intent_acls WHERE id = ?').run(id)
  return result.changes > 0
}

export function isIntentAllowed(db: Database, input: {
  targetBeamId: string
  intentType: string
  fromBeamId: string
}): boolean {
  const rows = db.prepare(`
    SELECT allowed_from
    FROM intent_acls
    WHERE target_beam_id = ? AND intent_type = ?
  `).all(input.targetBeamId, input.intentType) as Array<{ allowed_from: string }>

  if (rows.length === 0) {
    return false
  }

  return rows.some((row) => row.allowed_from === '*' || row.allowed_from === input.fromBeamId)
}

export function seedAclsFromCatalog(db: Database, org = 'demo'): void {
  const intents = loadCatalogIntents()
  if (intents.length === 0) return

  const names = new Set<string>(['agent-a', 'agent-b'])
  for (const intent of intents) {
    for (const name of intent.from ?? []) {
      if (name !== '*') names.add(name)
    }
    for (const name of intent.to ?? []) {
      if (name !== '*') names.add(name)
    }
  }

  const knownTargets = Array.from(names).map((name) => `${name}@${org}.beam.directory`)

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO intent_acls (target_beam_id, intent_type, allowed_from, created_at)
    VALUES (?, ?, ?, ?)
  `)
  const targetExistsStmt = db.prepare('SELECT 1 FROM agents WHERE beam_id = ? LIMIT 1')
  const now = new Date().toISOString()

  const insertMany = db.transaction(() => {
    for (const intent of intents) {
      if (!intent || typeof intent.id !== 'string') continue

      const fromList = Array.isArray(intent.from) && intent.from.length > 0 ? intent.from : ['*']
      const toList = Array.isArray(intent.to) && intent.to.length > 0 ? intent.to : ['*']

      const targets = toList.includes('*')
        ? knownTargets
        : toList.map((name) => `${name}@${org}.beam.directory`)

      const allowedFromValues = fromList.includes('*')
        ? ['*']
        : fromList.map((name) => `${name}@${org}.beam.directory`)

      for (const target of targets) {
        const exists = targetExistsStmt.get(target)
        if (!exists) continue

        for (const allowedFrom of allowedFromValues) {
          insertStmt.run(target, intent.id, allowedFrom, now)
        }
      }
    }
  })

  insertMany()
}
