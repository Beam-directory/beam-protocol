import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createAcl, isIntentAllowed } from './acl.js'

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE intent_acls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_beam_id TEXT NOT NULL,
      intent_type TEXT NOT NULL,
      allowed_from TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(target_beam_id, intent_type, allowed_from)
    );
  `)
  return db
}

test('isIntentAllowed supports domain wildcard ACL entries', () => {
  const db = createTestDb()

  try {
    createAcl(db, {
      targetBeamId: 'echo@beam.directory',
      intentType: 'conversation.message',
      allowedFrom: '*@openclaw.beam.directory',
    })

    assert.equal(isIntentAllowed(db, {
      targetBeamId: 'echo@beam.directory',
      intentType: 'conversation.message',
      fromBeamId: 'archivar@openclaw.beam.directory',
    }), true)

    assert.equal(isIntentAllowed(db, {
      targetBeamId: 'echo@beam.directory',
      intentType: 'conversation.message',
      fromBeamId: 'jarvis@coppen.beam.directory',
    }), false)
  } finally {
    db.close()
  }
})
