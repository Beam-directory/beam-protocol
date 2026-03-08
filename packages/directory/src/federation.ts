import type { Database } from 'better-sqlite3'
import {
  deleteFederatedAgentCache,
  getAgent,
  getFederatedAgentCache,
  listFederatedTrust,
  logAuditEvent,
  upsertFederatedAgentCache,
  upsertFederatedTrust,
} from './db.js'
import { discoverDirectory, inferDomainFromBeamId, type BeamDnsResolver } from './discovery.js'
import type { AgentRow, FederationPeer, FederationPeerRow } from './types.js'

export const MAX_FEDERATION_HOPS = 3
const DEFAULT_AGENT_CACHE_TTL = 300

type FetchLike = typeof fetch

export type ResolvedAgentDocument = Record<string, unknown> & {
  beam_id?: string
  beamId?: string
  public_key?: string
  publicKey?: string
  trust_score?: number
  trustScore?: number
  ttl?: number
}

export type ResolvedAgent = {
  scope: 'local' | 'cache' | 'peer' | 'discovered'
  agent: ResolvedAgentDocument
  directoryUrl: string | null
}

function getFetch(options?: { fetchImpl?: FetchLike }): FetchLike {
  return options?.fetchImpl ?? fetch
}

export function getLocalDirectoryUrl(): string {
  return process.env['BEAM_DIRECTORY_URL'] ?? 'http://localhost:3100'
}

export function getFederationSharedSecret(): string {
  return process.env['BEAM_FEDERATION_SHARED_SECRET'] ?? ''
}

export function isPrivateDirectoryMode(): boolean {
  return process.env['BEAM_PRIVATE_DIRECTORY_MODE'] === 'true'
}

function roundScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 10000) / 10000))
}

function serializeLocalAgent(row: AgentRow): ResolvedAgentDocument {
  return {
    beam_id: row.beam_id,
    org: row.org,
    display_name: row.display_name,
    capabilities: JSON.parse(row.capabilities) as string[],
    public_key: row.public_key,
    trust_score: row.trust_score,
    verified: row.verified === 1,
    created_at: row.created_at,
    last_seen: row.last_seen,
  }
}

function normalizeAgentDocument(document: unknown): ResolvedAgentDocument | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return null
  }

  return document as ResolvedAgentDocument
}

function getDocumentBeamId(document: ResolvedAgentDocument): string | null {
  return typeof document.beam_id === 'string'
    ? document.beam_id
    : typeof document.beamId === 'string'
      ? document.beamId
      : null
}

export function getFederationRequestHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers()
  const secret = getFederationSharedSecret()
  if (secret) {
    headers.set('X-Beam-Federation-Secret', secret)
  }
  headers.set('X-Beam-Source-Directory', getLocalDirectoryUrl())

  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value)
  }

  return headers
}

function isFederatedCacheFresh(cachedAt: string, ttl: number, now = Date.now()): boolean {
  const cachedTime = new Date(cachedAt).getTime()
  if (Number.isNaN(cachedTime)) {
    return false
  }

  return cachedTime + ttl * 1000 > now
}

export function getCachedFederatedAgent(db: Database, beamId: string, now = Date.now()): ResolvedAgent | null {
  const row = getFederatedAgentCache(db, beamId)
  if (!row) {
    return null
  }

  if (!isFederatedCacheFresh(row.cached_at, row.ttl, now)) {
    deleteFederatedAgentCache(db, beamId)
    return null
  }

  const agent = normalizeAgentDocument(JSON.parse(row.cached_document))
  if (!agent) {
    deleteFederatedAgentCache(db, beamId)
    return null
  }

  return {
    scope: 'cache',
    agent,
    directoryUrl: row.home_directory_url,
  }
}

export function getCachedFederatedPublicKey(db: Database, beamId: string): string | null {
  const cached = getCachedFederatedAgent(db, beamId)
  if (!cached) {
    return null
  }

  const publicKey = cached.agent.public_key ?? cached.agent.publicKey
  return typeof publicKey === 'string' && publicKey.length > 0 ? publicKey : null
}

export function listPeers(db: Database): FederationPeerRow[] {
  return db.prepare(`
    SELECT *
    FROM federation_peers
    ORDER BY trust_level DESC, directory_url ASC
  `).all() as FederationPeerRow[]
}

export function getPeer(db: Database, directoryUrl: string): FederationPeerRow | null {
  const row = db.prepare('SELECT * FROM federation_peers WHERE directory_url = ?').get(directoryUrl) as FederationPeerRow | undefined
  return row ?? null
}

function toFederationPeer(row: FederationPeerRow): FederationPeer {
  return {
    directoryUrl: row.directory_url,
    publicKey: row.public_key,
    trustLevel: row.trust_level,
    lastSeen: row.last_seen,
    syncedAt: row.synced_at,
  }
}

