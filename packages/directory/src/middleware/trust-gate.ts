/**
 * Beam Shield — Wall 2: Trust Gate
 * Per-agent shield config: whitelist, open, or closed mode.
 */

import type { MiddlewareHandler } from 'hono'
import type { Database } from 'better-sqlite3'
import { parseShieldConfig, type ShieldConfig } from '../routes/shield.js'

export interface TrustGateGlobalConfig {
  /** Fallback min trust when agent has no shield config */
  defaultMinTrust: number
  /** Fallback rate limit */
  defaultRateLimit: number
}

const DEFAULT_GLOBAL: TrustGateGlobalConfig = {
  defaultMinTrust: 0.3,
  defaultRateLimit: 20,
}

const WINDOW_MS = 3600_000

// H2 FIX: Persistent rate limiting in SQLite instead of in-memory Map
function checkAndIncrementRate(db: Database, rateKey: string, limit: number): boolean {
  const now = Date.now()
  const windowStart = now - WINDOW_MS
  const row = db.prepare('SELECT count, window_start FROM rate_limits WHERE rate_key = ?').get(rateKey) as { count: number; window_start: number } | undefined

  if (!row || row.window_start < windowStart) {
    // Expired or new — reset
    db.prepare('INSERT OR REPLACE INTO rate_limits (rate_key, count, window_start) VALUES (?, 1, ?)').run(rateKey, now)
    return true // allowed
  }

  if (row.count >= limit) {
    return false // rate limited
  }

  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE rate_key = ?').run(rateKey)
  return true // allowed
}

/** Match beam_id against pattern (exact or *@suffix wildcard) */
export function matchesPattern(beamId: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === beamId) return true
    if (p.startsWith('*@')) return beamId.endsWith(p.slice(1))
    if (p.startsWith('*.')) return beamId.includes(p.slice(1))
    return false
  })
}

/**
 * Resolves which agent is being targeted by this request.
 * Checks x-beam-recipient header, then URL path for known beam-id patterns.
 */
function resolveRecipient(c: { req: { header: (n: string) => string | undefined; url: string } }): string | null {
  // Explicit header (set by bridge/SDK)
  const recipient = c.req.header('x-beam-recipient')
  if (recipient) return recipient

  // Try to extract from intent send body (POST /intents/send)
  // Can't read body in middleware without consuming it, so rely on header
  return null
}

export function createTrustGateMiddleware(
  db: Database,
  globalConfig: Partial<TrustGateGlobalConfig> = {},
): MiddlewareHandler {
  const cfg = { ...DEFAULT_GLOBAL, ...globalConfig }

  // H2: Periodic cleanup of expired rate limit entries
  setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS
    try { db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(cutoff) } catch { /* ignore */ }
  }, 300_000)

  return async (c, next) => {
    const sender = c.req.header('x-beam-sender')

    // No sender = not agent-to-agent → pass through
    if (!sender) {
      await next()
      return
    }

    // Find recipient's shield config
    const recipient = resolveRecipient(c)
    let shield: ShieldConfig

    if (recipient) {
      const row = db.prepare('SELECT shield_config FROM agents WHERE beam_id = ?').get(recipient) as { shield_config: string | null } | undefined
      shield = parseShieldConfig(row?.shield_config)
    } else {
      // No recipient identifiable → use global defaults
      shield = {
        mode: 'open',
        allowlist: [],
        blocklist: [],
        minTrust: cfg.defaultMinTrust,
        rateLimit: cfg.defaultRateLimit,
      }
    }

    // === CLOSED MODE: reject everything ===
    if (shield.mode === 'closed') {
      return c.json({
        error: 'Agent is not accepting intents',
        errorCode: 'SHIELD_CLOSED',
        recipient,
      }, 403)
    }

    // === BLOCKLIST (all modes) ===
    if (matchesPattern(sender, shield.blocklist)) {
      return c.json({
        error: 'Blocked by Beam Shield',
        errorCode: 'SHIELD_BLOCKED',
        sender,
      }, 403)
    }

    // === ALLOWLIST (all modes) ===
    if (matchesPattern(sender, shield.allowlist)) {
      await next()
      return
    }

    // === WHITELIST MODE: if not in allowlist → reject ===
    if (shield.mode === 'whitelist') {
      return c.json({
        error: 'Not in allowlist — agent uses whitelist mode',
        errorCode: 'SHIELD_NOT_WHITELISTED',
        sender,
        recipient,
      }, 403)
    }

    // === OPEN MODE: trust score check ===
    const trustRow = db.prepare('SELECT trust_score FROM agents WHERE beam_id = ?').get(sender) as { trust_score: number } | undefined
    const trust = trustRow?.trust_score ?? 0

    if (trust < shield.minTrust) {
      return c.json({
        error: 'Insufficient trust score',
        errorCode: 'SHIELD_LOW_TRUST',
        required: shield.minTrust,
        actual: trust,
        sender,
      }, 403)
    }

    // === RATE LIMIT (H2 FIX: persistent in SQLite) ===
    const rateKey = `${sender}→${recipient ?? 'global'}`
    const allowed = checkAndIncrementRate(db, rateKey, shield.rateLimit)
    if (!allowed) {
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
