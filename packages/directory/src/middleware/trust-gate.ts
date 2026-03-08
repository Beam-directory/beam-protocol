/**
 * Beam Shield — Wall 2: Trust Gate
 * Evaluates sender trust before allowing intents through.
 */

import type { MiddlewareHandler } from 'hono'

export interface TrustGateConfig {
  /** Minimum trust score to accept intents (0.0–1.0) */
  minTrustScore: number
  /** Always accept from these Beam-IDs (supports *@org.beam.directory wildcards) */
  allowlist: string[]
  /** Always reject from these Beam-IDs */
  blocklist: string[]
  /** Max intents per sender per hour */
  senderRateLimit: number
  /** Max intents per sender per hour for agents < 7 days old */
  newAgentRateLimit: number
}

const DEFAULT_CONFIG: TrustGateConfig = {
  minTrustScore: 0.5,
  allowlist: [],
  blocklist: [],
  senderRateLimit: 20,
  newAgentRateLimit: 5,
}

type RateEntry = { count: number; windowStart: number }
const senderRateCounts = new Map<string, RateEntry>()
const WINDOW_MS = 3600_000 // 1 hour

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

export interface TrustLookup {
  getTrust: (beamId: string) => number
  getCreatedAt?: (beamId: string) => string | null
}

export function createTrustGateMiddleware(
  config: Partial<TrustGateConfig> = {},
  lookup?: TrustLookup,
): MiddlewareHandler {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // Prune expired entries every 5 minutes
  setInterval(pruneRateEntries, 300_000)

  return async (c, next) => {
    const sender = c.req.header('x-beam-sender')

    // No sender header = not an agent-to-agent request → pass through
    if (!sender) {
      await next()
      return
    }

    // CHECK 1: Blocklist → immediate reject
    if (matchesPattern(sender, cfg.blocklist)) {
      return c.json({
        error: 'Blocked by Beam Shield trust gate',
        errorCode: 'SHIELD_BLOCKED',
        sender,
      }, 403)
    }

    // CHECK 2: Allowlist → bypass all other checks
    if (matchesPattern(sender, cfg.allowlist)) {
      await next()
      return
    }

    // CHECK 3: Trust score
    const trust = lookup?.getTrust(sender) ?? 0
    if (trust < cfg.minTrustScore) {
      return c.json({
        error: 'Insufficient trust score',
        errorCode: 'SHIELD_LOW_TRUST',
        required: cfg.minTrustScore,
        actual: trust,
        sender,
      }, 403)
    }

    // CHECK 4: Per-sender rate limit
    const now = Date.now()
    const entry = senderRateCounts.get(sender)

    // Determine rate limit (new agents get lower limit)
    let limit = cfg.senderRateLimit
    if (lookup?.getCreatedAt) {
      const createdAt = lookup.getCreatedAt(sender)
      if (createdAt) {
        const ageMs = now - new Date(createdAt).getTime()
        if (ageMs < 7 * 24 * 3600_000) {
          limit = cfg.newAgentRateLimit
        }
      }
    }

    if (entry && now - entry.windowStart < WINDOW_MS) {
      if (entry.count >= limit) {
        return c.json({
          error: 'Sender rate limited by Beam Shield',
          errorCode: 'SHIELD_RATE_LIMITED',
          sender,
          limit,
        }, 429)
      }
      entry.count++
    } else {
      senderRateCounts.set(sender, { count: 1, windowStart: now })
    }

    // All checks passed
    await next()
  }
}
