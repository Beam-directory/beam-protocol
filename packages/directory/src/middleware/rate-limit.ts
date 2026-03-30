import type { MiddlewareHandler } from 'hono'
import type { Database } from 'better-sqlite3'
import { getPublicEndpointShieldPolicy, logAuditEvent } from '../db.js'
import { hashPayload, logShieldEvent } from '../shield/audit.js'
import { matchesBeamPattern, type PublicEndpointShieldPolicy } from '../shield/policies.js'

const WINDOW_MS = 60_000

type BucketSpec = {
  bucket: string
  limit: number
  actorKey: string
  actorLabel: string
  intentType: string
  payload: unknown
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? 'unknown'
  )
}

function consumeRate(db: Database, rateKey: string, limit: number): boolean {
  const now = Date.now()
  const minimumWindowStart = now - WINDOW_MS
  const row = db.prepare('SELECT count, window_start FROM rate_limits WHERE rate_key = ?').get(rateKey) as { count: number; window_start: number } | undefined

  if (!row || row.window_start < minimumWindowStart) {
    db.prepare('INSERT OR REPLACE INTO rate_limits (rate_key, count, window_start) VALUES (?, 1, ?)').run(rateKey, now)
    return true
  }

  if (row.count >= limit) {
    return false
  }

  db.prepare('UPDATE rate_limits SET count = count + 1 WHERE rate_key = ?').run(rateKey)
  return true
}

async function parseRequestBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.clone().json()
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
  } catch {
    return null
  }

  return null
}

function isTrusted(policy: PublicEndpointShieldPolicy, ip: string, beamId?: string | null): boolean {
  return policy.trustedIps.includes(ip) || Boolean(beamId && matchesBeamPattern(beamId, policy.trustedBeamIds))
}

function createLookupBucket(path: string, ip: string, policy: PublicEndpointShieldPolicy): BucketSpec | null {
  const reserved = new Set(['search', 'browse', 'stats', 'verify', 'verify-email'])
  const match = /^\/agents\/([^/]+)$/.exec(path)
  if (!match || reserved.has(match[1] ?? '')) {
    return null
  }

  return {
    bucket: 'agent-lookup',
    limit: policy.lookupPerMinute,
    actorKey: `ip:${ip}`,
    actorLabel: `ip:${ip}`,
    intentType: 'http.agent.lookup',
    payload: { path },
  }
}

