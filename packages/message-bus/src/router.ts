/**
 * Beam Message Bus — Hono Router (HTTP API)
 */

import { Hono, type Context } from 'hono'
import type Database from 'better-sqlite3'
import {
  insertMessage,
  markDelivered,
  markAcked,
  markFailed,
  scheduleRetry,
  getMessage,
  pollMessages,
  queryHistory,
  getStats,
} from './db.js'
import { deliverToDirectory } from './delivery.js'

const RETRY_BACKOFF = [30, 60, 120, 240, 480] // seconds

/** Rate limiter — in-memory buckets */
const rateBuckets = new Map<string, number[]>()

function checkRateLimit(sender: string, maxPerMinute: number): boolean {
  const now = Date.now()
  const window = now - 60_000
  const bucket = rateBuckets.get(sender) ?? []
  const filtered = bucket.filter(t => t > window)
  if (filtered.length >= maxPerMinute) {
    rateBuckets.set(sender, filtered)
    return false
  }
  filtered.push(now)
  rateBuckets.set(sender, filtered)
  return true
}

export interface RouterOptions {
  db: Database.Database
  directoryUrl: string
  rateLimit?: number
}

export function createBusRouter(options: RouterOptions): Hono {
  const { db, directoryUrl, rateLimit: maxRate = 10 } = options
  const app = new Hono()
  const configuredApiKey = process.env['BEAM_BUS_API_KEY'] ?? ''
  const statsPublic = process.env['BEAM_BUS_STATS_PUBLIC'] === 'true'

  // Auth middleware — Bearer token required for all endpoints (except /stats if BEAM_BUS_STATS_PUBLIC=true)
  app.use('*', async (c: Context, next) => {
    if (statsPublic && c.req.path.endsWith('/stats')) {
      await next()
      return
    }

    if (!configuredApiKey) {
      // No key configured — allow (development mode)
      await next()
      return
    }

    const authHeader = c.req.header('authorization') ?? ''
    if (authHeader !== `Bearer ${configuredApiKey}`) {
      return c.json({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }, 401)
    }

    await next()
  })

  // POST /send
  app.post('/send', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    const sender = String(body.from ?? body.sender ?? '')
    const recipient = String(body.to ?? '')
    const intent = String(body.intent ?? '')
    const payload = (body.payload as Record<string, unknown>) ?? {}
    const priority = Number(body.priority ?? 0)
    const traceId = body.trace_id as string | undefined

    if (!sender || !recipient || !intent) {
      return c.json({ error: 'Missing required fields: from, to, intent', errorCode: 'MISSING_REQUIRED_FIELDS' }, 400)
    }

    if (!checkRateLimit(sender, maxRate)) {
      return c.json({ error: `Rate limit exceeded for ${sender} (max ${maxRate}/min)`, errorCode: 'RATE_LIMIT_EXCEEDED' }, 429)
    }

    const msgId = insertMessage(db, { sender, recipient, intent, payload, priority, traceId })
    const now = Date.now() / 1000

    // Attempt immediate delivery
    const result = await deliverToDirectory(directoryUrl, msgId, sender, recipient, intent, payload)

    if (result.success) {
      markDelivered(db, msgId)
      console.log(`[beam-bus] ✅ ${sender} → ${recipient} (${intent}) delivered`)
      return c.json({ message_id: msgId, status: 'delivered', created_at: now }, 201)
    }

    // Schedule retry
    const nextRetry = now + RETRY_BACKOFF[0]
    scheduleRetry(db, msgId, 0, nextRetry, result.error)
    console.log(`[beam-bus] ⏳ ${sender} → ${recipient} (${intent}) queued: ${result.error}`)
    return c.json({ message_id: msgId, status: 'pending', created_at: now }, 201)
  })

  // GET /poll
  app.get('/poll', (c) => {
    const agent = c.req.query('agent')
    if (!agent) return c.json({ error: 'agent query parameter is required', errorCode: 'MISSING_AGENT' }, 400)

    const status = c.req.query('status') ?? 'delivered'
    const limit = Math.min(Number(c.req.query('limit') ?? 10), 100)
    const since = c.req.query('since') ? Number(c.req.query('since')) : undefined

    const messages = pollMessages(db, agent, status, limit, since).map(msg => ({
      id: msg.id,
      sender: msg.sender,
      intent: msg.intent,
      payload: JSON.parse(msg.payload),
      priority: msg.priority,
      created_at: msg.created_at,
      delivered_at: msg.delivered_at,
      trace_id: msg.trace_id,
    }))

    return c.json({ messages, count: messages.length })
  })

  // POST /ack
  app.post('/ack', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    const messageId = String(body.message_id ?? '')
    const status = String(body.status ?? 'acked')
    const response = body.response as Record<string, unknown> | undefined

    if (!messageId) return c.json({ error: 'message_id is required', errorCode: 'MISSING_MESSAGE_ID' }, 400)
    if (!['acked', 'failed'].includes(status)) {
      return c.json({ error: 'status must be "acked" or "failed"', errorCode: 'INVALID_STATUS' }, 400)
    }

    const msg = getMessage(db, messageId)
    if (!msg) return c.json({ error: `Message ${messageId} not found`, errorCode: 'MESSAGE_NOT_FOUND' }, 404)

    if (status === 'acked') {
      markAcked(db, messageId, response)
    } else {
      markFailed(db, messageId, response ? JSON.stringify(response) : 'Manually failed')
    }

    return c.json({ message_id: messageId, status, updated_at: Date.now() / 1000 })
  })

  // GET /history
  app.get('/history', (c) => {
    const filters = {
      sender: c.req.query('sender'),
      recipient: c.req.query('recipient'),
      intent: c.req.query('intent'),
      status: c.req.query('status'),
      since: c.req.query('since') ? Number(c.req.query('since')) : undefined,
      until: c.req.query('until') ? Number(c.req.query('until')) : undefined,
      limit: Math.min(Number(c.req.query('limit') ?? 50), 500),
    }

    const messages = queryHistory(db, filters).map(msg => {
      const parsed: Record<string, unknown> = { ...msg }
      for (const field of ['payload', 'response', 'metadata'] as const) {
        if (parsed[field] && typeof parsed[field] === 'string') {
          try { parsed[field] = JSON.parse(parsed[field] as string) } catch {}
        }
      }
      return parsed
    })

    return c.json({ messages, count: messages.length })
  })

  // GET /stats
  app.get('/stats', (c) => {
    return c.json(getStats(db))
  })

  return app
}
