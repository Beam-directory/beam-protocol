import type { Database } from 'better-sqlite3'
import Stripe from 'stripe'
import { logAuditEvent } from '../db.js'
import {
  getPerson,
  markStripeIdentityVerified,
  setPersonKyc,
  type PersonRow,
} from './person-store.js'

export const IDENTITY_SESSION_HOURLY_LIMIT = 3

export type IdentitySessionStatus = 'pending' | 'requires_input' | 'processing' | 'verified' | 'canceled'

export type CreatedIdentitySession = {
  id: string
  clientSecret: string | null
  url: string | null
  status: string
}

export type MinimisedIdentity = {
  givenName: string | null
  familyName: string | null
  issuingCountry: string | null
}

type SessionCreator = (personId: string) => Promise<CreatedIdentitySession>

let sessionCreatorOverride: SessionCreator | null = null

export function setStripeIdentitySessionCreatorForTests(creator: SessionCreator | null): void {
  sessionCreatorOverride = creator
}

export function stripeIdentityEnabled(): boolean {
  return Boolean(process.env['STRIPE_SECRET_KEY']?.trim() && process.env['STRIPE_IDENTITY_WEBHOOK_SECRET']?.trim())
}

function stripe(): Stripe {
  return new Stripe(process.env['STRIPE_SECRET_KEY'] ?? 'sk_test_unconfigured')
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned || cleaned.length > 80) return null
  return cleaned
}

function cleanCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const country = value.trim().toUpperCase()
  return /^[A-Z]{2}$/.test(country) ? country : null
}

/**
 * Keeps first name, last name, and issuing country.
 * Ignores date of birth, ID numbers, addresses, files, and selfies.
 * Names come from verified_outputs. Issuing country is read from verified_outputs
 * when Stripe puts it there, otherwise only document.issuing_country on an
 * expanded verification report.
 */
export function minimiseIdentitySession(session: unknown): MinimisedIdentity {
  const record = session && typeof session === 'object' ? session as Record<string, unknown> : {}
  const outputs = record['verified_outputs'] && typeof record['verified_outputs'] === 'object'
    ? record['verified_outputs'] as Record<string, unknown>
    : {}
  const report = record['last_verification_report']
  const document = report && typeof report === 'object'
    ? (report as Record<string, unknown>)['document']
    : null
  const reportCountry = document && typeof document === 'object'
    ? (document as Record<string, unknown>)['issuing_country']
    : null
  return {
    givenName: cleanName(outputs['first_name']),
    familyName: cleanName(outputs['last_name']),
    issuingCountry: cleanCountry(outputs['issuing_country']) ?? cleanCountry(reportCountry),
  }
}

async function createDocumentSession(personId: string): Promise<CreatedIdentitySession> {
  if (sessionCreatorOverride) return sessionCreatorOverride(personId)
  const session = await stripe().identity.verificationSessions.create({
    type: 'document',
    options: { document: { require_matching_selfie: true } },
    metadata: { person_id: personId },
    client_reference_id: personId,
  })
  return {
    id: session.id,
    clientSecret: session.client_secret,
    url: session.url,
    status: session.status ?? 'requires_input',
  }
}

async function retrieveDocumentSession(sessionId: string): Promise<CreatedIdentitySession | null> {
  if (sessionCreatorOverride) return null
  const session = await stripe().identity.verificationSessions.retrieve(sessionId)
  return {
    id: session.id,
    clientSecret: session.client_secret,
    url: session.url,
    status: session.status ?? 'requires_input',
  }
}

export type KycSessionRow = {
  id: string
  person_id: string
  provider: string
  status: IdentitySessionStatus
  created_at: string
  updated_at: string
}

export function getKycSession(db: Database, id: string): KycSessionRow | null {
  const row = db.prepare('SELECT * FROM kyc_sessions WHERE id = ?').get(id) as KycSessionRow | undefined
  return row ?? null
}

