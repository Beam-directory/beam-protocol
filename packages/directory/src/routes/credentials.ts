import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import { issueBusinessVC, issueDomainVC, issueEmailVC, verifyCredential, type VerifiableCredential } from '../credentials.js'
import { agentApiKeyMatches, getSuppliedApiKey } from '../api-key.js'
import { getAdminSessionFromRequest, roleSatisfies } from '../admin-auth.js'
import {
  getAgent,
  getVerifiedDomainVerification,
  listVerifiedBusinessVerifications,
} from '../db.js'
import { didToBeamId } from '../did.js'
import type { AgentRow, BusinessVerificationRow } from '../types.js'

function normalizeLoose(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeRegistration(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ')
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/\.$/, '')
}

function unauthorized(c: Context) {
  return c.json({
    error: 'Only the Beam ID owner or a directory admin can issue a verified credential',
    errorCode: 'UNAUTHORIZED',
  }, 401)
}

function verificationRequired(c: Context, message: string) {
  return c.json({
    error: message,
    errorCode: 'VERIFICATION_REQUIRED',
  }, 409)
}

function callerCanIssue(db: Database, request: Request, agent: AgentRow | null): boolean {
  const admin = getAdminSessionFromRequest(db, request)
  if (admin && roleSatisfies(admin.role, 'admin')) {
    return true
  }

  return agentApiKeyMatches(agent, getSuppliedApiKey(request))
}

function readJsonObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  return body as Record<string, unknown>
}

function credentialIsCurrent(db: Database, vc: VerifiableCredential): boolean {
  const beamId = didToBeamId(String(vc.credentialSubject?.id ?? ''))
  if (!beamId) {
    return false
  }

  const agent = getAgent(db, beamId)
  if (!agent) {
    return false
  }

  const types = new Set(vc.type ?? [])
  if (types.has('EmailVerificationCredential')) {
    const email = String(vc.credentialSubject.email ?? '').trim().toLowerCase()
    return agent.email_verified === 1
      && email.length > 0
      && agent.email?.trim().toLowerCase() === email
  }

  if (types.has('DomainVerificationCredential')) {
    const domain = normalizeDomain(String(vc.credentialSubject.domain ?? ''))
    return domain.length > 0 && getVerifiedDomainVerification(db, beamId, domain) !== null
  }

  if (types.has('BusinessVerificationCredential')) {
    const business = vc.credentialSubject.business
    if (!business) {
      return false
    }
    const country = String(business['country'] ?? '').trim()
    const registrationNumber = String(business['registrationNumber'] ?? '').trim()
    const legalName = String(business['legalName'] ?? '').trim()
    if (!country || !registrationNumber || !legalName) {
      return false
    }
    return listVerifiedBusinessVerifications(db, beamId)
      .some((row) => businessMatches(row, { country, registrationNumber, legalName }))
  }

  return false
}

function businessMatches(
  row: BusinessVerificationRow,
  input: { country: string; registrationNumber: string; legalName: string },
): boolean {
  return normalizeLoose(row.country) === normalizeLoose(input.country)
    && normalizeRegistration(row.registration_number) === normalizeRegistration(input.registrationNumber)
    && normalizeLoose(row.legal_name) === normalizeLoose(input.legalName)
}

export function credentialsRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/email', async (c) => {
    const body = readJsonObject(await c.req.json().catch(() => null))
    const beamId = String(body?.['beamId'] ?? '').trim()
    const email = String(body?.['email'] ?? '').trim().toLowerCase()

    if (!beamId || !email) {
      return c.json({ error: 'beamId and email are required', errorCode: 'INVALID_REQUEST' }, 400)
    }

    const agent = getAgent(db, beamId)
    if (!callerCanIssue(db, c.req.raw, agent)) {
      return unauthorized(c)
    }
    if (!agent) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    const verifiedEmail = agent.email?.trim().toLowerCase() ?? ''
    if (agent.email_verified !== 1 || !verifiedEmail || verifiedEmail !== email) {
      return verificationRequired(c, 'Email verification has not passed for this address')
    }

    return c.json(issueEmailVC(beamId, verifiedEmail), 201)
  })

  router.post('/domain', async (c) => {
    const body = readJsonObject(await c.req.json().catch(() => null))
    const beamId = String(body?.['beamId'] ?? '').trim()
    const domain = normalizeDomain(String(body?.['domain'] ?? ''))

    if (!beamId || !domain) {
      return c.json({ error: 'beamId and domain are required', errorCode: 'INVALID_REQUEST' }, 400)
    }

    const agent = getAgent(db, beamId)
    if (!callerCanIssue(db, c.req.raw, agent)) {
      return unauthorized(c)
    }
    if (!agent) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    const verification = getVerifiedDomainVerification(db, beamId, domain)
    if (!verification) {
      return verificationRequired(c, 'Domain verification has not passed for this domain')
    }

    return c.json(issueDomainVC(beamId, verification.domain), 201)
  })

  router.post('/business', async (c) => {
    const body = readJsonObject(await c.req.json().catch(() => null))
    const beamId = String(body?.['beamId'] ?? '').trim()
    const businessInfo = readJsonObject(body?.['businessInfo'])

    if (!beamId || !businessInfo) {
      return c.json({ error: 'beamId and businessInfo are required', errorCode: 'INVALID_REQUEST' }, 400)
    }

    const country = String(businessInfo['country'] ?? '').trim()
    const registrationNumber = String(businessInfo['registrationNumber'] ?? '').trim()
    const legalName = String(businessInfo['legalName'] ?? '').trim()
    if (!country || !registrationNumber || !legalName) {
      return c.json({
        error: 'businessInfo.country, registrationNumber, and legalName are required',
        errorCode: 'INVALID_REQUEST',
      }, 400)
    }

    const agent = getAgent(db, beamId)
    if (!callerCanIssue(db, c.req.raw, agent)) {
      return unauthorized(c)
    }
    if (!agent) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    const verification = listVerifiedBusinessVerifications(db, beamId)
      .find((row) => businessMatches(row, { country, registrationNumber, legalName }))
    if (!verification) {
      return verificationRequired(c, 'Business verification has not passed for this registration')
    }

    return c.json(issueBusinessVC(beamId, {
      country: verification.country,
      registrationNumber: verification.registration_number,
      legalName: verification.legal_name,
      verificationSource: verification.verification_source,
      sourceReference: verification.source_reference,
      verifiedAt: verification.verified_at,
    }), 201)
  })

  router.post('/verify', async (c) => {
    const body = await c.req.json().catch(() => null) as { vc?: VerifiableCredential } | null
    if (!body?.vc) {
      return c.json({ error: 'vc is required', errorCode: 'INVALID_REQUEST' }, 400)
    }

    const signatureValid = verifyCredential(body.vc)
    if (!signatureValid) {
      return c.json({
        valid: false,
        signatureValid: false,
        current: false,
        errorCode: 'INVALID_SIGNATURE',
      })
    }

    if (!credentialIsCurrent(db, body.vc)) {
      return c.json({
        valid: false,
        signatureValid: true,
        current: false,
        errorCode: 'VERIFICATION_NOT_CURRENT',
      })
    }

    return c.json({ valid: true, signatureValid: true, current: true })
  })

  return router
}
