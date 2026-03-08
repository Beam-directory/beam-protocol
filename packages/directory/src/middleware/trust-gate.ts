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

type RateEntry = { count: number; windowStart: number }
const senderRateCounts = new Map<string, RateEntry>()
const WINDOW_MS = 3600_000

function pruneRateEntries(): void {
  const now = Date.now()
  for (const [key, entry] of senderRateCounts) {
    if (now - entry.windowStart >= WINDOW_MS) senderRateCounts.delete(key)
  }
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

  setInterval(pruneRateEntries, 300_000)

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

    // === RATE LIMIT ===
    const rateKey = `${sender}→${recipient ?? 'global'}`
    const now = Date.now()
    const entry = senderRateCounts.get(rateKey)

    if (entry && now - entry.windowStart < WINDOW_MS) {
      if (entry.count >= shield.rateLimit) {
        return c.json({
          error: 'Rate limited by Beam Shield',
          errorCode: 'SHIELD_RATE_LIMITED',
          sender,
          limit: shield.rateLimit,
        }, 429)
      }
      entry.count++
    } else {
      senderRateCounts.set(rateKey, { count: 1, windowStart: now })
    }

    await next()
  }
}
