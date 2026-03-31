import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createDatabase } from './db.js'

function createTempDbPath(): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'beam-directory-migrations-'))
  return {
    root,
    dbPath: join(root, 'beam-directory.sqlite'),
  }
}

test('createDatabase migrates legacy Fly volumes without nonce columns', () => {
  const { root, dbPath } = createTempDbPath()
  const legacyDb = new Database(dbPath)

  try {
    legacyDb.exec(`
      CREATE TABLE agents (
        beam_id TEXT PRIMARY KEY,
        org TEXT,
        personal INTEGER NOT NULL DEFAULT 0,
        display_name TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]',
        public_key TEXT NOT NULL,
        api_key_hash TEXT,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        logo_url TEXT,
        website TEXT,
        trust_score REAL NOT NULL DEFAULT 0.5,
        verified INTEGER NOT NULL DEFAULT 0,
        verification_tier TEXT NOT NULL DEFAULT 'basic',
        email_token TEXT,
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );

      INSERT INTO agents (
        beam_id,
        org,
        personal,
        display_name,
        capabilities,
        public_key,
        trust_score,
        verified,
        verification_tier,
        created_at,
        last_seen
      ) VALUES (
        'sender@legacy.beam.directory',
        'legacy',
        0,
        'Legacy Sender',
        '[]',
        'sender-key',
        0.5,
        0,
        'basic',
        '2026-03-30T18:00:00.000Z',
        '2026-03-30T18:00:00.000Z'
      );

      INSERT INTO agents (
        beam_id,
        org,
        personal,
        display_name,
        capabilities,
        public_key,
        trust_score,
        verified,
        verification_tier,
        created_at,
        last_seen
      ) VALUES (
        'receiver@legacy.beam.directory',
        'legacy',
        0,
        'Legacy Receiver',
        '[]',
        'receiver-key',
        0.5,
        0,
        'basic',
        '2026-03-30T18:00:00.000Z',
        '2026-03-30T18:00:00.000Z'
      );

      CREATE TABLE intent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_beam_id TEXT NOT NULL,
        to_beam_id TEXT NOT NULL,
        intent_type TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        round_trip_latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'success',
        error_code TEXT
      );

      INSERT INTO intent_log (
        from_beam_id,
        to_beam_id,
        intent_type,
        requested_at,
        completed_at,
        round_trip_latency_ms,
        status,
        error_code
      ) VALUES (
        'sender@legacy.beam.directory',
        'receiver@legacy.beam.directory',
        'conversation.message',
        '2026-03-30T18:00:00.000Z',
        '2026-03-30T18:00:01.000Z',
        1000,
        'success',
        NULL
      );

      CREATE TABLE shield_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        sender_beam_id TEXT,
        sender_trust REAL,
        intent_type TEXT,
        payload_hash TEXT,
        decision TEXT,
        risk_score REAL,
        response_size INTEGER,
        anomaly_flags TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO shield_audit_log (
        timestamp,
        sender_beam_id,
        sender_trust,
        intent_type,
        payload_hash,
        decision,
        risk_score,
        response_size,
        anomaly_flags,
        created_at
      ) VALUES (
        '2026-03-30T18:00:00.000Z',
        'sender@legacy.beam.directory',
        0.4,
        'conversation.message',
        'abc123',
        'allow',
        0.2,
        32,
        '[]',
        '2026-03-30T18:00:00.000Z'
      );
    `)
  } finally {
    legacyDb.close()
  }

  const db = createDatabase(dbPath)

  try {
    const intentColumns = db.prepare('PRAGMA table_info(intent_log)').all() as Array<{ name: string }>
    assert.ok(intentColumns.some((column) => column.name === 'nonce'))
    assert.ok(intentColumns.some((column) => column.name === 'result_json'))

    const migratedIntent = db.prepare(`
      SELECT nonce, status, result_json, from_beam_id, to_beam_id
      FROM intent_log
      ORDER BY id ASC
      LIMIT 1
    `).get() as {
      nonce: string
      status: string
      result_json: string | null
      from_beam_id: string
      to_beam_id: string
    } | undefined

    assert.ok(migratedIntent)
    assert.match(migratedIntent?.nonce ?? '', /^legacy-intent-\d+/)
    assert.equal(migratedIntent?.status, 'acked')
    assert.equal(migratedIntent?.result_json ?? null, null)
    assert.equal(migratedIntent?.from_beam_id, 'sender@legacy.beam.directory')
    assert.equal(migratedIntent?.to_beam_id, 'receiver@legacy.beam.directory')

    const shieldColumns = db.prepare('PRAGMA table_info(shield_audit_log)').all() as Array<{ name: string }>
    assert.ok(shieldColumns.some((column) => column.name === 'nonce'))

    const shieldRow = db.prepare('SELECT nonce, decision FROM shield_audit_log LIMIT 1').get() as {
      nonce: string | null
      decision: string | null
    } | undefined

    assert.ok(shieldRow)
    assert.equal(shieldRow?.nonce ?? null, null)
    assert.equal(shieldRow?.decision, 'allow')
  } finally {
    db.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test('createDatabase migrates legacy waitlist tables before creating status indexes', () => {
  const { root, dbPath } = createTempDbPath()
  const legacyDb = new Database(dbPath)

  try {
    legacyDb.exec(`
      CREATE TABLE waitlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        source TEXT,
        company TEXT,
        agent_count INTEGER,
        created_at TEXT NOT NULL
      );

      INSERT INTO waitlist (
        email,
        source,
        company,
        agent_count,
        created_at
      ) VALUES (
        'ops@legacy.example',
        'hosted-beta',
        'Legacy Co',
        3,
        '2026-03-30T18:00:00.000Z'
      );
    `)
  } finally {
    legacyDb.close()
  }

  const db = createDatabase(dbPath)

  try {
    const waitlistColumns = db.prepare('PRAGMA table_info(waitlist)').all() as Array<{ name: string }>
    assert.ok(waitlistColumns.some((column) => column.name === 'status'))
    assert.ok(waitlistColumns.some((column) => column.name === 'owner'))
    assert.ok(waitlistColumns.some((column) => column.name === 'operator_notes'))
    assert.ok(waitlistColumns.some((column) => column.name === 'next_action'))
    assert.ok(waitlistColumns.some((column) => column.name === 'last_contact_at'))
    assert.ok(waitlistColumns.some((column) => column.name === 'next_meeting_at'))
    assert.ok(waitlistColumns.some((column) => column.name === 'reminder_at'))
    assert.ok(waitlistColumns.some((column) => column.name === 'blocked_prerequisites'))
    assert.ok(waitlistColumns.some((column) => column.name === 'stage_entered_at'))
    assert.ok(waitlistColumns.some((column) => column.name === 'updated_at'))

    const waitlistRow = db.prepare(`
      SELECT email, status, owner, operator_notes, next_action, last_contact_at, next_meeting_at, reminder_at, blocked_prerequisites, stage_entered_at, updated_at, created_at
      FROM waitlist
      LIMIT 1
    `).get() as {
      email: string
      status: string
      owner: string | null
      operator_notes: string | null
      next_action: string | null
      last_contact_at: string | null
      next_meeting_at: string | null
      reminder_at: string | null
      blocked_prerequisites: string | null
      stage_entered_at: string
      updated_at: string
      created_at: string
    } | undefined

    assert.ok(waitlistRow)
    assert.equal(waitlistRow?.email, 'ops@legacy.example')
    assert.equal(waitlistRow?.status, 'new')
    assert.equal(waitlistRow?.owner ?? null, null)
    assert.equal(waitlistRow?.operator_notes ?? null, null)
    assert.equal(waitlistRow?.next_action ?? null, null)
    assert.equal(waitlistRow?.last_contact_at ?? null, null)
    assert.equal(waitlistRow?.next_meeting_at ?? null, null)
    assert.equal(waitlistRow?.reminder_at ?? null, null)
    assert.equal(waitlistRow?.blocked_prerequisites ?? null, null)
    assert.equal(waitlistRow?.stage_entered_at, waitlistRow?.created_at)
    assert.equal(waitlistRow?.updated_at, waitlistRow?.created_at)

    const indexes = db.prepare("PRAGMA index_list('waitlist')").all() as Array<{ name: string }>
    assert.ok(indexes.some((index) => index.name === 'idx_waitlist_status'))
    assert.ok(indexes.some((index) => index.name === 'idx_waitlist_owner'))
    assert.ok(indexes.some((index) => index.name === 'idx_waitlist_last_contact'))
    assert.ok(indexes.some((index) => index.name === 'idx_waitlist_next_meeting'))
    assert.ok(indexes.some((index) => index.name === 'idx_waitlist_reminder'))

    const notificationColumns = db.prepare('PRAGMA table_info(operator_notifications)').all() as Array<{ name: string }>
    assert.ok(notificationColumns.some((column) => column.name === 'source_type'))
    assert.ok(notificationColumns.some((column) => column.name === 'source_key'))
    assert.ok(notificationColumns.some((column) => column.name === 'status'))
    assert.ok(notificationColumns.some((column) => column.name === 'owner'))
    assert.ok(notificationColumns.some((column) => column.name === 'next_action'))

    const notificationIndexes = db.prepare("PRAGMA index_list('operator_notifications')").all() as Array<{ name: string }>
    assert.ok(notificationIndexes.some((index) => index.name === 'idx_operator_notifications_status'))
    assert.ok(notificationIndexes.some((index) => index.name === 'idx_operator_notifications_source'))
    assert.ok(notificationIndexes.some((index) => index.name === 'idx_operator_notifications_owner'))

    const funnelColumns = db.prepare('PRAGMA table_info(funnel_events)').all() as Array<{ name: string }>
    assert.ok(funnelColumns.some((column) => column.name === 'session_id'))
    assert.ok(funnelColumns.some((column) => column.name === 'page_key'))
    assert.ok(funnelColumns.some((column) => column.name === 'event_category'))
    assert.ok(funnelColumns.some((column) => column.name === 'milestone_key'))

    const funnelIndexes = db.prepare("PRAGMA index_list('funnel_events')").all() as Array<{ name: string }>
    assert.ok(funnelIndexes.some((index) => index.name === 'idx_funnel_events_created_at'))
    assert.ok(funnelIndexes.some((index) => index.name === 'idx_funnel_events_category'))
    assert.ok(funnelIndexes.some((index) => index.name === 'idx_funnel_events_session'))
  } finally {
    db.close()
    rmSync(root, { force: true, recursive: true })
  }
})

test('createDatabase adds beam workspace foundation tables to legacy databases', () => {
  const { root, dbPath } = createTempDbPath()
  const legacyDb = new Database(dbPath)

  try {
    legacyDb.exec(`
      CREATE TABLE agents (
        beam_id TEXT PRIMARY KEY,
        org TEXT,
        personal INTEGER NOT NULL DEFAULT 0,
        display_name TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]',
        public_key TEXT NOT NULL,
        api_key_hash TEXT,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        logo_url TEXT,
        website TEXT,
        trust_score REAL NOT NULL DEFAULT 0.5,
        verified INTEGER NOT NULL DEFAULT 0,
        verification_tier TEXT NOT NULL DEFAULT 'basic',
        email_token TEXT,
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
    `)
  } finally {
    legacyDb.close()
  }

  const db = createDatabase(dbPath)

  try {
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'workspaces',
          'workspace_members',
          'workspace_identity_bindings',
          'workspace_partner_channels',
          'workspace_policies'
        )
      ORDER BY name ASC
    `).all() as Array<{ name: string }>

    assert.deepEqual(
      tables.map((row) => row.name),
      [
        'workspace_identity_bindings',
        'workspace_members',
        'workspace_partner_channels',
        'workspace_policies',
        'workspaces',
      ],
    )

    const bindingColumns = db.prepare('PRAGMA table_info(workspace_identity_bindings)').all() as Array<{ name: string }>
    assert.ok(bindingColumns.some((column) => column.name === 'default_thread_scope'))
    assert.ok(bindingColumns.some((column) => column.name === 'can_initiate_external'))
    assert.ok(bindingColumns.some((column) => column.name === 'runtime_type'))
  } finally {
    db.close()
    rmSync(root, { force: true, recursive: true })
  }
})
