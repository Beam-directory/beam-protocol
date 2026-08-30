import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { agentApiKeyMatches, beamIdFromApiKey, getSuppliedApiKey } from '../api-key.js'
import { verifyPayload } from '../crypto.js'
import {
  createBeamConnectionRequest,
  getAgent,
  getBeamConnectionById,
  getBeamConnectionBetween,
  getOrg,
  listBeamConnections,
  logAuditEvent,
  recordNonce,
  removeBeamConnection,
  respondToBeamConnection,
} from '../db.js'
import { toBeamDID } from '../did.js'
import type { AgentRow, BeamConnectionRow, BeamConnectionStatus } from '../types.js'
import { broadcastNetworkEvent, isAgentConnected } from '../websocket.js'

const BEAM_ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}@(?:[a-z0-9](?:[a-z0-9.-]{0,124}[a-z0-9])?\.)?beam\.directory$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const SIGNATURE_RE = /^[A-Za-z0-9+/=_-]{64,256}$/
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000
const CONNECTION_STATUSES = new Set<BeamConnectionStatus>([
  'pending',
  'accepted',
  'declined',
  'blocked',
  'cancelled',
])

export type AuthenticatedIdentity = {
  agent: AgentRow
}

export function authenticateNetworkIdentity(db: Database, request: Request): AuthenticatedIdentity | null {
  const apiKey = getSuppliedApiKey(request)
  const beamId = beamIdFromApiKey(apiKey)
  const agent = beamId ? getAgent(db, beamId) : null
  if (!agentApiKeyMatches(agent, apiKey)) {
    return null
  }

  return { agent: agent as AgentRow }
}

export function isNetworkAssured(db: Database, agent: AgentRow): boolean {
  if (agent.flagged === 1) {
    return false
  }
  if (agent.identity_kind === 'person' || agent.personal === 1) {
    return agent.email_verified === 1
  }
  if (agent.verification_tier !== 'basic' || agent.verified === 1) {
    return true
  }
  if (agent.org) {
    return getOrg(db, agent.org)?.verified === 1
  }
  return false
}

function assuranceLabel(db: Database, agent: AgentRow): 'email' | 'organization' | 'directory' | 'none' {
  if ((agent.identity_kind === 'person' || agent.personal === 1) && agent.email_verified === 1) {
    return 'email'
  }
  if (agent.org && getOrg(db, agent.org)?.verified === 1) {
    return 'organization'
  }
  if (agent.verification_tier !== 'basic' || agent.verified === 1) {
    return 'directory'
  }
  return 'none'
}

export function safeNetworkProfile(db: Database, agent: AgentRow): object {
  return {
    beamId: agent.beam_id,
    did: toBeamDID(agent.beam_id),
    displayName: agent.display_name,
    identityKind: agent.identity_kind,
    organization: agent.personal === 1 ? null : agent.org,
    description: agent.description,
    logoUrl: agent.logo_url,
    verificationTier: agent.verification_tier,
    assured: isNetworkAssured(db, agent),
    assurance: assuranceLabel(db, agent),
    dhPublicKey: agent.dh_public_key,
    visibility: agent.visibility,
  }
}

function relationshipType(db: Database, connection: BeamConnectionRow): 'C2C' | 'C2B' | 'B2C' | 'B2B' {
  const requester = getAgent(db, connection.requester_beam_id)
  const recipient = getAgent(db, connection.recipient_beam_id)
  const requesterIsPerson = requester?.identity_kind === 'person' || requester?.personal === 1
  const recipientIsPerson = recipient?.identity_kind === 'person' || recipient?.personal === 1

  if (requesterIsPerson && recipientIsPerson) return 'C2C'
  if (requesterIsPerson) return 'C2B'
  if (recipientIsPerson) return 'B2C'
  return 'B2B'
}

