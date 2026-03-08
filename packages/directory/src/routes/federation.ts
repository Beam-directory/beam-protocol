import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import { getAgent, logAuditEvent, upsertFederatedTrust } from '../db.js'
import {
  applyTrustAssertion,
  getFederationSharedSecret,
  getLocalDirectoryUrl,
  isPrivateDirectoryMode,
  listPeers,
  queryPeerForAgent,
  registerPeer,
  resolveAgentAcrossFederation,
  syncAgents,
  type ResolvedAgent,
} from '../federation.js'
import { relayIntentFromHttp } from '../websocket.js'
import type { IntentFrame } from '../types.js'

function hasFederationAuth(c: Context): boolean {
  if (c.req.header('x-beam-mtls-verified') === 'true') {
    return true
  }

  const configuredSecret = getFederationSharedSecret()
  if (!configuredSecret) {
    return false
  }

  return c.req.header('x-beam-federation-secret') === configuredSecret
}

function requireFederationAuth(c: Context): Response | null {
  if (hasFederationAuth(c)) {
    return null
  }

  return c.json({ error: 'Federation authentication required', errorCode: 'FEDERATION_UNAUTHORIZED' }, 401)
}

function serializePeer(peer: ReturnType<typeof listPeers>[number]): object {
  return {
    id: peer.id,
    directoryUrl: peer.directory_url,
    publicKey: peer.public_key,
    trustLevel: peer.trust_level,
    status: peer.status,
    createdAt: peer.created_at,
    lastSeen: peer.last_seen,
    syncedAt: peer.synced_at,
  }
}

function serializeResolvedAgent(resolved: ResolvedAgent): object {
  return {
    agent: resolved.agent,
    scope: resolved.scope,
    directoryUrl: resolved.directoryUrl,
  }
}

export function federationRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/peers', async (c) => {
    const auth = requireFederationAuth(c)
    if (auth) {
      return auth
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const directoryUrl = String(raw['directoryUrl'] ?? '').trim()
    const publicKey = String(raw['publicKey'] ?? '').trim()
    const trustLevel = typeof raw['trustLevel'] === 'number' ? raw['trustLevel'] : undefined

    if (!directoryUrl) {
      return c.json({ error: 'directoryUrl is required', errorCode: 'INVALID_PEER' }, 400)
    }

    try {
      const peer = registerPeer(db, directoryUrl, publicKey, {
        actor: c.req.header('x-beam-source-directory') ?? 'federation-peer',
        trustLevel,
      })
      await syncAgents(db, directoryUrl, { actor: 'peer-registration' })
      return c.json(peer, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to register peer', errorCode: 'FEDERATION_ERROR' }, 500)
    }
  })

  router.get('/peers', (c) => {
    const auth = requireFederationAuth(c)
    if (auth) {
      return auth
    }

    const peers = listPeers(db)
    return c.json({ peers: peers.map(serializePeer), total: peers.length })
  })

  router.post('/relay', async (c) => {
    const auth = requireFederationAuth(c)
    if (auth) {
      return auth
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    const frame = body as IntentFrame
    const hopCount = Number.parseInt(c.req.header('x-beam-hop-count') ?? '1', 10)
    const sourceDirectory = c.req.header('x-beam-source-directory') ?? getLocalDirectoryUrl()

    try {
      const result = await relayIntentFromHttp(db, frame, 60_000, { sourceDirectory, hopCount })
      logAuditEvent(db, {
        action: 'federation.relay',
        actor: sourceDirectory,
        target: frame?.to ?? 'unknown',
        details: { hopCount, from: frame?.from, intent: frame?.intent },
      })
      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Relay failed', errorCode: 'FEDERATION_RELAY_ERROR' }, 502)
    }
  })

  router.get('/agents/:beamId', async (c) => {
    const auth = requireFederationAuth(c)
    if (auth && isPrivateDirectoryMode()) {
      return auth
    }

    const beamId = decodeURIComponent(c.req.param('beamId'))
    const localOnly = c.req.query('localOnly') === '1'

    if (localOnly) {
      const local = getAgent(db, beamId)
      if (!local) {
        return c.json({ error: 'Agent not found', errorCode: 'NOT_FOUND' }, 404)
      }

      return c.json({
        agent: {
          beam_id: local.beam_id,
          org: local.org,
          display_name: local.display_name,
          capabilities: JSON.parse(local.capabilities) as string[],
          public_key: local.public_key,
          trust_score: local.trust_score,
          verified: local.verified === 1,
          created_at: local.created_at,
          last_seen: local.last_seen,
        },
        scope: 'local',
        directoryUrl: getLocalDirectoryUrl(),
      })
    }

    const resolved = await resolveAgentAcrossFederation(db, beamId)
    if (!resolved) {
      return c.json({ error: 'Agent not found', errorCode: 'NOT_FOUND' }, 404)
    }

    return c.json(serializeResolvedAgent(resolved))
  })

  router.post('/trust', async (c) => {
    const auth = requireFederationAuth(c)
    if (auth) {
      return auth
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const beamId = String(raw['beamId'] ?? '').trim()
    const trustDelta = typeof raw['trustDelta'] === 'number' ? raw['trustDelta'] : null
    const assertedTrust = typeof raw['assertedTrust'] === 'number' ? raw['assertedTrust'] : null
    const sourceDirectoryUrl = String(raw['sourceDirectoryUrl'] ?? c.req.header('x-beam-source-directory') ?? '').trim()
    const originDirectoryUrl = String(raw['originDirectoryUrl'] ?? sourceDirectoryUrl).trim()
    const hopCount = Number.isFinite(Number(raw['hopCount'])) ? Number(raw['hopCount']) : 1

    if (!beamId || !sourceDirectoryUrl || (trustDelta === null && assertedTrust === null)) {
      return c.json({ error: 'beamId, sourceDirectoryUrl, and trust value are required', errorCode: 'INVALID_TRUST_UPDATE' }, 400)
    }

    const effectiveTrust = trustDelta ?? applyTrustAssertion(db, {
      beamId,
      sourceDirectoryUrl,
      originDirectoryUrl,
      assertedTrust: assertedTrust as number,
      hopCount,
    })

    if (trustDelta !== null) {
      upsertFederatedTrust(db, {
        beamId,
        sourceDirectoryUrl,
        originDirectoryUrl,
        assertedTrust: trustDelta,
        effectiveTrust: trustDelta,
        hopCount,
      })
    }

    logAuditEvent(db, {
      action: 'federation.trust.receive',
      actor: sourceDirectoryUrl,
      target: beamId,
      details: { effectiveTrust, hopCount, originDirectoryUrl },
    })

    return c.json({ beamId, effectiveTrust, sourceDirectoryUrl, originDirectoryUrl })
  })

  router.post('/resolve', async (c) => {
    const auth = requireFederationAuth(c)
    if (auth) {
      return auth
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }

    const beamId = String((body as Record<string, unknown>)['beamId'] ?? '').trim()
    if (!beamId) {
      return c.json({ error: 'beamId is required', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const cached = await resolveAgentAcrossFederation(db, beamId)
    if (!cached) {
      for (const peer of listPeers(db)) {
        const resolved = await queryPeerForAgent(db, peer.directory_url, beamId, { localOnly: true })
        if (resolved) {
          return c.json(serializeResolvedAgent(resolved))
        }
      }

      return c.json({ error: 'Agent not found', errorCode: 'NOT_FOUND' }, 404)
    }

    return c.json(serializeResolvedAgent(cached))
  })

  return router
}