export function registerPeer(
  db: Database,
  directoryUrl: string,
  publicKey: string,
  options: { actor?: string; trustLevel?: number; status?: string } = {}
): FederationPeer {
  const now = new Date().toISOString()
  const trustLevel = roundScore(options.trustLevel ?? 0.5)
  const status = options.status ?? 'active'

  db.prepare(`
    INSERT INTO federation_peers (
      directory_url,
      public_key,
      trust_level,
      status,
      created_at,
      last_seen,
      synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(directory_url) DO UPDATE SET
      public_key = excluded.public_key,
      trust_level = excluded.trust_level,
      status = excluded.status,
      last_seen = excluded.last_seen
  `).run(directoryUrl, publicKey, trustLevel, status, now, now)

  logAuditEvent(db, {
    action: 'federation.peer.register',
    actor: options.actor ?? 'system',
    target: directoryUrl,
    details: { publicKeyPresent: publicKey.length > 0, trustLevel, status },
  })

  return toFederationPeer(getPeer(db, directoryUrl) as FederationPeerRow)
}

function touchPeer(db: Database, directoryUrl: string, columns: Array<'last_seen' | 'synced_at'>): void {
  if (columns.length === 0) {
    return
  }

  const now = new Date().toISOString()
  const assignments = columns.map((column) => `${column} = ?`).join(', ')
  const values = columns.map(() => now)
  db.prepare(`UPDATE federation_peers SET ${assignments} WHERE directory_url = ?`).run(...values, directoryUrl)
}

function extractAgentDocuments(payload: unknown): ResolvedAgentDocument[] {
  if (!payload || typeof payload !== 'object') {
    return []
  }

  const raw = payload as { agents?: unknown; agent?: unknown }
  if (Array.isArray(raw.agents)) {
    return raw.agents.map(normalizeAgentDocument).filter((entry): entry is ResolvedAgentDocument => Boolean(entry))
  }

  const single = normalizeAgentDocument(raw.agent)
  return single ? [single] : []
}

function getAgentDocumentTtl(agent: ResolvedAgentDocument): number {
  const ttl = agent.ttl
  return typeof ttl === 'number' ? Math.max(1, Math.trunc(ttl)) : DEFAULT_AGENT_CACHE_TTL
}

function cacheResolvedAgent(db: Database, directoryUrl: string, agent: ResolvedAgentDocument): void {
  const beamId = getDocumentBeamId(agent)
  if (!beamId) {
    return
  }

  upsertFederatedAgentCache(db, {
    beamId,
    homeDirectoryUrl: directoryUrl,
    document: agent,
    ttl: getAgentDocumentTtl(agent),
  })

  const trustScore = typeof agent.trust_score === 'number'
    ? agent.trust_score
    : typeof agent.trustScore === 'number'
      ? agent.trustScore
      : 0

  if (trustScore > 0.7) {
    applyTrustAssertion(db, {
      beamId,
      sourceDirectoryUrl: directoryUrl,
      originDirectoryUrl: directoryUrl,
      assertedTrust: trustScore,
      hopCount: 1,
    })
  }
}

export async function syncAgents(
  db: Database,
  peerUrl: string,
  options: { fetchImpl?: FetchLike; actor?: string } = {}
): Promise<{ peerUrl: string; synced: number }> {
  const response = await getFetch(options)(`${peerUrl}/directory/agents`, {
    headers: getFederationRequestHeaders(),
  })

  if (!response.ok) {
    throw new Error(`Failed to sync agents from ${peerUrl}: ${response.status}`)
  }

  const payload = await response.json() as unknown
  const agents = extractAgentDocuments(payload)

  for (const agent of agents) {
    cacheResolvedAgent(db, peerUrl, agent)
  }

  touchPeer(db, peerUrl, ['last_seen', 'synced_at'])
  logAuditEvent(db, {
    action: 'federation.peer.sync',
    actor: options.actor ?? 'system',
    target: peerUrl,
    details: { synced: agents.length },
  })

  return { peerUrl, synced: agents.length }
}

export function calculateTrustDelta(assertedTrust: number, hopCount: number): number {
  const safeTrust = Math.max(0, Math.min(1, assertedTrust))
  const safeHopCount = Math.max(1, Math.min(MAX_FEDERATION_HOPS, Math.trunc(hopCount) || 1))
  return roundScore(safeTrust * (0.5 ** safeHopCount))
}

export function applyTrustDecay(trustScore: number, assertedAt: string, now = Date.now()): number {
  const assertedAtMs = new Date(assertedAt).getTime()
  if (Number.isNaN(assertedAtMs)) {
    return roundScore(trustScore)
  }

  const weeks = Math.max(0, (now - assertedAtMs) / (7 * 24 * 60 * 60 * 1000))
  return roundScore(trustScore * (0.9 ** weeks))
}

