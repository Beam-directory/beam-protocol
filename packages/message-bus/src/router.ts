/**
 * Beam Message Bus — Hono Router (HTTP API)
 */

import { isDeepStrictEqual } from 'node:util'
import { Hono, type Context } from 'hono'
import type Database from 'better-sqlite3'
import {
  insertMessage,
  markDispatched,
  markDelivered,
  markAcked,
  markDeadLetter,
  markFailed,
  getMessage,
  getMessageByNonce,
  listDeadLetters,
  pollMessages,
  queryHistory,
  requeueMessage,
  scheduleRetry,
  getStats,
} from './db.js'
import { deliverToDirectory } from './delivery.js'
import { computeRetryAt } from './retry.js'

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

  function serializeMessage(msg: Record<string, unknown>): Record<string, unknown> {
    const parsed = { ...msg }
    for (const field of ['payload', 'response', 'metadata'] as const) {
      if (parsed[field] && typeof parsed[field] === 'string') {
        try {
          parsed[field] = JSON.parse(parsed[field] as string)
        } catch {
          // Keep raw string payloads in operator views.
        }
      }
    }
    return parsed
  }

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
    const payloadCandidate = body.payload
    const payload = payloadCandidate && typeof payloadCandidate === 'object' && !Array.isArray(payloadCandidate)
      ? payloadCandidate as Record<string, unknown>
      : {}
    const priority = Number(body.priority ?? 0)
    const traceId = body.trace_id as string | undefined
    const nonce = typeof body.nonce === 'string' && body.nonce.trim().length > 0
      ? body.nonce.trim()
      : undefined

    if (!sender || !recipient || !intent) {
      return c.json({ error: 'Missing required fields: from, to, intent', errorCode: 'MISSING_REQUIRED_FIELDS' }, 400)
    }

    if (body.payload !== undefined && (typeof body.payload !== 'object' || Array.isArray(body.payload) || body.payload === null)) {
      return c.json({ error: 'payload must be an object', errorCode: 'INVALID_PAYLOAD' }, 400)
    }

    if (nonce) {
      const existing = getMessageByNonce(db, nonce)
      if (existing) {
        const sameMessage = existing.sender === sender
          && existing.recipient === recipient
          && existing.intent === intent
          && isDeepStrictEqual(JSON.parse(existing.payload), payload)

        if (!sameMessage) {
          return c.json({
            error: `Nonce ${nonce} already belongs to a different message`,
            errorCode: 'NONCE_REUSE_CONFLICT',
          }, 409)
        }

        return c.json({
          message_id: existing.id,
          nonce: existing.nonce,
          status: existing.status,
          created_at: existing.created_at,
          retry_count: existing.retry_count,
          deduped: true,
        })
      }
    }

    if (!checkRateLimit(sender, maxRate)) {
      return c.json({ error: `Rate limit exceeded for ${sender} (max ${maxRate}/min)`, errorCode: 'RATE_LIMIT_EXCEEDED' }, 429)
    }

    const msgId = insertMessage(db, { nonce, sender, recipient, intent, payload, priority, traceId })
    const message = getMessage(db, msgId)
    const messageNonce = message?.nonce ?? nonce ?? msgId
    const createdAt = message?.created_at ?? Date.now() / 1000

    // Attempt immediate delivery
    markDispatched(db, msgId)
    const result = await deliverToDirectory(directoryUrl, msgId, messageNonce, sender, recipient, intent, payload)

    if (result.success) {
      markDelivered(db, msgId)
      console.log(`[beam-bus] ✅ ${sender} → ${recipient} (${intent}) delivered`)
      return c.json({ message_id: msgId, nonce: messageNonce, status: 'delivered', created_at: createdAt }, 201)
    }

    if (!result.retryable) {
      markDeadLetter(db, msgId, result.error)
      console.log(`[beam-bus] 🪦 ${sender} → ${recipient} (${intent}) dead-lettered: ${result.error}`)
      return c.json({
        message_id: msgId,
        nonce: messageNonce,
        status: 'dead_letter',
        created_at: createdAt,
        error: result.error,
        error_code: result.errorCode,
      }, 201)
    }

    const retryCount = 1
    const nextRetry = computeRetryAt(retryCount, messageNonce, createdAt)
    scheduleRetry(db, msgId, retryCount, nextRetry, result.error)
    console.log(`[beam-bus] ⏳ ${sender} → ${recipient} (${intent}) queued: ${result.error}`)
    return c.json({
      message_id: msgId,
      nonce: messageNonce,
      status: 'queued',
      created_at: createdAt,
      retry_count: retryCount,
      next_retry_at: nextRetry,
      error: result.error,
      error_code: result.errorCode,
    }, 201)
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

  // GET /dead-letter
  app.get('/dead-letter', (c) => {
    const messages = listDeadLetters(db, {
      sender: c.req.query('sender'),
      recipient: c.req.query('recipient'),
      intent: c.req.query('intent'),
      limit: Math.min(Number(c.req.query('limit') ?? 100), 500),
    }).map((msg) => serializeMessage(msg as unknown as Record<string, unknown>))

    return c.json({ messages, count: messages.length })
  })

  // POST /dead-letter/:id/requeue
  app.post('/dead-letter/:id/requeue', async (c) => {
    const messageId = c.req.param('id')
    const message = getMessage(db, messageId)

    if (!message) {
      return c.json({ error: `Message ${messageId} not found`, errorCode: 'MESSAGE_NOT_FOUND' }, 404)
    }

    if (!['dead_letter', 'failed'].includes(message.status)) {
      return c.json({ error: `Message ${messageId} is not in a requeueable state`, errorCode: 'INVALID_STATE' }, 409)
    }

    requeueMessage(db, messageId)
    markDispatched(db, messageId)
    const payload = JSON.parse(message.payload) as Record<string, unknown>
    const result = await deliverToDirectory(
      directoryUrl,
      message.id,
      message.nonce,
      message.sender,
      message.recipient,
      message.intent,
      payload,
    )

    if (result.success) {
      markDelivered(db, messageId)
      return c.json({
        message_id: messageId,
        nonce: message.nonce,
        status: 'delivered',
        requeued: true,
      })
    }

    if (!result.retryable) {
      markDeadLetter(db, messageId, result.error)
      return c.json({
        message_id: messageId,
        nonce: message.nonce,
        status: 'dead_letter',
        requeued: true,
        error: result.error,
        error_code: result.errorCode,
      })
    }

    const retryCount = 1
    const nextRetry = computeRetryAt(retryCount, message.nonce)
    scheduleRetry(db, messageId, retryCount, nextRetry, result.error)

    return c.json({
      message_id: messageId,
      nonce: message.nonce,
      status: 'queued',
      requeued: true,
      retry_count: retryCount,
      next_retry_at: nextRetry,
      error: result.error,
      error_code: result.errorCode,
    })
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

    try {
      if (status === 'acked') {
        markAcked(db, messageId, response)
      } else {
        markFailed(db, messageId, response ? JSON.stringify(response) : 'Manually failed')
      }
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'Invalid lifecycle transition',
        errorCode: 'INVALID_STATE',
      }, 409)
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

    const messages = queryHistory(db, filters).map((msg) => serializeMessage(msg as unknown as Record<string, unknown>))

    return c.json({ messages, count: messages.length })
  })

  // GET /stats
  app.get('/stats', (c) => {
    return c.json(getStats(db))
  })

  return app
}