export function activeKycSession(db: Database, personId: string): KycSessionRow | null {
  const row = db.prepare(`
    SELECT * FROM kyc_sessions
    WHERE person_id = ? AND provider = 'stripe_identity' AND status IN ('pending', 'requires_input', 'processing')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(personId) as KycSessionRow | undefined
  return row ?? null
}

function sessionsInLastHour(db: Database, personId: string, now: Date): number {
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM kyc_sessions
    WHERE person_id = ? AND provider = 'stripe_identity' AND created_at > ?
  `).get(personId, since) as { count: number }
  return row.count
}

export type IdentitySessionResult = {
  person: PersonRow
  verification: {
    provider: 'stripe_identity'
    sessionId: string
    clientSecret: string | null
    url: string | null
    status: string
    reused: boolean
  }
}

export async function beginStripeIdentitySession(
  db: Database,
  person: PersonRow,
  actor: string,
  now = new Date(),
): Promise<IdentitySessionResult | {
  error: string
  errorCode: string
  status: 401 | 403 | 409 | 429 | 503
  verification?: IdentitySessionResult['verification']
}> {
  if (!stripeIdentityEnabled()) {
    return {
      error: 'Stripe Identity is not configured',
      errorCode: 'IDENTITY_PROVIDER_DISABLED',
      status: 503,
    }
  }
  if (person.status !== 'active') {
    return { error: 'Offboarded people cannot start KYC', errorCode: 'PERSON_OFFBOARDED', status: 409 }
  }
  if (person.kyc_status === 'verified' && person.kyc_provider === 'stripe_identity') {
    return { error: 'This person is already verified', errorCode: 'ALREADY_VERIFIED', status: 409 }
  }
  if (sessionsInLastHour(db, person.id, now) >= IDENTITY_SESSION_HOURLY_LIMIT) {
    return { error: 'Too many identity checks for this person', errorCode: 'IDENTITY_RATE_LIMITED', status: 429 }
  }

  const active = activeKycSession(db, person.id)
  if (active) {
    const existing = await retrieveDocumentSession(active.id)
    return {
      error: 'This person already has an open identity check',
      errorCode: 'VERIFICATION_SESSION_ACTIVE',
      status: 409,
      verification: {
        provider: 'stripe_identity' as const,
        sessionId: active.id,
        clientSecret: existing?.clientSecret ?? null,
        url: existing?.url ?? null,
        status: active.status,
        reused: true,
      },
    }
  }

  const created = await createDocumentSession(person.id)
  const timestamp = now.toISOString()
  const updated = db.transaction(() => {
    db.prepare(`
      INSERT INTO kyc_sessions (id, person_id, provider, status, created_at, updated_at)
      VALUES (?, ?, 'stripe_identity', 'pending', ?, ?)
    `).run(created.id, person.id, timestamp, timestamp)
    return setPersonKyc(db, person.id, {
      status: 'pending',
      provider: 'stripe_identity',
      reference: created.id,
    })
  })()
  logAuditEvent(db, {
    action: 'person.kyc_session_created',
    actor,
    target: person.id,
    details: { provider: 'stripe_identity', sessionId: created.id, status: 'pending' },
  })
  return {
    person: updated ?? person,
    verification: {
      provider: 'stripe_identity',
      sessionId: created.id,
      clientSecret: created.clientSecret,
      url: created.url,
      status: 'pending',
      reused: false,
    },
  }
}

type StripeEvent = {
  id?: string
  type?: string
  created?: number
  data?: { object?: unknown }
}

export function constructStripeIdentityEvent(rawBody: string, signature: string): StripeEvent {
  const secret = process.env['STRIPE_IDENTITY_WEBHOOK_SECRET']?.trim()
  if (!secret) {
    throw new Error('IDENTITY_PROVIDER_DISABLED')
  }
  return stripe().webhooks.constructEvent(rawBody, signature, secret) as StripeEvent
}

function sessionIdOf(object: unknown): string | null {
  if (!object || typeof object !== 'object') return null
  const id = (object as Record<string, unknown>)['id']
  return typeof id === 'string' && id.length > 0 && id.length <= 255 ? id : null
}