export function applyTrustAssertion(
  db: Database,
  input: {
    beamId: string
    sourceDirectoryUrl: string
    originDirectoryUrl?: string
    assertedTrust: number
    hopCount: number
    assertedAt?: string
  }
): number {
  const hopCount = Math.max(1, Math.min(MAX_FEDERATION_HOPS, Math.trunc(input.hopCount) || 1))
  const effectiveTrust = calculateTrustDelta(input.assertedTrust, hopCount)

  upsertFederatedTrust(db, {
    beamId: input.beamId,
    sourceDirectoryUrl: input.sourceDirectoryUrl,
    originDirectoryUrl: input.originDirectoryUrl ?? input.sourceDirectoryUrl,
    assertedTrust: roundScore(input.assertedTrust),
    effectiveTrust,
    hopCount,
    assertedAt: input.assertedAt,
  })

  return effectiveTrust
}

export function getEffectiveFederatedTrust(db: Database, beamId: string, now = Date.now()): number {
  const rows = listFederatedTrust(db, beamId)
  if (rows.length === 0) {
    return 0
  }

  return rows.reduce((maxTrust, row) => {
    const decayed = applyTrustDecay(row.effective_trust, row.asserted_at, now)
    return Math.max(maxTrust, decayed)
  }, 0)
}

export async function propagateTrust(
  db: Database,
  peerUrl: string,
  beamId: string,
  trustDelta: number,
  options: { fetchImpl?: FetchLike; actor?: string; hopCount?: number; originDirectoryUrl?: string } = {}
): Promise<{ peerUrl: string; beamId: string; trustDelta: number }> {
  const response = await getFetch(options)(`${peerUrl}/federation/trust`, {
    method: 'POST',
    headers: getFederationRequestHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      beamId,
      trustDelta: roundScore(trustDelta),
      hopCount: Math.max(1, Math.min(MAX_FEDERATION_HOPS, Math.trunc(options.hopCount ?? 1) || 1)),
      originDirectoryUrl: options.originDirectoryUrl ?? getLocalDirectoryUrl(),
      sourceDirectoryUrl: getLocalDirectoryUrl(),
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to propagate trust to ${peerUrl}: ${response.status}`)
  }

  touchPeer(db, peerUrl, ['last_seen'])
  logAuditEvent(db, {
    action: 'federation.trust.propagate',
    actor: options.actor ?? 'system',
    target: `${peerUrl}:${beamId}`,
    details: { trustDelta: roundScore(trustDelta) },
  })

  return { peerUrl, beamId, trustDelta: roundScore(trustDelta) }
}

export async function queryPeerForAgent(
  db: Database,
  peerUrl: string,
  beamId: string,
  options: { fetchImpl?: FetchLike; localOnly?: boolean } = {}
): Promise<ResolvedAgent | null> {
  const query = options.localOnly ? '?localOnly=1' : ''
  const response = await getFetch(options)(`${peerUrl}/federation/agents/${encodeURIComponent(beamId)}${query}`, {
    headers: getFederationRequestHeaders(),
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to query ${peerUrl} for ${beamId}: ${response.status}`)
  }

  const payload = await response.json() as unknown
  const agent = extractAgentDocuments(payload)[0]
  if (!agent) {
    return null
  }

  cacheResolvedAgent(db, peerUrl, agent)
  touchPeer(db, peerUrl, ['last_seen'])

  return {
    scope: 'peer',
    agent,
    directoryUrl: peerUrl,
  }
}

export async function resolveAgentAcrossFederation(
  db: Database,
  beamId: string,
  options: {
    fetchImpl?: FetchLike
    resolver?: BeamDnsResolver
    localOnly?: boolean
    autoDiscover?: boolean
  } = {}
): Promise<ResolvedAgent | null> {
  const local = getAgent(db, beamId)
  if (local) {
    return {
      scope: 'local',
      agent: serializeLocalAgent(local),
      directoryUrl: getLocalDirectoryUrl(),
    }
  }

  const cached = getCachedFederatedAgent(db, beamId)
  if (cached) {
    return cached
  }

  if (!options.localOnly) {
    for (const peer of listPeers(db)) {
      if (peer.status !== 'active') {
        continue
      }

      const resolved = await queryPeerForAgent(db, peer.directory_url, beamId, {
        fetchImpl: options.fetchImpl,
        localOnly: true,
      })

      if (resolved) {
        return resolved
      }
    }
  }

  if (options.autoDiscover !== false) {
    const domain = inferDomainFromBeamId(beamId)
    if (domain) {
      const discovered = await discoverDirectory(db, domain, { resolver: options.resolver })
      if (discovered) {
        if (!getPeer(db, discovered.directoryUrl)) {
          registerPeer(db, discovered.directoryUrl, '', { actor: 'dns-discovery', status: 'discovered' })
        }

        const resolved = await queryPeerForAgent(db, discovered.directoryUrl, beamId, {
          fetchImpl: options.fetchImpl,
          localOnly: true,
        })

        if (resolved) {
          return { ...resolved, scope: 'discovered' }
        }
      }
    }
  }

  return null
}
