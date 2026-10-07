import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import { hashApiKey } from '../api-key.js'
import { getOrg, logAuditEvent } from '../db.js'
import { isEd25519Spki } from '../key-validation.js'
import { getKycAdapter } from '../trust/kyc.js'
import { parseScopeGrant, type ScopeGrant } from '../trust/scopes.js'
import {
  createInvitationToken,
  createPersonInvitation,
  findPersonByExternalId,
  getInvitationByHash,
  getPerson,
  getPersonByEmail,
  hashInvitationToken,
  insertPerson,
  listPeople,
  markInvitationAccepted,
  offboardPerson,
  serializePerson,
  setPersonKyc,
  supervisorCreatesCycle,
  updatePersonRecord,
  type PersonRow,
} from '../trust/person-store.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ROLE_MAX = 80
const IMPORT_LIMIT = 500

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function readRole(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const role = value.trim()
  return role.length >= 1 && role.length <= ROLE_MAX ? role : null
}

function orgApiKey(c: Context, db: Database): { name: string; org: NonNullable<ReturnType<typeof getOrg>> } | Response {
  const name = (c.req.param('name') ?? '').trim().toLowerCase()
  const org = getOrg(db, name)
  if (!org) {
    return c.json({ error: `Organization ${name} not found`, errorCode: 'NOT_FOUND' }, 404)
  }
  const supplied = c.req.header('x-api-key')?.trim()
    ?? (c.req.header('authorization')?.toLowerCase().startsWith('bearer ')
      ? c.req.header('authorization')!.slice(7).trim()
      : '')
  if (!supplied) {
    return c.json({ error: 'Missing API key', errorCode: 'UNAUTHORIZED' }, 401)
  }
  const suppliedHash = hashApiKey(supplied)
  const left = Buffer.from(suppliedHash)
  const right = Buffer.from(org.api_key_hash)
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return c.json({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }, 401)
  }
  return { name, org }
}

