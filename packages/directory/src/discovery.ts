import { promises as dns } from 'node:dns'
import type { Database } from 'better-sqlite3'
import { getDnsCache, setDnsCache } from './db.js'

const DEFAULT_TTL_SECONDS = 300

type ResolveAnyRecord = {
  type?: string
  ttl?: number
  name?: string
  value?: string
  priority?: number
  weight?: number
  port?: number
}

export type DirectoryDiscovery = {
  directoryUrl: string
  ttl: number
  source: 'cache' | 'dns'
}

export type DidDiscovery = {
  did: string
  ttl: number
  source: 'cache' | 'dns'
}

export type BeamDnsResolver = {
  resolveAny?: (hostname: string) => Promise<ResolveAnyRecord[]>
  resolveSrv?: (hostname: string) => Promise<Array<{ name: string; port: number; priority: number; weight: number; ttl?: number }>>
  resolveTxt?: (hostname: string) => Promise<string[][]>
}

function defaultResolver(): BeamDnsResolver {
  return {
    resolveAny: dns.resolveAny.bind(dns),
    resolveSrv: dns.resolveSrv.bind(dns),
    resolveTxt: dns.resolveTxt.bind(dns),
  }
}

function normalizeTtl(ttl?: number): number {
  return Math.max(1, Math.trunc(ttl ?? DEFAULT_TTL_SECONDS))
}

function sortSrvRecords<T extends { priority: number; weight: number }>(records: T[]): T[] {
  return [...records].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority
    }
    return right.weight - left.weight
  })
}

export function inferDomainFromBeamId(beamId: string): string | null {
  const [, domain] = beamId.split('@')
  return domain?.trim() || null
}

export async function discoverDirectory(
  db: Database,
  domain: string,
  options: { resolver?: BeamDnsResolver } = {}
): Promise<DirectoryDiscovery | null> {
  const cacheKey = `_beam._tcp.${domain}`
  const cached = getDnsCache(db, cacheKey, 'SRV')
  if (cached) {
    const payload = JSON.parse(cached.payload) as { directoryUrl: string; ttl: number }
    return { ...payload, source: 'cache' }
  }

  const resolver = options.resolver ?? defaultResolver()

  let srvRecords: Array<{ name: string; port: number; priority: number; weight: number; ttl?: number }> = []
  if (resolver.resolveAny) {
    try {
      const anyRecords = await resolver.resolveAny(cacheKey)
      srvRecords = anyRecords
        .filter((record) => record.type === 'SRV' && typeof record.name === 'string' && typeof record.port === 'number')
        .map((record) => ({
          name: record.name as string,
          port: record.port as number,
          priority: typeof record.priority === 'number' ? record.priority : 0,
          weight: typeof record.weight === 'number' ? record.weight : 0,
          ttl: record.ttl,
        }))
    } catch {
      srvRecords = []
    }
  }

  if (srvRecords.length === 0 && resolver.resolveSrv) {
    try {
      srvRecords = await resolver.resolveSrv(cacheKey)
    } catch {
      srvRecords = []
    }
  }

  if (srvRecords.length === 0) {
    return null
  }

  const selected = sortSrvRecords(srvRecords)[0]
  const ttl = normalizeTtl(selected?.ttl)
  const protocol = selected.port === 80 ? 'http' : 'https'
  const includePort = (protocol === 'https' && selected.port !== 443) || (protocol === 'http' && selected.port !== 80)
  const directoryUrl = `${protocol}://${selected.name}${includePort ? `:${selected.port}` : ''}`

  setDnsCache(db, {
    cacheKey,
    recordType: 'SRV',
    payload: { directoryUrl, ttl },
    ttlSeconds: ttl,
  })

  return { directoryUrl, ttl, source: 'dns' }
}

export async function discoverDID(
  db: Database,
  domain: string,
  options: { resolver?: BeamDnsResolver } = {}
): Promise<DidDiscovery | null> {
  const cacheKey = `_did._beam.${domain}`
  const cached = getDnsCache(db, cacheKey, 'TXT')
  if (cached) {
    const payload = JSON.parse(cached.payload) as { did: string; ttl: number }
    return { ...payload, source: 'cache' }
  }

  const resolver = options.resolver ?? defaultResolver()
  let txtRecords: string[][] = []

  if (resolver.resolveTxt) {
    try {
      txtRecords = await resolver.resolveTxt(cacheKey)
    } catch {
      txtRecords = []
    }
  }

  const flattened = txtRecords.map((entry) => entry.join('')).find((entry) => entry.trim().length > 0)
  if (!flattened) {
    return null
  }

  const ttl = DEFAULT_TTL_SECONDS
  setDnsCache(db, {
    cacheKey,
    recordType: 'TXT',
    payload: { did: flattened, ttl },
    ttlSeconds: ttl,
  })

  return { did: flattened, ttl, source: 'dns' }
}