function serializeConnection(db: Database, connection: BeamConnectionRow, viewerBeamId: string): object {
  const counterpartBeamId = connection.requester_beam_id === viewerBeamId
    ? connection.recipient_beam_id
    : connection.requester_beam_id
  const counterpart = getAgent(db, counterpartBeamId)

  return {
    connectionId: connection.connection_id,
    status: connection.status,
    direction: connection.requester_beam_id === viewerBeamId ? 'outbound' : 'inbound',
    relationshipType: relationshipType(db, connection),
    requesterBeamId: connection.requester_beam_id,
    recipientBeamId: connection.recipient_beam_id,
    message: connection.request_message,
    counterpart: counterpart ? safeNetworkProfile(db, counterpart) : null,
    online: isAgentConnected(counterpartBeamId),
    blockedByMe: connection.blocked_by_beam_id === viewerBeamId,
    createdAt: connection.created_at,
    updatedAt: connection.updated_at,
    respondedAt: connection.responded_at,
  }
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) {
    return null
  }
  const timestampMs = Date.parse(value)
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > SIGNATURE_WINDOW_MS) {
    return null
  }
  return value
}

function normalizeNonce(value: unknown): string | null {
  return typeof value === 'string' && NONCE_RE.test(value) ? value : null
}

function normalizeSignature(value: unknown): string | null {
  return typeof value === 'string' && SIGNATURE_RE.test(value) ? value : null
}