function activeSupervisor(db: Database, orgName: string, supervisorId: string | null, personId: string | null): PersonRow | null | Response {
  if (!supervisorId) return null
  const supervisor = getPerson(db, supervisorId)
  if (!supervisor || supervisor.org_name !== orgName || supervisor.status !== 'active') {
    return new Response(JSON.stringify({
      error: 'supervisorPersonId must be an active person in this organization',
      errorCode: 'INVALID_SUPERVISOR',
    }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  if (supervisorCreatesCycle(db, personId, supervisor.id)) {
    return new Response(JSON.stringify({
      error: 'supervisorPersonId would create a cycle',
      errorCode: 'SUPERVISOR_CYCLE',
    }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  return supervisor
}

function rightsFrom(raw: Record<string, unknown>, fallback: ScopeGrant): ScopeGrant | Response {
  if (!('rights' in raw)) return fallback
  const parsed = parseScopeGrant(raw['rights'])
  if (!parsed) {
    return new Response(JSON.stringify({
      error: 'rights must be a scope object with known actions',
      errorCode: 'INVALID_RIGHTS',
    }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  return parsed
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

export function peopleRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:name/people', async (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const created = createOrgPerson(db, owned.name, raw, null)
    if (created instanceof Response) return created
    logAuditEvent(db, {
      action: 'org.person.created',
      actor: `org:${owned.name}`,
      target: created.id,
      details: { email: created.email, role: created.role, supervisorPersonId: created.supervisor_person_id },
    })
    return c.json({ person: serializePerson(created) }, 201)
  })

  router.get('/:name/people', (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const people = listPeople(db, owned.name)
    return c.json({ people: people.map(serializePerson), total: people.length })
  })

  router.post('/:name/people/invitations', async (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const email = typeof raw['email'] === 'string' ? normalizeEmail(raw['email']) : ''
    const role = readRole(raw['role'])
    const rights = rightsFrom(raw, { actions: [] })
    if (rights instanceof Response) return rights
    const supervisorId = typeof raw['supervisorPersonId'] === 'string' ? raw['supervisorPersonId'].trim() : ''
    const supervisor = activeSupervisor(db, owned.name, supervisorId || null, null)
    if (supervisor instanceof Response) return supervisor
    if (!EMAIL_RE.test(email) || !role) {
      return c.json({ error: 'email and role are required', errorCode: 'INVALID_INVITATION' }, 400)
    }
    if (getPersonByEmail(db, owned.name, email)) {
      return c.json({ error: 'A person with this email already exists', errorCode: 'PERSON_EXISTS' }, 409)
    }
    const token = createInvitationToken()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const invitation = createPersonInvitation(db, {
      orgName: owned.name,
      email,
      role,
      supervisorPersonId: supervisor?.id ?? null,
      rights,
      tokenHash: hashInvitationToken(token),
      expiresAt,
    })
    logAuditEvent(db, {
      action: 'org.person.invited',
      actor: `org:${owned.name}`,
      target: invitation.id,
      details: { email, role, supervisorPersonId: invitation.supervisor_person_id },
    })
    c.header('Cache-Control', 'no-store')
    return c.json({
      invitationId: invitation.id,
      email,
      role,
      supervisorPersonId: invitation.supervisor_person_id,
      expiresAt,
      token,
    }, 201)
  })

  router.post('/:name/people/import', async (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const source = raw['source'] === 'personio' || raw['source'] === 'entra' ? raw['source'] : null
    const people = Array.isArray(raw['people']) ? raw['people'] : null
    if (!source || !people || people.length === 0 || people.length > IMPORT_LIMIT) {
      return c.json({
        error: 'source must be personio or entra and people must contain 1 to 500 records',
        errorCode: 'INVALID_IMPORT',
      }, 400)
    }

    const prepared: Array<{
      externalId: string
      email: string
      displayName: string
      role: string
      supervisorExternalId: string | null
      status: 'active' | 'offboarded'
      rights: ScopeGrant
    }> = []
    for (const entry of people) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return c.json({ error: 'each person must be an object', errorCode: 'INVALID_IMPORT' }, 400)
      }
      const record = entry as Record<string, unknown>
      const externalId = typeof record['externalId'] === 'string' ? record['externalId'].trim() : ''
      const email = typeof record['email'] === 'string' ? normalizeEmail(record['email']) : ''
      const displayName = typeof record['displayName'] === 'string' ? record['displayName'].trim() : ''
      const role = readRole(record['role'])
      const status = record['status'] === 'offboarded' ? 'offboarded' : record['status'] === 'active' ? 'active' : null
      const rights = rightsFrom(record, { actions: [] })
      if (rights instanceof Response) return rights
      const supervisorExternalId = typeof record['supervisorExternalId'] === 'string' && record['supervisorExternalId'].trim()
        ? record['supervisorExternalId'].trim()
        : null
      if (!externalId || externalId.length > 200 || !EMAIL_RE.test(email) || displayName.length < 1 || !role || !status) {
        return c.json({ error: 'externalId, email, displayName, role and status are required', errorCode: 'INVALID_IMPORT' }, 400)
      }
      prepared.push({ externalId, email, displayName, role, supervisorExternalId, status, rights })
    }

    const result = db.transaction(() => {
      const ids = new Map<string, string>()
      let offboarded = 0
      for (const record of prepared) {
        const byExternal = findPersonByExternalId(db, owned.name, source, record.externalId)
        const byEmail = getPersonByEmail(db, owned.name, record.email)
        if (byExternal && byEmail && byExternal.id !== byEmail.id) {
          throw new ImportError(`email ${record.email} belongs to a different person than ${record.externalId}`)
        }
        const existing = byExternal ?? byEmail
        if (existing) {
          if (
            existing.external_id
            && existing.external_source
            && (existing.external_source !== source || existing.external_id !== record.externalId)
          ) {
            throw new ImportError(`email ${record.email} is already linked to ${existing.external_source}:${existing.external_id}`)
          }
          if (existing.status === 'offboarded' && record.status === 'active') {
            ids.set(record.externalId, existing.id)
            continue
          }
          if (!existing.external_id) {
            db.prepare('UPDATE persons SET external_source = ?, external_id = ? WHERE id = ?')
              .run(source, record.externalId, existing.id)
          }
          updatePersonRecord(db, existing.id, {
            email: record.email,
            displayName: record.displayName,
            role: record.role,
            supervisorPersonId: existing.supervisor_person_id,
            rights: record.rights,
          })
          ids.set(record.externalId, existing.id)
        } else {
          const created = insertPerson(db, {
            orgName: owned.name,
            email: record.email,
            displayName: record.displayName,
            role: record.role,
            supervisorPersonId: null,
            publicKey: null,
            rights: record.rights,
            externalSource: source,
            externalId: record.externalId,
            status: 'active',
          })
          ids.set(record.externalId, created.id)
        }
      }
      for (const record of prepared) {
        const personId = ids.get(record.externalId)
        if (!personId) continue
        const person = getPerson(db, personId)
        if (!person) continue
        if (person.status === 'offboarded' && record.status === 'active') {
          continue
        }
        const supervisorId = record.supervisorExternalId ? ids.get(record.supervisorExternalId) ?? findPersonByExternalId(db, owned.name, source, record.supervisorExternalId)?.id ?? null : null
        if (record.supervisorExternalId) {
          const incoming = prepared.find((item) => item.externalId === record.supervisorExternalId)
          const supervisor = supervisorId ? getPerson(db, supervisorId) : null
          if (!supervisorId || incoming?.status === 'offboarded' || !supervisor || supervisor.org_name !== owned.name || supervisor.status !== 'active') {
            throw new ImportError(`Supervisor ${record.supervisorExternalId} is not an active person`)
          }
        }
        if (supervisorCreatesCycle(db, personId, supervisorId)) {
          throw new ImportError(`Supervisor cycle at ${record.externalId}`)
        }
        updatePersonRecord(db, personId, {
          email: record.email,
          displayName: record.displayName,
          role: record.role,
          supervisorPersonId: supervisorId,
          rights: record.rights,
        })
        if (record.status === 'offboarded') {
          offboardPerson(db, getPerson(db, personId) as PersonRow)
          offboarded += 1
        }
      }
      return { imported: prepared.length, offboarded }
    })

    try {
      const summary = result()
      logAuditEvent(db, {
        action: 'org.person.imported',
        actor: `org:${owned.name}`,
        target: owned.name,
        details: { source, ...summary },
      })
      return c.json({ source, ...summary })
    } catch (error) {
      if (error instanceof ImportError) {
        return c.json({ error: error.message, errorCode: 'INVALID_IMPORT' }, 400)
      }
      const message = error instanceof Error ? error.message : 'Import failed'
      if (message.includes('UNIQUE')) {
        return c.json({ error: 'Import collides with an existing email', errorCode: 'PERSON_EXISTS' }, 409)
      }
      throw error
    }
  })

  router.patch('/:name/people/:id', async (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const person = getPerson(db, c.req.param('id'))
    if (!person || person.org_name !== owned.name) {
      return c.json({ error: 'Person not found', errorCode: 'NOT_FOUND' }, 404)
    }
    if (person.status !== 'active') {
      return c.json({ error: 'Offboarded people cannot change keys or rights', errorCode: 'PERSON_OFFBOARDED' }, 409)
    }
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const currentRights = parseScopeGrant(JSON.parse(person.rights_json) as unknown)
    if (!currentRights) {
      return c.json({ error: 'Stored rights are invalid', errorCode: 'INVALID_RIGHTS' }, 500)
    }
    const rights = rightsFrom(raw, currentRights)
    if (rights instanceof Response) return rights
    let publicKey = person.public_key
    if ('publicKey' in raw) {
      const supplied = typeof raw['publicKey'] === 'string' ? raw['publicKey'].trim() : ''
      if (!isEd25519Spki(supplied)) {
        return c.json({ error: 'publicKey must be an Ed25519 SPKI key', errorCode: 'PUBLIC_KEY_REQUIRED' }, 400)
      }
      publicKey = supplied
    }
    const updated = updatePersonRecord(db, person.id, {
      email: person.email,
      displayName: person.display_name,
      role: person.role,
      supervisorPersonId: person.supervisor_person_id,
      rights,
      publicKey,
    })
    logAuditEvent(db, {
      action: 'org.person.updated',
      actor: `org:${owned.name}`,
      target: person.id,
      details: { rightsChanged: JSON.stringify(rights) !== person.rights_json, publicKeyChanged: publicKey !== person.public_key },
    })
    return c.json({ person: serializePerson(updated as PersonRow) })
  })

  router.post('/:name/people/:id/offboard', (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const person = getPerson(db, c.req.param('id'))
    if (!person || person.org_name !== owned.name) {
      return c.json({ error: 'Person not found', errorCode: 'NOT_FOUND' }, 404)
    }
    const result = db.transaction(() => offboardPerson(db, person))()
    logAuditEvent(db, {
      action: 'org.person.offboarded',
      actor: `org:${owned.name}`,
      target: person.id,
      details: { suspendedAgents: result.suspendedAgents, revokedMandates: result.revokedMandates, email: person.email },
    })
    return c.json({
      person: serializePerson(result.person),
      suspendedAgents: result.suspendedAgents,
      revokedMandates: result.revokedMandates,
    })
  })

  router.post('/:name/people/:id/kyc', async (c) => {
    const owned = orgApiKey(c, db)
    if (owned instanceof Response) return owned
    const person = getPerson(db, c.req.param('id'))
    if (!person || person.org_name !== owned.name) {
      return c.json({ error: 'Person not found', errorCode: 'NOT_FOUND' }, 404)
    }
    if (person.status !== 'active') {
      return c.json({ error: 'Offboarded people cannot start KYC', errorCode: 'PERSON_OFFBOARDED' }, 409)
    }
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const providerId = typeof raw['provider'] === 'string' ? raw['provider'] : ''
    const adapter = getKycAdapter(providerId)
    if (!adapter) {
      return c.json({ error: 'provider must be manual', errorCode: 'KYC_PROVIDER_UNKNOWN' }, 400)
    }
    const request = adapter.request({ personId: person.id, email: person.email })
    const updated = setPersonKyc(db, person.id, {
      status: request.status,
      provider: request.provider,
      reference: request.reference,
    })
    logAuditEvent(db, {
      action: 'org.person.kyc_requested',
      actor: `org:${owned.name}`,
      target: person.id,
      details: { provider: request.provider, status: request.status, reference: request.reference },
    })
    return c.json({ person: updated ? serializePerson(updated) : null })
  })

  return router
}

export function peopleInvitationRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/invitations/accept', async (c) => {
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const token = typeof raw['token'] === 'string' ? raw['token'].trim() : ''
    const displayName = typeof raw['displayName'] === 'string' ? raw['displayName'].trim() : ''
    const publicKey = typeof raw['publicKey'] === 'string' ? raw['publicKey'].trim() : ''
    if (!token || displayName.length < 1 || !isEd25519Spki(publicKey)) {
      return c.json({ error: 'token, displayName and publicKey are required', errorCode: 'INVALID_INVITATION' }, 400)
    }
    const invitation = getInvitationByHash(db, hashInvitationToken(token))
    if (!invitation || invitation.accepted_at || Date.parse(invitation.expires_at) <= Date.now()) {
      return c.json({ error: 'Invitation is not open', errorCode: 'INVITATION_CLOSED' }, 410)
    }
    if (getPersonByEmail(db, invitation.org_name, invitation.email)) {
      return c.json({ error: 'A person with this email already exists', errorCode: 'PERSON_EXISTS' }, 409)
    }
    const rights = parseScopeGrant(JSON.parse(invitation.rights_json) as unknown)
    if (!rights) {
      return c.json({ error: 'Invitation rights are invalid', errorCode: 'INVALID_RIGHTS' }, 500)
    }
    const person = db.transaction(() => {
      const created = insertPerson(db, {
        orgName: invitation.org_name,
        email: invitation.email,
        displayName,
        role: invitation.role,
        supervisorPersonId: invitation.supervisor_person_id,
        publicKey,
        rights,
      })
      markInvitationAccepted(db, invitation.id, new Date().toISOString())
      return created
    })()
    logAuditEvent(db, {
      action: 'org.person.invitation_accepted',
      actor: person.id,
      target: invitation.id,
      details: { org: invitation.org_name, email: invitation.email },
    })
    return c.json({ person: serializePerson(person) }, 201)
  })

  return router
}

export function peopleAdminRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:id/kyc', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) return auth
    const person = getPerson(db, c.req.param('id'))
    if (!person) {
      return c.json({ error: 'Person not found', errorCode: 'NOT_FOUND' }, 404)
    }
    const raw = await readObject(c)
    if (raw instanceof Response) return raw
    const status = raw['status'] === 'verified' || raw['status'] === 'rejected' ? raw['status'] : null
    const note = typeof raw['note'] === 'string' ? raw['note'].trim() : ''
    if (!status || note.length < 3) {
      return c.json({ error: 'status must be verified or rejected, with a note', errorCode: 'INVALID_KYC_REVIEW' }, 400)
    }
    const updated = setPersonKyc(db, person.id, {
      status,
      provider: person.kyc_provider ?? 'manual',
      reference: person.kyc_reference,
    })
    logAuditEvent(db, {
      action: 'org.person.kyc_reviewed',
      actor: auth.session.email,
      target: person.id,
      details: { status, note, provider: person.kyc_provider ?? 'manual' },
    })
    return c.json({ person: updated ? serializePerson(updated) : null })
  })

  return router
}

