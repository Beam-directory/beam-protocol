import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentKeyRow, AgentRow } from '../types.js'
import {
  getAgent,
  listAgentKeys,
  listRevokedAgentKeys,
  revokeAgentKey,
  rotateAgentKey,
} from '../db.js'
import { verifyPayload } from '../crypto.js'
import { BEAM_ID_RE } from '../validation.js'
import { agentApiKeyMatches, getSuppliedApiKey } from '../api-key.js'
import { serializeAgent, serializeAgentKey, serializeAgentKeyState } from '../utils/serialize.js'

type KeyLifecycleErrorResponse = {
  error: string
  errorCode: string
  status: 404 | 409 | 500
}

function jsonError(error: string, errorCode: string, status: KeyLifecycleErrorResponse['status']): KeyLifecycleErrorResponse {
  return { error, errorCode, status }
}

function getKeyState(db: Database, beamId: string) {
  return serializeAgentKeyState(listAgentKeys(db, beamId))
}

function buildAuthPayload(
  action: 'keys.rotate' | 'keys.revoke',
  beamId: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action,
    beamId,
    ...fields,
  }
}

function canManageKeys(
  agent: AgentRow,
  request: Request,
  payload: Record<string, unknown>,
  signature?: string,
  legacyProof?: { newPublicKey: string; rotationProof?: string },
): boolean {
  const suppliedApiKey = getSuppliedApiKey(request)
  if (agentApiKeyMatches(agent, suppliedApiKey)) {
    return true
  }

  if (signature?.trim() && verifyPayload(payload, signature.trim(), agent.public_key)) {
    return true
  }

  if (
    legacyProof?.rotationProof
    && legacyProof.newPublicKey
    && verifyPayload(legacyProof.newPublicKey, legacyProof.rotationProof, agent.public_key)
  ) {
    return true
  }

  return false
}

function keyLifecycleErrorResponse(error: unknown): KeyLifecycleErrorResponse {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code ?? '') : ''
  switch (code) {
    case 'ACTIVE_KEY_REQUIRED':
      return jsonError('Active key must be rotated before it can be revoked', 'ACTIVE_KEY_REQUIRED', 409)
    case 'KEY_ALREADY_REVOKED':
      return jsonError((error as Error).message, 'KEY_ALREADY_REVOKED', 409)
    case 'KEY_NOT_FOUND':
      return jsonError((error as Error).message, 'KEY_NOT_FOUND', 404)
    default:
      return jsonError('Failed to manage agent keys', 'KEY_MANAGEMENT_ERROR', 500)
  }
}

export function agentKeysRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/:beamId/keys', (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const agent = getAgent(db, beamId)
    if (!agent) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    return c.json({
      beamId,
      keyState: getKeyState(db, beamId),
    })
  })

  router.post('/:beamId/keys/rotate', async (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const agent = getAgent(db, beamId)
    if (!agent) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const newPublicKey = String(raw.new_public_key ?? raw.publicKey ?? raw.public_key ?? '').trim()
    const rotationProof = String(raw.rotation_proof ?? '').trim()
    const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString()
    const signature = typeof raw.signature === 'string' ? raw.signature : undefined

    if (!newPublicKey) {
      return c.json({ error: 'new_public_key is required', errorCode: 'INVALID_ROTATION' }, 400)
    }

    if (newPublicKey === agent.public_key) {
      return c.json({ error: 'new_public_key must differ from the current key', errorCode: 'NOOP_ROTATION' }, 400)
    }

    const authPayload = buildAuthPayload('keys.rotate', beamId, {
      newPublicKey,
      timestamp,
    })
    if (!canManageKeys(agent, c.req.raw, authPayload, signature, { newPublicKey, rotationProof })) {
      return c.json({ error: 'rotation proof or signature is invalid', errorCode: 'INVALID_ROTATION_PROOF' }, 400)
    }

    try {
      const previousKey = agent.public_key
      const updated = rotateAgentKey(db, beamId, newPublicKey)
      if (!updated) {
        return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
      }

      return c.json({
        beamId,
        rotated: true,
        previousKey,
        agent: serializeAgent(updated, { keys: listAgentKeys(db, beamId) }),
        keyState: getKeyState(db, beamId),
      })
    } catch (error) {
      const response = keyLifecycleErrorResponse(error)
      return c.json({ error: response.error, errorCode: response.errorCode }, response.status)
    }
  })

  router.post('/:beamId/keys/revoke', async (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId') ?? '')
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const agent = getAgent(db, beamId)
    if (!agent) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const publicKey = String(raw.public_key ?? raw.publicKey ?? '').trim()
    const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString()
    const signature = typeof raw.signature === 'string' ? raw.signature : undefined

    if (!publicKey) {
      return c.json({ error: 'public_key is required', errorCode: 'INVALID_REVOCATION' }, 400)
    }

    const authPayload = buildAuthPayload('keys.revoke', beamId, {
      publicKey,
      timestamp,
    })
    if (!canManageKeys(agent, c.req.raw, authPayload, signature)) {
      return c.json({ error: 'signature is invalid', errorCode: 'INVALID_SIGNATURE' }, 400)
    }

    try {
      const updated = revokeAgentKey(db, beamId, publicKey)
      if (!updated) {
        return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
      }

      const keys = listAgentKeys(db, beamId)
      const revokedKey = keys.find((row) => row.public_key === publicKey) ?? null
      return c.json({
        beamId,
        revoked: true,
        revokedKey: revokedKey ? serializeAgentKey(revokedKey) : null,
        agent: serializeAgent(updated, { keys }),
        keyState: serializeAgentKeyState(keys),
      })
    } catch (error) {
      const response = keyLifecycleErrorResponse(error)
      return c.json({ error: response.error, errorCode: response.errorCode }, response.status)
    }
  })

  return router
}

export function revokedKeysRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/revoked', (c) => {
    const rows = listRevokedAgentKeys(db)
    return c.json({
      keys: rows.map((row: AgentKeyRow) => serializeAgentKey(row)),
      total: rows.length,
    })
  })

  return router
}
