import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentKeyRow, AgentRow } from '../types.js'
import { getAgent, listRevokedAgentKeys, rotateAgentKey } from '../db.js'
import { verifySignedPayload } from '../crypto.js'

const BEAM_ID_RE = /^[a-z0-9_-]+@[a-z0-9_-]+\.beam\.directory$/

function serializeAgent(row: AgentRow): object {
  return {
    ...row,
    capabilities: JSON.parse(row.capabilities) as string[],
    verified: row.verified === 1 || row.verification_tier === 'verified',
    flagged: row.flagged === 1,
    verificationTier: row.verification_tier,
  }
}

function serializeKey(row: AgentKeyRow): object {
  return {
    id: row.id,
    beamId: row.beam_id,
    publicKey: row.public_key,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }
}

export function agentKeysRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:beamId/keys/rotate', async (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
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
    const newPublicKey = String(raw.new_public_key ?? '').trim()
    const rotationProof = String(raw.rotation_proof ?? '').trim()

    if (!newPublicKey || !rotationProof) {
      return c.json({ error: 'new_public_key and rotation_proof are required', errorCode: 'INVALID_ROTATION' }, 400)
    }

    if (newPublicKey === agent.public_key) {
      return c.json({ error: 'new_public_key must differ from the current key', errorCode: 'NOOP_ROTATION' }, 400)
    }

    if (!verifySignedPayload(agent.public_key, newPublicKey, rotationProof)) {
      return c.json({ error: 'rotation_proof is invalid', errorCode: 'INVALID_ROTATION_PROOF' }, 400)
    }

    const updated = rotateAgentKey(db, beamId, newPublicKey)
    if (!updated) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    return c.json({
      beamId,
      rotated: true,
      agent: serializeAgent(updated),
    })
  })

  return router
}

export function revokedKeysRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/revoked', (c) => {
    const rows = listRevokedAgentKeys(db)
    return c.json({
      keys: rows.map(serializeKey),
      total: rows.length,
    })
  })

  return router
}