function createOrgPerson(
  db: Database,
  orgName: string,
  raw: Record<string, unknown>,
  external: { source: 'personio' | 'entra'; externalId: string } | null,
): PersonRow | Response {
  const email = typeof raw['email'] === 'string' ? normalizeEmail(raw['email']) : ''
  const displayName = typeof raw['displayName'] === 'string' ? raw['displayName'].trim() : ''
  const role = readRole(raw['role'])
  const publicKey = typeof raw['publicKey'] === 'string' ? raw['publicKey'].trim() : ''
  const rights = rightsFrom(raw, { actions: [] })
  if (rights instanceof Response) return rights
  const supervisorId = typeof raw['supervisorPersonId'] === 'string' ? raw['supervisorPersonId'].trim() : ''
  const supervisor = activeSupervisor(db, orgName, supervisorId || null, null)
  if (supervisor instanceof Response) return supervisor
  if (!EMAIL_RE.test(email) || displayName.length < 1 || !role || !isEd25519Spki(publicKey)) {
    return new Response(JSON.stringify({
      error: 'email, displayName, role and a client-generated publicKey are required',
      errorCode: 'INVALID_PERSON',
    }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  if (getPersonByEmail(db, orgName, email)) {
    return new Response(JSON.stringify({
      error: 'A person with this email already exists',
      errorCode: 'PERSON_EXISTS',
    }), { status: 409, headers: { 'content-type': 'application/json' } })
  }
  return insertPerson(db, {
    orgName,
    email,
    displayName,
    role,
    supervisorPersonId: supervisor?.id ?? null,
    publicKey,
    rights,
    externalSource: external?.source ?? null,
    externalId: external?.externalId ?? null,
  })
}

class ImportError extends Error {}