async function resolveBuckets(
  request: Request,
  path: string,
  method: string,
  ip: string,
  policy: PublicEndpointShieldPolicy,
): Promise<{ trusted: boolean; buckets: BucketSpec[] }> {
  if (method === 'POST' && path === '/agents/register') {
    return {
      trusted: isTrusted(policy, ip),
      buckets: [{
        bucket: 'agent-registration',
        limit: policy.registrationPerMinute,
        actorKey: `ip:${ip}`,
        actorLabel: `ip:${ip}`,
        intentType: 'http.agent.register',
        payload: { path },
      }],
    }
  }

  if (method === 'GET' && path === '/agents/search') {
    return {
      trusted: isTrusted(policy, ip),
      buckets: [{
        bucket: 'agent-search',
        limit: policy.searchPerMinute,
        actorKey: `ip:${ip}`,
        actorLabel: `ip:${ip}`,
        intentType: 'http.agent.search',
        payload: { path },
      }],
    }
  }

  if (method === 'GET' && path === '/agents/browse') {
    return {
      trusted: isTrusted(policy, ip),
      buckets: [{
        bucket: 'agent-browse',
        limit: policy.browsePerMinute,
        actorKey: `ip:${ip}`,
        actorLabel: `ip:${ip}`,
        intentType: 'http.agent.browse',
        payload: { path },
      }],
    }
  }

  if (method === 'GET' && (path === '/.well-known/did.json' || path.startsWith('/did/'))) {
    return {
      trusted: isTrusted(policy, ip),
      buckets: [{
        bucket: 'did-resolution',
        limit: policy.didResolutionPerMinute,
        actorKey: `ip:${ip}`,
        actorLabel: `ip:${ip}`,
        intentType: 'http.did.resolve',
        payload: { path },
      }],
    }
  }

  if (method === 'POST' && (path === '/admin/auth/magic-link' || path === '/admin/auth/verify')) {
    return {
      trusted: isTrusted(policy, ip),
      buckets: [{
        bucket: 'admin-auth',
        limit: policy.adminAuthPerMinute,
        actorKey: `ip:${ip}`,
        actorLabel: `ip:${ip}`,
        intentType: 'http.admin.auth',
        payload: { path },
      }],
    }
  }

  if (method === 'POST' && /^\/agents\/[^/]+\/keys\/(?:rotate|revoke)$/.test(path)) {
    const beamId = decodeURIComponent(path.split('/')[2] ?? '')
    return {
      trusted: isTrusted(policy, ip, beamId),
      buckets: [{
        bucket: 'key-mutation',
        limit: policy.keyMutationPerMinute,
        actorKey: `beam:${beamId}`,
        actorLabel: beamId,
        intentType: 'http.agent.keys',
        payload: { path, beamId },
      }],
    }
  }

  if (method === 'POST' && path === '/intents/send') {
    const body = await parseRequestBody(request)
    const sender = typeof body?.from === 'string' ? body.from : null
    const buckets: BucketSpec[] = [{
      bucket: 'intent-send-ip',
      limit: policy.intentSendPerIpPerMinute,
      actorKey: `ip:${ip}`,
      actorLabel: `ip:${ip}`,
      intentType: 'http.intent.send',
      payload: body ?? { path, malformed: true },
    }]

    if (sender) {
      buckets.push({
        bucket: 'intent-send-sender',
        limit: policy.intentSendPerSenderPerMinute,
        actorKey: `beam:${sender}`,
        actorLabel: sender,
        intentType: 'http.intent.send',
        payload: body ?? { path, malformed: true },
      })
    }

    return {
      trusted: isTrusted(policy, ip, sender),
      buckets,
    }
  }

  const lookupBucket = createLookupBucket(path, ip, policy)
  if (method === 'GET' && lookupBucket) {
    return {
      trusted: isTrusted(policy, ip),
      buckets: [lookupBucket],
    }
  }

  return { trusted: false, buckets: [] }
}

function logThrottle(
  db: Database,
  input: {
    actor: string
    path: string
    bucket: string
    limit: number
    ip: string
    intentType: string
    payload: unknown
  },
): void {
  const timestamp = new Date().toISOString()

  logAuditEvent(db, {
    action: 'public.rate_limit.throttled',
    actor: input.actor,
    target: input.path,
    timestamp,
    details: {
      bucket: input.bucket,
      limit: input.limit,
      ip: input.ip,
      intentType: input.intentType,
    },
  })

  logShieldEvent(db, {
    nonce: null,
    timestamp,
    senderBeamId: input.actor,
    senderTrust: 0,
    intentType: input.intentType,
    payloadHash: hashPayload(input.payload),
    decision: 'reject',
    riskScore: 0.9,
    responseSize: 0,
    anomalyFlags: ['RATE_LIMITED', `bucket:${input.bucket}`, `ip:${input.ip}`],
  })
}

export function createRateLimitMiddleware(db: Database): MiddlewareHandler {
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
    const method = c.req.method.toUpperCase()
    const path = c.req.path
    const ip = getClientIp(c.req.raw)
    const { policy } = getPublicEndpointShieldPolicy(db)
    const { trusted, buckets } = await resolveBuckets(c.req.raw, path, method, ip, policy)

    if (trusted || buckets.length === 0) {
      await next()
      return
    }

    for (const bucket of buckets) {
      const allowed = consumeRate(db, `${bucket.bucket}:${bucket.actorKey}`, bucket.limit)
      if (!allowed) {
        logThrottle(db, {
          actor: bucket.actorLabel,
          path,
          bucket: bucket.bucket,
          limit: bucket.limit,
          ip,
          intentType: bucket.intentType,
          payload: bucket.payload,
        })
        c.header('Retry-After', '60')
        return c.json({ error: 'Too many requests', errorCode: 'RATE_LIMITED' }, 429)
      }
    }

    await next()
  }
}