export async function applyStripeIdentityEvent(db: Database, event: StripeEvent, now = new Date()): Promise<'applied' | 'duplicate' | 'ignored'> {
  const eventId = typeof event.id === 'string' ? event.id.trim() : ''
  const eventType = typeof event.type === 'string' ? event.type : ''
  if (!eventId || eventId.length > 255) return 'ignored'
  const handled = eventType === 'identity.verification_session.verified'
    || eventType === 'identity.verification_session.requires_input'
    || eventType === 'identity.verification_session.canceled'
  const object = event.data?.object
  const sessionId = sessionIdOf(object)
  if (!handled) {
    recordEvent(db, eventId, sessionId, eventType, now)
    return 'ignored'
  }

  const existing = db.prepare('SELECT 1 AS found FROM stripe_identity_events WHERE event_id = ?').get(eventId) as { found: number } | undefined
  if (existing) return 'duplicate'

  let minimised = minimiseIdentitySession(object)
  if (
    eventType === 'identity.verification_session.verified'
    && !minimised.issuingCountry
    && !sessionCreatorOverride
    && sessionId
    && stripeIdentityEnabled()
  ) {
    try {
      const full = await stripe().identity.verificationSessions.retrieve(sessionId, {
        expand: ['last_verification_report'],
      })
      minimised = minimiseIdentitySession(full)
    } catch (error) {
      console.error('Stripe Identity report lookup failed', error instanceof Error ? error.name : 'error')
    }
  }

  const verifiedAt = typeof event.created === 'number'
    ? new Date(event.created * 1000).toISOString()
    : now.toISOString()

  const outcome = db.transaction(() => {
    const replay = db.prepare('SELECT 1 AS found FROM stripe_identity_events WHERE event_id = ?').get(eventId) as { found: number } | undefined
    if (replay) return 'duplicate' as const
    const session = sessionId ? getKycSession(db, sessionId) : null
    const person = session ? getPerson(db, session.person_id) : null
    if (!session || !person) {
      recordEvent(db, eventId, sessionId, eventType, now)
      return 'ignored' as const
    }

    if (eventType === 'identity.verification_session.verified') {
      markStripeIdentityVerified(db, person.id, {
        sessionId: session.id,
        givenName: minimised.givenName,
        familyName: minimised.familyName,
        issuingCountry: minimised.issuingCountry,
        verifiedAt,
      })
      setSessionStatus(db, session.id, 'verified', now)
      logAuditEvent(db, {
        action: 'person.kyc_verified',
        actor: 'stripe_identity',
        target: person.id,
        details: { provider: 'stripe_identity', sessionId: session.id, status: 'verified' },
      })
    } else if (person.kyc_status === 'verified' && person.kyc_provider === 'stripe_identity') {
      setSessionStatus(db, session.id, eventType.endsWith('canceled') ? 'canceled' : 'requires_input', now)
    } else if (eventType === 'identity.verification_session.requires_input') {
      setSessionStatus(db, session.id, 'requires_input', now)
      setPersonKyc(db, person.id, {
        status: 'pending',
        provider: 'stripe_identity',
        reference: session.id,
      })
    } else {
      setSessionStatus(db, session.id, 'canceled', now)
      if (person.kyc_reference === session.id && person.kyc_status !== 'verified') {
        setPersonKyc(db, person.id, { status: 'unverified', provider: null, reference: null })
      }
    }
    recordEvent(db, eventId, sessionId, eventType, now)
    return 'applied' as const
  })()
  return outcome
}

function setSessionStatus(db: Database, id: string, status: IdentitySessionStatus, now: Date): void {
  db.prepare('UPDATE kyc_sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, now.toISOString(), id)
}

function recordEvent(db: Database, eventId: string, sessionId: string | null, eventType: string, now: Date): void {
  db.prepare(`
    INSERT INTO stripe_identity_events (event_id, session_id, event_type, processed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `).run(eventId, sessionId, eventType.slice(0, 120), now.toISOString())
}
