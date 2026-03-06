const WINDOW_MS = 60_000

const counters = new Map<string, { count: number; windowStart: number }>()

export function getRateLimitPerMinute(): number {
  const raw = process.env['BEAM_RATE_LIMIT_PER_MIN']
  const parsed = raw ? Number(raw) : 60
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 60
  }
  return Math.floor(parsed)
}

export function checkAgentRateLimit(beamId: string, limit = getRateLimitPerMinute()): boolean {
  const now = Date.now()
  const entry = counters.get(beamId)

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    counters.set(beamId, { count: 1, windowStart: now })
    return true
  }

  if (entry.count >= limit) {
    return false
  }

  entry.count += 1
  return true
}

export function pruneRateLimitState(): void {
  const now = Date.now()
  for (const [beamId, entry] of counters.entries()) {
    if (now - entry.windowStart >= WINDOW_MS) {
      counters.delete(beamId)
    }
  }
}
