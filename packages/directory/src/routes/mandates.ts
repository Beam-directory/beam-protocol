import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import { hashApiKey } from '../api-key.js'
import { canonicalizeJson, verifyPayload } from '../crypto.js'
import { getAgent, getOrg, logAuditEvent } from '../db.js'
import { IssuerKeyRequiredError } from '../issuer.js'
import {
  getAcceptanceRule,
  saveAcceptanceRule,
  serializeAcceptanceRule,
} from '../trust/acceptance.js'
import { buildTrustAssertion } from '../trust/assertion.js'
import {
  getMandateByJti,
  hashCanonical,
  insertMandate,
  MandateError,
  revokeMandate,
  serializeMandate,
} from '../trust/mandate-store.js'
import { registrableDomain } from '../trust/org-domain.js'
import { getPerson } from '../trust/person-store.js'
import { parseScopeGrant, scopeWithin, SCOPE_ACTIONS, type ScopeAction } from '../trust/scopes.js'
import { BEAM_ID_RE } from '../validation.js'

const JTI_RE = /^[A-Za-z0-9_-]{8,80}$/
const INTENT_SCOPE_RE = /^[a-z][a-z0-9._-]{0,63}$/
const MAX_MANDATE_MS = 366 * 24 * 60 * 60 * 1000

function orgKeyMatches(db: Database, orgName: string | null, request: Request): boolean {
  if (!orgName) return false
  const org = getOrg(db, orgName)
  const supplied = request.headers.get('x-api-key')?.trim()
    ?? (request.headers.get('authorization')?.toLowerCase().startsWith('bearer ')
      ? request.headers.get('authorization')!.slice(7).trim()
      : '')
  if (!org || !supplied.startsWith('beam_org_')) return false
  const left = Buffer.from(hashApiKey(supplied))
  const right = Buffer.from(org.api_key_hash)
  return left.length === right.length && timingSafeEqual(left, right)
}

function beamIdFrom(c: Context): string | null {
  const beamId = decodeURIComponent(c.req.param('beamId') ?? '')
  return BEAM_ID_RE.test(beamId) ? beamId : null
}

async function readObject(c: Context): Promise<Record<string, unknown> | Response> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Body must be a JSON object', errorCode: 'INVALID_BODY' }, 400)
  }
  return body as Record<string, unknown>
}

function stringList(
  value: unknown,
  accept: (entry: string) => string | null,
): string[] | null {
  if (!Array.isArray(value) || value.length > 50) return null
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return null
    const normalized = accept(entry)
    if (!normalized || out.includes(normalized)) return null
    out.push(normalized)
  }
  return out
}

