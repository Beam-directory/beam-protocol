import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import { createAgentApiKey, createPersonApiKey, getSuppliedApiKey, hashApiKey, isPersonApiKey } from '../api-key.js'
import { getAgent, logAuditEvent, registerAgent } from '../db.js'
import { toBeamDID } from '../did.js'
import { isEd25519Spki } from '../key-validation.js'
import {
  applyStripeIdentityEvent,
  beginStripeIdentitySession,
  constructStripeIdentityEvent,
  stripeIdentityEnabled,
} from '../trust/stripe-identity.js'
import {
  getIndividualByEmail,
  getIndividualByHandle,
  getPersonByApiKeyHash,
  individualBeamId,
  insertIndividualPerson,
  serializePerson,
  setAgentResponsiblePerson,
  updatePersonRecord,
  type PersonRow,
} from '../trust/person-store.js'
import { parseScopeGrant, type ScopeGrant } from '../trust/scopes.js'
import type { RegisterRequest } from '../types.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Same un-namespaced local part as POST /identity-claims. Address is `{handle}@beam.directory`. */
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/
const AGENT_NAME_RE = /^[a-z0-9_-]+$/

const INDIVIDUAL_RIGHTS: ScopeGrant = {
  actions: ['read', 'schedule.commit', 'file.send', 'order'],
  order: { maxAmount: '100000.00', currency: 'EUR' },
}

