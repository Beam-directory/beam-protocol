/**
 * Beam Message Bus — SQLite Database Layer
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface BeamMessage {
  id: string
  sender: string
  recipient: string
  intent: string
  payload: string  // JSON
  status: 'pending' | 'delivered' | 'acked' | 'failed' | 'expired'
  priority: number
  retry_count: number
  max_retries: number
  next_retry_at: number | null
  created_at: number
  delivered_at: number | null
  acked_at: number | null
  failed_at: number | null
  error: string | null
  response: string | null  // JSON
  trace_id: string | null
  metadata: string | null  // JSON
}

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS beam_messages (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      intent TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 5,
      next_retry_at REAL,
      created_at REAL NOT NULL,
      delivered_at REAL,
      acked_at REAL,
      failed_at REAL,
      error TEXT,
      response TEXT,
      trace_id TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_beam_recipient_status ON beam_messages(recipient, status);
    CREATE INDEX IF NOT EXISTS idx_beam_sender ON beam_messages(sender);
    CREATE INDEX IF NOT EXISTS idx_beam_created ON beam_messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_beam_next_retry ON beam_messages(status, next_retry_at);
  `)

  return db
}

export function insertMessage(
  db: Database.Database,
  msg: {
    sender: string
    recipient: string
    intent: string
    payload: Record<string, unknown>
    priority?: number
    maxRetries?: number
    traceId?: string | null
    metadata?: Record<string, unknown> | null
  }
): string {
  const id = randomUUID().replace(/-/g, '')
  const now = Date.now() / 1000

  db.prepare(`
    INSERT INTO beam_messages (id, sender, recipient, intent, payload, status, priority,
                               retry_count, max_retries, created_at, trace_id, metadata)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)
  `).run(
    id,
    msg.sender,
    msg.recipient,
    msg.intent,
    JSON.stringify(msg.payload),
    msg.priority ?? 0,
    msg.maxRetries ?? 5,
    now,
    msg.traceId ?? null,
    msg.metadata ? JSON.stringify(msg.metadata) : null
  )

  return id
}

export function markDelivered(db: Database.Database, id: string): void {
  db.prepare('UPDATE beam_messages SET status = ?, delivered_at = ?, error = NULL WHERE id = ?')
    .run('delivered', Date.now() / 1000, id)
}

export function markFailed(db: Database.Database, id: string, error: string): void {
  db.prepare('UPDATE beam_messages SET status = ?, failed_at = ?, error = ? WHERE id = ?')
    .run('failed', Date.now() / 1000, error, id)
}

export function markAcked(db: Database.Database, id: string, response?: Record<string, unknown>): void {
  db.prepare('UPDATE beam_messages SET status = ?, acked_at = ?, response = ? WHERE id = ?')
    .run('acked', Date.now() / 1000, response ? JSON.stringify(response) : null, id)
}

export function scheduleRetry(db: Database.Database, id: string, retryCount: number, nextRetryAt: number, error: string): void {
  db.prepare('UPDATE beam_messages SET retry_count = ?, next_retry_at = ?, error = ? WHERE id = ?')
    .run(retryCount, nextRetryAt, error, id)
}

export function getPendingRetries(db: Database.Database, limit = 10): BeamMessage[] {
  const now = Date.now() / 1000
  return db.prepare(`
    SELECT * FROM beam_messages
    WHERE status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= ?
    ORDER BY priority DESC, created_at ASC
    LIMIT ?
  `).all(now, limit) as BeamMessage[]
}

export function getMessage(db: Database.Database, id: string): BeamMessage | undefined {
  return db.prepare('SELECT * FROM beam_messages WHERE id = ?').get(id) as BeamMessage | undefined
}

export function pollMessages(
  db: Database.Database,
  agent: string,
  status = 'delivered',
  limit = 10,
  since?: number
): BeamMessage[] {
  if (since) {
    return db.prepare(`
      SELECT * FROM beam_messages WHERE recipient = ? AND status = ? AND created_at > ?
      ORDER BY created_at ASC LIMIT ?
    `).all(agent, status, since, limit) as BeamMessage[]
  }
  return db.prepare(`
    SELECT * FROM beam_messages WHERE recipient = ? AND status = ?
    ORDER BY created_at ASC LIMIT ?
  `).all(agent, status, limit) as BeamMessage[]
}

export function queryHistory(
  db: Database.Database,
  filters: {
    sender?: string
    recipient?: string
    intent?: string
    status?: string
    since?: number
    until?: number
    limit?: number
  }
): BeamMessage[] {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters.sender) { conditions.push('sender = ?'); params.push(filters.sender) }
  if (filters.recipient) { conditions.push('recipient = ?'); params.push(filters.recipient) }
  if (filters.intent) { conditions.push('intent = ?'); params.push(filters.intent) }
  if (filters.status) { conditions.push('status = ?'); params.push(filters.status) }
  if (filters.since) { conditions.push('created_at >= ?'); params.push(filters.since) }
  if (filters.until) { conditions.push('created_at <= ?'); params.push(filters.until) }

  const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1'
  const limit = filters.limit ?? 50
  params.push(limit)

  return db.prepare(`SELECT * FROM beam_messages WHERE ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as BeamMessage[]
}

export interface BusStats {
  total: number
  pending: number
  delivered: number
  acked: number
  failed: number
  by_agent: Record<string, { sent: number; received: number }>
  last_24h: number
}

export function getStats(db: Database.Database): BusStats {
  const statusCounts: Record<string, number> = {}
  const rows = db.prepare('SELECT status, COUNT(*) as cnt FROM beam_messages GROUP BY status').all() as Array<{ status: string; cnt: number }>
  for (const row of rows) {
    statusCounts[row.status] = row.cnt
  }

  const total = Object.values(statusCounts).reduce((a, b) => a + b, 0)

  const byAgent: Record<string, { sent: number; received: number }> = {}
  const senders = db.prepare('SELECT sender, COUNT(*) as cnt FROM beam_messages GROUP BY sender').all() as Array<{ sender: string; cnt: number }>
  for (const row of senders) {
    if (!byAgent[row.sender]) byAgent[row.sender] = { sent: 0, received: 0 }
    byAgent[row.sender].sent = row.cnt
  }
  const recipients = db.prepare('SELECT recipient, COUNT(*) as cnt FROM beam_messages GROUP BY recipient').all() as Array<{ recipient: string; cnt: number }>
  for (const row of recipients) {
    if (!byAgent[row.recipient]) byAgent[row.recipient] = { sent: 0, received: 0 }
    byAgent[row.recipient].received = row.cnt
  }

  const dayAgo = Date.now() / 1000 - 86400
  const last24h = (db.prepare('SELECT COUNT(*) as cnt FROM beam_messages WHERE created_at > ?').get(dayAgo) as { cnt: number }).cnt

  return {
    total,
    pending: statusCounts['pending'] ?? 0,
    delivered: statusCounts['delivered'] ?? 0,
    acked: statusCounts['acked'] ?? 0,
    failed: statusCounts['failed'] ?? 0,
    by_agent: byAgent,
    last_24h: last24h,
  }
}