export function mandatesRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:beamId/mandates', async (c) => {
    const beamId = beamIdFrom(c)
    if (!beamId) return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    const agent = getAgent(db, beamId)
    if (!agent) return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    const person = agent.responsible_person_id ? getPerson(db, agent.responsible_person_id) : null
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const jti = typeof raw['jti'] === 'string' ? raw['jti'].trim() : ''
    const signature = typeof raw['signature'] === 'string' ? raw['signature'].trim() : ''
    const expiresAt = typeof raw['expiresAt'] === 'string' ? raw['expiresAt'].trim() : ''
    const expiresMs = new Date(expiresAt).getTime()
    const scopes = parseScopeGrant(raw['scopes'])
    if (!person || !JTI_RE.test(jti) || !signature || !scopes || !Number.isFinite(expiresMs)) {
      return c.json({ error: 'jti, scopes, expiresAt, signature, and a responsible person are required', errorCode: 'INVALID_MANDATE' }, 400)
    }

    const escalation = raw['escalationPersonId']
    const escalationPersonId = escalation === null || escalation === undefined
      ? null
      : typeof escalation === 'string' ? escalation.trim() : ''
    if (escalationPersonId === '') {
      return c.json({ error: 'escalationPersonId must be the supervisor or null', errorCode: 'INVALID_ESCALATION' }, 400)
    }
    const payload = {
      type: 'mandate' as const,
      jti,
      version: 1 as const,
      personId: person.id,
      agentBeamId: beamId,
      org: agent.org,
      scopes,
      expiresAt,
      escalationPersonId,
    }
    const payloadHash = hashCanonical(canonicalizeJson(payload))
    if (db.prepare('SELECT id FROM mandates WHERE payload_hash = ?').get(payloadHash)) {
      return c.json({ error: 'This signed mandate was already recorded and cannot be created again', errorCode: 'MANDATE_REPLAY' }, 409)
    }
    if (!person.public_key || !verifyPayload(payload, signature, person.public_key)) {
      return c.json({ error: 'signature is invalid', errorCode: 'INVALID_SIGNATURE' }, 400)
    }
    if (person.status !== 'active' || person.org_name !== agent.org || agent.suspended_at) {
      return c.json({ error: 'An active responsible person is required', errorCode: 'RESPONSIBLE_PERSON_REQUIRED' }, 400)
    }
    const rights = parseScopeGrant(JSON.parse(person.rights_json) as unknown)
    if (!rights) {
      return c.json({ error: 'jti, scopes, expiresAt, and signature are required', errorCode: 'INVALID_MANDATE' }, 400)
    }
    if (expiresMs <= Date.now() || expiresMs > Date.now() + MAX_MANDATE_MS) {
      return c.json({ error: 'expiresAt must be in the future and within 366 days', errorCode: 'MANDATE_EXPIRED' }, 400)
    }
    if (!scopeWithin(scopes, rights)) {
      return c.json({ error: 'Mandate scopes exceed the person rights', errorCode: 'MANDATE_EXCEEDS_RIGHTS' }, 400)
    }
    if ((person.supervisor_person_id ?? null) !== escalationPersonId) {
      return c.json({ error: 'escalationPersonId must be the person supervisor', errorCode: 'INVALID_ESCALATION' }, 400)
    }

    try {
      const mandate = insertMandate(db, {
        jti,
        personId: person.id,
        agentBeamId: beamId,
        orgName: agent.org ?? person.org_name,
        scopes,
        expiresAt,
        escalationPersonId,
        signature,
        payloadHash,
      })
      logAuditEvent(db, {
        action: 'mandate.created',
        actor: `person:${person.id}`,
        target: beamId,
        details: { jti, scopes },
      })
      return c.json({ mandate: serializeMandate(mandate) }, 201)
    } catch (error) {
      if (error instanceof MandateError) {
        return c.json({ error: error.message, errorCode: error.code }, 409)
      }
      throw error
    }
  })

  router.post('/:beamId/mandates/:jti/revoke', async (c) => {
    const beamId = beamIdFrom(c)
    const jti = c.req.param('jti') ?? ''
    if (!beamId || !JTI_RE.test(jti)) {
      return c.json({ error: 'Invalid mandate identifier', errorCode: 'INVALID_MANDATE' }, 400)
    }
    const mandate = getMandateByJti(db, jti)
    if (!mandate || mandate.agent_beam_id !== beamId) {
      return c.json({ error: 'Mandate not found', errorCode: 'NOT_FOUND' }, 404)
    }
    const person = getPerson(db, mandate.person_id)
    if (!person?.public_key) {
      return c.json({ error: 'Responsible person has no signing key', errorCode: 'INVALID_SIGNATURE' }, 400)
    }
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const signature = typeof raw['signature'] === 'string' ? raw['signature'].trim() : ''
    const payload = { type: 'mandate-revoke' as const, jti, personId: person.id }
    if (!signature || !verifyPayload(payload, signature, person.public_key)) {
      return c.json({ error: 'signature is invalid', errorCode: 'INVALID_SIGNATURE' }, 400)
    }
    const revoked = revokeMandate(db, jti)
    logAuditEvent(db, {
      action: 'mandate.revoked',
      actor: `person:${person.id}`,
      target: beamId,
      details: { jti },
    })
    return c.json({ mandate: revoked ? serializeMandate(revoked) : null })
  })

  router.get('/:beamId/trust-assertion', (c) => {
    const beamId = beamIdFrom(c)
    if (!beamId) return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    if (!getAgent(db, beamId)) return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    try {
      return c.json(buildTrustAssertion(db, beamId))
    } catch (error) {
      if (error instanceof IssuerKeyRequiredError) {
        return c.json({ error: error.message, errorCode: error.code }, 503)
      }
      throw error
    }
  })

  router.put('/:beamId/acceptance', async (c) => {
    const beamId = beamIdFrom(c)
    if (!beamId) return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    const agent = getAgent(db, beamId)
    if (!agent) return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    const raw = await readObject(c)
    if (raw instanceof Response) return raw

    const allowedOrgDomains = stringList(raw['allowedOrgDomains'], (entry) => registrableDomain(entry))
    const allowedScopes = stringList(raw['allowedScopes'], (entry) => {
      const trimmed = entry.trim()
      if (SCOPE_ACTIONS.includes(trimmed as ScopeAction) || INTENT_SCOPE_RE.test(trimmed)) return trimmed
      return null
    })
    const allowedAgents = stringList(raw['allowedAgents'], (entry) => BEAM_ID_RE.test(entry.trim()) ? entry.trim() : null)
    if (!allowedOrgDomains || !allowedScopes || !allowedAgents || typeof raw['requireKnownContact'] !== 'boolean') {
      return c.json({
        error: 'allowedOrgDomains, allowedScopes, allowedAgents, and requireKnownContact are required',
        errorCode: 'INVALID_ACCEPTANCE',
      }, 400)
    }

    const payload = {
      type: 'acceptance' as const,
      beamId,
      allowedOrgDomains,
      allowedScopes,
      allowedAgents,
      requireKnownContact: raw['requireKnownContact'],
    }
    const signature = typeof raw['signature'] === 'string' ? raw['signature'].trim() : ''
    const signed = signature.length > 0 && verifyPayload(payload, signature, agent.public_key)
    const orgAuthorized = orgKeyMatches(db, agent.org, c.req.raw)
    if (!signed && !orgAuthorized) {
      return c.json({ error: 'Organization API key or current agent signature is required', errorCode: 'INVALID_SIGNATURE' }, 400)
    }

    const rule = saveAcceptanceRule(db, {
      ownerBeamId: beamId,
      allowedOrgDomains,
      allowedScopes,
      allowedAgents,
      requireKnownContact: raw['requireKnownContact'],
    })
    logAuditEvent(db, {
      action: 'acceptance.updated',
      actor: orgAuthorized ? `org:${agent.org}` : `agent:${beamId}`,
      target: beamId,
      details: payload,
    })
    return c.json({ acceptance: serializeAcceptanceRule(rule) })
  })

  router.get('/:beamId/acceptance', (c) => {
    const beamId = beamIdFrom(c)
    if (!beamId) return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    const agent = getAgent(db, beamId)
    if (!agent) return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    if (!orgKeyMatches(db, agent.org, c.req.raw)) {
      return c.json({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }, 401)
    }
    const rule = getAcceptanceRule(db, beamId)
    return c.json({ acceptance: rule ? serializeAcceptanceRule(rule) : null })
  })

  return router
}