export async function readNetworkObjectBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function verifyNetworkSignedMutation(
  db: Database,
  agent: AgentRow,
  raw: Record<string, unknown>,
  payload: Record<string, unknown>,
): { ok: true; signature: string } | { ok: false; error: string; errorCode: string; status: 400 | 401 | 409 } {
  const timestamp = normalizeTimestamp(raw['timestamp'])
  const nonce = normalizeNonce(raw['nonce'])
  const signature = normalizeSignature(raw['signature'])
  if (!timestamp || !nonce || !signature) {
    return { ok: false, error: 'A fresh timestamp, nonce, and signature are required', errorCode: 'INVALID_PROOF', status: 400 }
  }

  const signedPayload = { ...payload, timestamp, nonce }
  if (!verifyPayload(signedPayload, signature, agent.public_key)) {
    return { ok: false, error: 'Identity signature could not be verified', errorCode: 'INVALID_SIGNATURE', status: 401 }
  }
  if (!recordNonce(db, nonce)) {
    return { ok: false, error: 'This signed request has already been used', errorCode: 'NONCE_REPLAY', status: 409 }
  }

  return { ok: true, signature }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

export function networkRouter(db: Database): Hono {
  const router = new Hono()

  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    await next()
  })

  router.get('/me', (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) {
      return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    }

    const connections = listBeamConnections(db, auth.agent.beam_id, ['pending', 'accepted'])
    return c.json({
      identity: safeNetworkProfile(db, auth.agent),
      counts: {
        contacts: connections.filter((connection) => connection.status === 'accepted').length,
        inbound: connections.filter((connection) => (
          connection.status === 'pending' && connection.recipient_beam_id === auth.agent.beam_id
        )).length,
        outbound: connections.filter((connection) => (
          connection.status === 'pending' && connection.requester_beam_id === auth.agent.beam_id
        )).length,
      },
    })
  })

  router.get('/connections', (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) {
      return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    }

    const rawStatus = c.req.query('status')?.trim()
    const statuses = rawStatus
      ? rawStatus.split(',').map((status) => status.trim()).filter((status): status is BeamConnectionStatus => (
          CONNECTION_STATUSES.has(status as BeamConnectionStatus)
        ))
      : ['pending', 'accepted'] satisfies BeamConnectionStatus[]
    if (rawStatus && statuses.length === 0) {
      return c.json({ error: 'Unknown connection status', errorCode: 'INVALID_STATUS' }, 400)
    }

    const connections = listBeamConnections(db, auth.agent.beam_id, statuses)
    return c.json({
      connections: connections.map((connection) => serializeConnection(db, connection, auth.agent.beam_id)),
      total: connections.length,
    })
  })

  router.get('/discover', (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) {
      return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    }

    const query = c.req.query('q')?.trim().toLowerCase() ?? ''
    if (query.length < 3 || query.length > 128) {
      return c.json({ error: 'Search must be 3–128 characters', errorCode: 'INVALID_QUERY' }, 400)
    }

    const exactBeamId = BEAM_ID_RE.test(query) ? query : ''
    const fuzzy = `%${escapeLike(query)}%`
    const rows = db.prepare(`
      SELECT *
      FROM agents
      WHERE beam_id <> ?
        AND flagged = 0
        AND (
          beam_id = ?
          OR (
            visibility = 'public'
            AND (
              lower(beam_id) LIKE ? ESCAPE '\\'
              OR lower(display_name) LIKE ? ESCAPE '\\'
              OR lower(COALESCE(org, '')) LIKE ? ESCAPE '\\'
            )
          )
        )
      ORDER BY
        CASE WHEN beam_id = ? THEN 0 ELSE 1 END,
        verified DESC,
        trust_score DESC,
        beam_id ASC
      LIMIT 20
    `).all(auth.agent.beam_id, exactBeamId, fuzzy, fuzzy, fuzzy, exactBeamId) as AgentRow[]

    return c.json({
      results: rows.map((agent) => {
        const existing = getBeamConnectionBetween(db, auth.agent.beam_id, agent.beam_id)
        return {
          identity: safeNetworkProfile(db, agent),
          connection: existing ? serializeConnection(db, existing, auth.agent.beam_id) : null,
        }
      }),
      total: rows.length,
    })
  })

  router.post('/connections', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) {
      return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    }
    if (!isNetworkAssured(db, auth.agent)) {
      return c.json({ error: 'Verify this Beam identity before connecting', errorCode: 'IDENTITY_NOT_ASSURED' }, 403)
    }

    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }
    const recipientBeamId = typeof raw['recipientBeamId'] === 'string'
      ? raw['recipientBeamId'].trim().toLowerCase()
      : ''
    const message = typeof raw['message'] === 'string' ? raw['message'].trim() : ''
    if (!BEAM_ID_RE.test(recipientBeamId) || recipientBeamId === auth.agent.beam_id) {
      return c.json({ error: 'Choose another valid Beam identity', errorCode: 'INVALID_RECIPIENT' }, 400)
    }
    if (message.length > 280) {
      return c.json({ error: 'Connection message must be at most 280 characters', errorCode: 'MESSAGE_TOO_LONG' }, 400)
    }

    const recipient = getAgent(db, recipientBeamId)
    if (!recipient || !isNetworkAssured(db, recipient)) {
      return c.json({ error: 'That verified Beam identity was not found', errorCode: 'RECIPIENT_NOT_FOUND' }, 404)
    }

    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.connection.request',
      requesterBeamId: auth.agent.beam_id,
      recipientBeamId,
      message,
    })
    if (!proof.ok) {
      return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)
    }

    const result = createBeamConnectionRequest(db, {
      requesterBeamId: auth.agent.beam_id,
      recipientBeamId,
      message: message || null,
      signature: proof.signature,
    })
    if (!result.created) {
      const errorCode = result.connection.status === 'blocked' ? 'CONNECTION_BLOCKED' : 'CONNECTION_EXISTS'
      return c.json({
        error: result.connection.status === 'blocked'
          ? 'This relationship is blocked'
          : 'A relationship already exists',
        errorCode,
        connection: serializeConnection(db, result.connection, auth.agent.beam_id),
      }, 409)
    }

    logAuditEvent(db, {
      action: 'network.connection.requested',
      actor: auth.agent.beam_id,
      target: recipientBeamId,
      details: { connectionId: result.connection.connection_id },
    })
    broadcastNetworkEvent([auth.agent.beam_id, recipientBeamId], {
      type: 'network.connection.updated',
      connectionId: result.connection.connection_id,
      status: result.connection.status,
    })
    return c.json({ connection: serializeConnection(db, result.connection, auth.agent.beam_id) }, 201)
  })

  router.post('/connections/:connectionId/respond', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) {
      return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    }
    const connectionId = c.req.param('connectionId')
    const existing = getBeamConnectionById(db, connectionId)
    if (!existing || existing.recipient_beam_id !== auth.agent.beam_id || existing.status !== 'pending') {
      return c.json({ error: 'Pending connection request not found', errorCode: 'CONNECTION_NOT_FOUND' }, 404)
    }

    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }
    const decision = raw['decision']
    if (decision !== 'accepted' && decision !== 'declined' && decision !== 'blocked') {
      return c.json({ error: 'Decision must be accepted, declined, or blocked', errorCode: 'INVALID_DECISION' }, 400)
    }

    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.connection.respond',
      connectionId,
      actorBeamId: auth.agent.beam_id,
      decision,
    })
    if (!proof.ok) {
      return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)
    }

    const connection = respondToBeamConnection(db, {
      connectionId,
      actorBeamId: auth.agent.beam_id,
      decision,
      signature: proof.signature,
    })
    if (!connection) {
      return c.json({ error: 'Connection request changed before it could be updated', errorCode: 'CONNECTION_CONFLICT' }, 409)
    }

    logAuditEvent(db, {
      action: `network.connection.${decision}`,
      actor: auth.agent.beam_id,
      target: connection.requester_beam_id,
      details: { connectionId },
    })
    broadcastNetworkEvent([connection.requester_beam_id, connection.recipient_beam_id], {
      type: 'network.connection.updated',
      connectionId,
      status: connection.status,
    })
    return c.json({ connection: serializeConnection(db, connection, auth.agent.beam_id) })
  })

  router.delete('/connections/:connectionId', async (c) => {
    const auth = authenticateNetworkIdentity(db, c.req.raw)
    if (!auth) {
      return c.json({ error: 'A valid Beam credential is required', errorCode: 'UNAUTHORIZED' }, 401)
    }
    const connectionId = c.req.param('connectionId')
    const existing = getBeamConnectionById(db, connectionId)
    const isParticipant = existing && (
      existing.requester_beam_id === auth.agent.beam_id
      || existing.recipient_beam_id === auth.agent.beam_id
    )
    if (!existing || !isParticipant || existing.status === 'blocked') {
      return c.json({ error: 'Removable connection not found', errorCode: 'CONNECTION_NOT_FOUND' }, 404)
    }

    const raw = await readNetworkObjectBody(c.req.raw)
    if (!raw) {
      return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
    }
    const proof = verifyNetworkSignedMutation(db, auth.agent, raw, {
      type: 'network.connection.remove',
      connectionId,
      actorBeamId: auth.agent.beam_id,
    })
    if (!proof.ok) {
      return c.json({ error: proof.error, errorCode: proof.errorCode }, proof.status)
    }

    const connection = removeBeamConnection(db, {
      connectionId,
      actorBeamId: auth.agent.beam_id,
      signature: proof.signature,
    })
    if (!connection) {
      return c.json({ error: 'Connection cannot be removed in its current state', errorCode: 'CONNECTION_CONFLICT' }, 409)
    }

    logAuditEvent(db, {
      action: 'network.connection.removed',
      actor: auth.agent.beam_id,
      target: existing.requester_beam_id === auth.agent.beam_id
        ? existing.recipient_beam_id
        : existing.requester_beam_id,
      details: { connectionId },
    })
    broadcastNetworkEvent([existing.requester_beam_id, existing.recipient_beam_id], {
      type: 'network.connection.updated',
      connectionId,
      status: connection.status,
    })
    return c.json({ connection: serializeConnection(db, connection, auth.agent.beam_id) })
  })

  return router
}
