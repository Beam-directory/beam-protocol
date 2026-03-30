/**
 * Beam Shield — Wall 2: Trust Gate
 * Per-agent allowlist/blocklist/trust/rate-limit enforcement for intent delivery.
 */

import type { MiddlewareHandler } from 'hono'
import type { Database } from 'better-sqlite3'
import { logAuditEvent } from '../db.js'
import { hashPayload, logShieldEvent } from '../shield/audit.js'
import { matchesBeamPattern, parseShieldConfig, type ShieldConfig } from '../shield/policies.js'

export interface TrustGateGlobalConfig {
  defaultMinTrust: number
  defaultRateLimit: number
}

const DEFAULT_GLOBAL: TrustGateGlobalConfig = {
  defaultMinTrust: 0.3,
  defaultRateLimit: 20,
}

const WINDOW_MS = 3600_000

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? 'unknown'
  )
}

function checkAndIncrementRate(db: Database, rateKey: string, limit: number): boolean {
  const now = Date.now()
  const windowStart = now - WINDOW_MS
  const row = db.prepare('SELECT count, window_start FROM rate_limits WHERE rate_key = ?').get(rateKey) as { count: number; window_start: number } | undefined

  if (!row || row.window_start < windowStart) {
    db.prepare('INSERT OR REPLACE INTO rate_limits (rate_key, count, window_start) VALUES (?, 1, ?)').run(rateKey, now)
    return true
  }

  if (row.count >= limit) {
    return false
  }

  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE rate_key = ?').run(rateKey)
  return true
}

async function parseIntentEnvelope(request: Request): Promise<{
  sender: string | null
  recipient: string | null
  intentType: string | null
  payload: unknown
}> {
  if (request.method.toUpperCase() !== 'POST') {
    return { sender: null, recipient: null, intentType: null, payload: null }
  }

  const path = new URL(request.url).pathname
  if (path !== '/intents/send') {
    return { sender: null, recipient: null, intentType: null, payload: null }
  }

  try {
    const cloned = request.clone()
    const body = await cloned.json() as Record<string, unknown>
    return {
      sender: typeof body.from === 'string' ? body.from : null,
      recipient: typeof body.to === 'string' ? body.to : null,
      intentType: typeof body.intent === 'string' ? body.intent : 'http.intent.send',
      payload: body.payload ?? body.params ?? body,
    }
  } catch {
    return {
      sender: null,
      recipient: null,
      intentType: 'http.intent.send',
      payload: { malformed: true },
    }
  }
}

function logShieldRejection(
  db: Database,
  input: {
    sender: string
    recipient: string | null
    senderTrust: number
    intentType: string
    errorCode: string
    reason: string
    ip: string
    payload: unknown
  },
): void {
  const timestamp = new Date().toISOString()

  logAuditEvent(db, {
    action: 'shield.request.blocked',
    actor: input.sender,
    target: input.recipient ?? input.intentType,
    timestamp,
    details: {
      errorCode: input.errorCode,
      reason: input.reason,
      ip: input.ip,
      intentType: input.intentType,
      recipient: input.recipient,
    },
  })

  logShieldEvent(db, {
    nonce: null,
    timestamp,
    senderBeamId: input.sender,
    senderTrust: input.senderTrust,
    intentType: input.intentType,
    payloadHash: hashPayload(input.payload),
    decision: 'reject',
    riskScore: 0.85,
    responseSize: 0,
    anomalyFlags: [input.errorCode, `ip:${input.ip}`],
  })
}

export function createTrustGateMiddleware(
  db: Database,
  globalConfig: Partial<TrustGateGlobalConfig> = {},
): MiddlewareHandler {
  const cfg = { ...DEFAULT_GLOBAL, ...globalConfig }
  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS
    try {
      db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(cutoff)
    } catch {
      // ignore cleanup errors
    }
  }, 300_000)
  cleanupTimer.unref?.()

  return async (c, next) => {
    const envelope = await parseIntentEnvelope(c.req.raw)
    const sender = c.req.header('x-beam-sender') ?? envelope.sender

    if (!sender) {
      await next()
      return
    }

    const recipient = c.req.header('x-beam-recipient') ?? envelope.recipient
    const intentType = envelope.intentType ?? 'http.intent.send'
    const ip = getClientIp(c.req.raw)

    let shield: ShieldConfig
    if (recipient) {
      const row = db.prepare('SELECT shield_config FROM agents WHERE beam_id = ?').get(recipient) as { shield_config: string | null } | undefined
      shield = parseShieldConfig(row?.shield_config)
    } else {
      shield = {
        mode: 'open',
        allowlist: [],
        blocklist: [],
        minTrust: cfg.defaultMinTrust,
        rateLimit: cfg.defaultRateLimit,
      }
    }

    const senderTrust = (db.prepare('SELECT trust_score FROM agents WHERE beam_id = ?').get(sender) as { trust_score: number } | undefined)?.trust_score ?? 0

    if (shield.mode === 'closed') {
      logShieldRejection(db, {
        sender,
        recipient,
        senderTrust,
        intentType,
        errorCode: 'SHIELD_CLOSED',
        reason: 'Agent is not accepting intents',
        ip,
        payload: envelope.payload,
      })
      return c.json({
        error: 'Agent is not accepting intents',
        errorCode: 'SHIELD_CLOSED',
        recipient,
      }, 403)
    }

    if (matchesBeamPattern(sender, shield.blocklist)) {
      logShieldRejection(db, {
        sender,
        recipient,
        senderTrust,
        intentType,
        errorCode: 'SHIELD_BLOCKED',
        reason: 'Sender matched recipient blocklist',
        ip,
        payload: envelope.payload,
      })
      return c.json({
        error: 'Blocked by Beam Shield',
        errorCode: 'SHIELD_BLOCKED',
        sender,
      }, 403)
    }

    if (matchesBeamPattern(sender, shield.allowlist)) {
      await next()
      return
    }

    if (shield.mode === 'whitelist') {
      logShieldRejection(db, {
        sender,
        recipient,
        senderTrust,
        intentType,
        errorCode: 'SHIELD_NOT_WHITELISTED',
        reason: 'Sender was not present in recipient allowlist',
        ip,
        payload: envelope.payload,
      })
      return c.json({
        error: 'Not in allowlist — agent uses whitelist mode',
        errorCode: 'SHIELD_NOT_WHITELISTED',
        sender,
        recipient,
      }, 403)
    }

    if (senderTrust < shield.minTrust) {
      logShieldRejection(db, {
        sender,
        recipient,
        senderTrust,
        intentType,
        errorCode: 'SHIELD_LOW_TRUST',
        reason: 'Sender trust score is below the recipient minimum',
        ip,
        payload: envelope.payload,
      })
      return c.json({
        error: 'Insufficient trust score',
        errorCode: 'SHIELD_LOW_TRUST',
        required: shield.minTrust,
        actual: senderTrust,
        sender,
      }, 403)
    }

    const rateKey = `${sender}→${recipient ?? 'global'}`
    if (!checkAndIncrementRate(db, rateKey, shield.rateLimit)) {
      logShieldRejection(db, {
        sender,
        recipient,
        senderTrust,
        intentType,
        errorCode: 'SHIELD_RATE_LIMITED',
        reason: 'Sender exceeded recipient shield rate limit',
        ip,
        payload: envelope.payload,
      })
      return c.json({
        error: 'Rate limited by Beam Shield',
        errorCode: 'SHIELD_RATE_LIMITED',
        sender,
        limit: shield.rateLimit,
      }, 429)
    }

    await next()
  }
}
