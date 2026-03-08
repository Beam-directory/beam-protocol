import type { MiddlewareHandler } from 'hono'

const WINDOW_MS = 60_000

type RateLimitRule = {
  key: string
  limit: number
  method?: string
  path: string
}

type RateLimitEntry = {
  count: number
  windowStart: number
}

type RateLimitOptions = {
  defaultLimit?: number
  rules?: RateLimitRule[]
}

const DEFAULT_RULES: RateLimitRule[] = [
  { key: 'registration', method: 'POST', path: '/agents/register', limit: 10 },
  { key: 'search', method: 'GET', path: '/agents/search', limit: 30 },
]

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

function pruneExpiredEntries(entries: Map<string, RateLimitEntry>, now: number): void {
  for (const [key, entry] of entries.entries()) {
    if (now - entry.windowStart >= WINDOW_MS) {
      entries.delete(key)
    }
  }
}

export function createRateLimitMiddleware(options: RateLimitOptions = {}): MiddlewareHandler {
  const entries = new Map<string, RateLimitEntry>()
  const defaultLimit = options.defaultLimit ?? 60
  const rules = options.rules ?? DEFAULT_RULES

  return async (c, next) => {
    const now = Date.now()
    pruneExpiredEntries(entries, now)

    const path = c.req.path
    const method = c.req.method.toUpperCase()
    const rule = rules.find((candidate) => candidate.path === path && (candidate.method?.toUpperCase() ?? method) === method)
    const bucket = rule?.key ?? 'default'
    const limit = rule?.limit ?? defaultLimit
    const ip = getClientIp(c.req.raw)
    const key = `${bucket}:${ip}`
    const entry = entries.get(key)

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      entries.set(key, { count: 1, windowStart: now })
      await next()
      return
    }

    if (entry.count >= limit) {
      return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
    }

    entry.count += 1
    await next()
  }
}