function authenticateIndividual(db: Database, request: Request): PersonRow | null {
  const supplied = getSuppliedApiKey({ headers: request.headers })
  if (!isPersonApiKey(supplied)) return null
  const person = getPersonByApiKeyHash(db, hashApiKey(supplied))
  if (!person || person.subject_kind !== 'individual' || person.status !== 'active') return null
  return person
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

function requireIndividual(c: Context, db: Database): PersonRow | Response {
  const person = authenticateIndividual(db, c.req.raw)
  if (!person) return c.json({ error: 'A person API key is required', errorCode: 'UNAUTHORIZED' }, 401)
  return person
}

export function individualRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/individual/provider', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({
      provider: 'stripe_identity',
      enabled: stripeIdentityEnabled(),
    })
  })

  router.post('/individual', async (c) => {
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const email = typeof raw['email'] === 'string' ? raw['email'].trim().toLowerCase() : ''
    const handle = typeof raw['handle'] === 'string' ? raw['handle'].trim().toLowerCase() : ''
    const displayName = typeof raw['displayName'] === 'string' ? raw['displayName'].trim() : ''
    const publicKey = typeof raw['publicKey'] === 'string' ? raw['publicKey'].trim() : ''
    if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email address', errorCode: 'INVALID_EMAIL' }, 400)
    if (!HANDLE_RE.test(handle)) {
      return c.json({
        error: 'Beam name must be 3–32 characters and use lowercase letters, numbers, hyphens, or underscores',
        errorCode: 'INVALID_HANDLE',
      }, 400)
    }
    if (displayName.length < 2 || displayName.length > 80) {
      return c.json({ error: 'Display name must be 2–80 characters', errorCode: 'INVALID_DISPLAY_NAME' }, 400)
    }
    if (!isEd25519Spki(publicKey)) {
      return c.json({ error: 'A client-generated Ed25519 publicKey is required', errorCode: 'INVALID_PUBLIC_KEY' }, 400)
    }
    const beamId = individualBeamId(handle)
    if (getIndividualByHandle(db, handle) || getAgent(db, beamId)) {
      return c.json({ error: 'This Beam name is not available', errorCode: 'HANDLE_UNAVAILABLE' }, 409)
    }
    if (getIndividualByEmail(db, email)) {
      return c.json({ error: 'A private person with this email already exists', errorCode: 'EMAIL_IN_USE' }, 409)
    }

    const personApiKey = createPersonApiKey()
    const identityApiKey = createAgentApiKey(beamId)
    try {
      const created = db.transaction(() => {
        const person = insertIndividualPerson(db, {
          email,
          displayName,
          publicKey,
          handle,
          apiKeyHash: hashApiKey(personApiKey),
          rights: INDIVIDUAL_RIGHTS,
        })
        const request: RegisterRequest = {
          beamId,
          org: null,
          personal: true,
          identityKind: 'person',
          displayName,
          capabilities: ['identity.personal'],
          publicKey,
          apiKeyHash: hashApiKey(identityApiKey),
          visibility: 'unlisted',
          description: 'Personal Beam identity',
        }
        const agent = registerAgent(db, request)
        setAgentResponsiblePerson(db, agent.beam_id, person.id)
        return person
      })()
      logAuditEvent(db, {
        action: 'individual.created',
        actor: created.id,
        target: beamId,
        details: { handle },
      })
      c.header('Cache-Control', 'no-store')
      return c.json({
        person: serializePerson(created),
        apiKey: personApiKey,
        identity: {
          beamId,
          did: toBeamDID(beamId),
          apiKey: identityApiKey,
        },
      }, 201)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : ''
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code.includes('CONSTRAINT')) {
        return c.json({ error: 'This Beam name is not available', errorCode: 'HANDLE_UNAVAILABLE' }, 409)
      }
      throw error
    }
  })

  router.get('/individual/me', (c) => {
    const person = requireIndividual(c, db)
    if (person instanceof Response) return person
    c.header('Cache-Control', 'no-store')
    return c.json({ person: serializePerson(person) })
  })

  router.patch('/individual', async (c) => {
    const person = requireIndividual(c, db)
    if (person instanceof Response) return person
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const rights = parseScopeGrant(raw['rights'])
    if (!rights) return c.json({ error: 'rights must be a scope object with known actions', errorCode: 'INVALID_RIGHTS' }, 400)
    const updated = updatePersonRecord(db, person.id, {
      email: person.email,
      displayName: person.display_name,
      role: 'individual',
      supervisorPersonId: null,
      rights,
    })
    return c.json({ person: updated ? serializePerson(updated) : null })
  })

  router.post('/individual/verification-sessions', async (c) => {
    const person = requireIndividual(c, db)
    if (person instanceof Response) return person
    const started = await beginStripeIdentitySession(db, person, `person:${person.id}`)
    if ('error' in started) {
      c.header('Cache-Control', 'no-store')
      return c.json({
        error: started.error,
        errorCode: started.errorCode,
        ...(started.verification ? { verification: started.verification } : {}),
      }, started.status)
    }
    c.header('Cache-Control', 'no-store')
    return c.json({
      person: serializePerson(started.person),
      verification: started.verification,
    }, 201)
  })

  router.post('/individual/agents', async (c) => {
    const person = requireIndividual(c, db)
    if (person instanceof Response) return person
    if (person.kyc_status !== 'verified' || person.kyc_provider !== 'stripe_identity') {
      return c.json({
        error: 'Verify your identity before attaching an agent',
        errorCode: 'INDIVIDUAL_KYC_REQUIRED',
      }, 403)
    }
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const agentName = typeof raw['agentName'] === 'string' ? raw['agentName'].trim().toLowerCase() : ''
    const displayName = typeof raw['displayName'] === 'string' && raw['displayName'].trim()
      ? raw['displayName'].trim()
      : agentName
    const publicKey = typeof raw['publicKey'] === 'string' ? raw['publicKey'].trim() : ''
    const capabilities = Array.isArray(raw['capabilities'])
      ? raw['capabilities'].filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
      : []
    if (!AGENT_NAME_RE.test(agentName) || !/^[a-z0-9_-]+@beam\.directory$/.test(`${agentName}@beam.directory`)) {
      return c.json({ error: 'agentName must be a lowercase Beam local part', errorCode: 'INVALID_AGENT_NAME' }, 400)
    }
    if (agentName === person.beam_handle) {
      return c.json({ error: 'That name is the person’s own Beam address', errorCode: 'HANDLE_UNAVAILABLE' }, 409)
    }
    if (!isEd25519Spki(publicKey)) {
      return c.json({ error: 'publicKey must be a client-generated Ed25519 SPKI key', errorCode: 'PUBLIC_KEY_REQUIRED' }, 400)
    }
    const beamId = `${agentName}@beam.directory`
    if (getAgent(db, beamId)) {
      return c.json({ error: 'Beam ID is already registered', errorCode: 'BEAM_ID_ALREADY_REGISTERED' }, 409)
    }
    const apiKey = createAgentApiKey(beamId)
    const request: RegisterRequest = {
      beamId,
      org: null,
      personal: true,
      identityKind: 'agent',
      displayName,
      capabilities,
      publicKey,
      apiKeyHash: hashApiKey(apiKey),
      visibility: 'unlisted',
    }
    const agent = registerAgent(db, request)
    setAgentResponsiblePerson(db, agent.beam_id, person.id)
    logAuditEvent(db, {
      action: 'individual.agent.created',
      actor: `person:${person.id}`,
      target: beamId,
      details: { capabilities },
    })
    c.header('Cache-Control', 'no-store')
    return c.json({
      beamId,
      did: toBeamDID(beamId),
      displayName: agent.display_name,
      org: null,
      personal: true,
      capabilities,
      publicKey,
      apiKey,
      responsiblePersonId: person.id,
    }, 201)
  })

  return router
}

export function stripeIdentityWebhookRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/identity', async (c) => {
    if (!stripeIdentityEnabled()) {
      return c.json({
        error: 'Stripe Identity is not configured',
        errorCode: 'IDENTITY_PROVIDER_DISABLED',
      }, 503)
    }
    const signature = c.req.header('stripe-signature')?.trim() ?? ''
    if (!signature) return c.json({ error: 'Missing Stripe signature', errorCode: 'INVALID_SIGNATURE' }, 400)
    const rawBody = await c.req.text()
    let event: ReturnType<typeof constructStripeIdentityEvent>
    try {
      event = constructStripeIdentityEvent(rawBody, signature)
    } catch (error) {
      const disabled = error instanceof Error && error.message === 'IDENTITY_PROVIDER_DISABLED'
      if (disabled) {
        return c.json({ error: 'Stripe Identity is not configured', errorCode: 'IDENTITY_PROVIDER_DISABLED' }, 503)
      }
      return c.json({ error: 'Invalid signature', errorCode: 'INVALID_SIGNATURE' }, 400)
    }
    const outcome = await applyStripeIdentityEvent(db, event)
    return c.json({ received: true, duplicate: outcome === 'duplicate' })
  })

  return router
}
