import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentRow, BusinessVerificationRow } from '../types.js'
import { issueBusinessVC } from '../credentials.js'
import { BEAM_ID_RE } from '../validation.js'
import { serializeAgent } from '../utils/serialize.js'
import {
  createBusinessVerification,
  getAgent,
  getLatestBusinessVerification,
  markAgentBusinessVerified,
} from '../db.js'

const DE_REGISTRATION_RE = /^(HRB|HRA)[\s-]*(\d{1,12})$/i
const UK_REGISTRATION_RE = /^[A-Z0-9]{2,8}$/
const LEGAL_SUFFIX_RE = /\b(?:gmbh|ug|ag|kg|ohg|eg|e\.?v\.?|limited|ltd|plc|llp|inc|corp|corporation|company)\b/g

type SupportedCountry = 'DE' | 'UK'

type CompaniesHouseResponse = {
  company_name?: unknown
  company_number?: unknown
  company_status?: unknown
}

function parseEvidence(row: BusinessVerificationRow): unknown {
  if (!row.evidence) {
    return null
  }

  try {
    return JSON.parse(row.evidence) as unknown
  } catch {
    return row.evidence
  }
}

function serializeBusinessVerification(row: BusinessVerificationRow): object {
  return {
    id: row.id,
    beamId: row.beam_id,
    country: row.country,
    registrationNumber: row.registration_number,
    legalName: row.legal_name,
    status: row.status,
    verificationSource: row.verification_source,
    sourceReference: row.source_reference,
    evidence: parseEvidence(row),
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  }
}

function normalizeCountry(value: string): SupportedCountry | null {
  const normalized = value.trim().toUpperCase()
  if (normalized === 'DE' || normalized === 'DEU' || normalized === 'GERMANY') {
    return 'DE'
  }

  if (normalized === 'UK' || normalized === 'GB' || normalized === 'GBR' || normalized === 'UNITED KINGDOM') {
    return 'UK'
  }

  return null
}

function normalizeEntityName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,/\\()-]/g, ' ')
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeGermanRegistrationNumber(value: string): string | null {
  const match = DE_REGISTRATION_RE.exec(value.trim().toUpperCase())
  if (!match) {
    return null
  }

  return `${match[1]} ${match[2]}`
}

function normalizeUkRegistrationNumber(value: string): string | null {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '')
  if (!UK_REGISTRATION_RE.test(normalized)) {
    return null
  }

  return normalized
}

async function verifyUkCompany(
  registrationNumber: string,
  legalName: string,
): Promise<{
  sourceReference: string
  evidence: Record<string, unknown>
}> {
  const apiKey = process.env['COMPANIES_HOUSE_API_KEY']?.trim()
  if (!apiKey) {
    throw new Error('COMPANIES_HOUSE_API_KEY is not configured')
  }

  const response = await fetch(`https://api.company-information.service.gov.uk/company/${encodeURIComponent(registrationNumber)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      Accept: 'application/json',
    },
  })

  if (response.status === 404) {
    throw new Error('Company registration number was not found')
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Companies House authentication failed')
  }

  if (!response.ok) {
    throw new Error(`Companies House lookup failed with status ${response.status}`)
  }

  const payload = await response.json() as CompaniesHouseResponse
  const companyName = typeof payload.company_name === 'string' ? payload.company_name.trim() : ''
  const companyNumber = typeof payload.company_number === 'string' ? payload.company_number.trim().toUpperCase() : registrationNumber
  const companyStatus = typeof payload.company_status === 'string' ? payload.company_status.trim().toLowerCase() : ''

  if (!companyName) {
    throw new Error('Companies House response did not include a company name')
  }

  if (normalizeEntityName(companyName) !== normalizeEntityName(legalName)) {
    throw new Error('legalName does not match the registered company name')
  }

  return {
    sourceReference: companyNumber,
    evidence: {
      companyName,
      companyNumber,
      companyStatus,
    },
  }
}

export function businessVerificationRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:beamId/verify-business', async (c) => {
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
    const country = normalizeCountry(String(raw.country ?? ''))
    const registrationNumberInput = String(raw.registrationNumber ?? '').trim()
    const legalName = String(raw.legalName ?? '').trim()

    if (!country || !registrationNumberInput || !legalName) {
      return c.json({ error: 'country, registrationNumber and legalName are required', errorCode: 'INVALID_REQUEST' }, 400)
    }

    try {
      if (country === 'DE') {
        const registrationNumber = normalizeGermanRegistrationNumber(registrationNumberInput)
        if (!registrationNumber) {
          return c.json({ error: 'German registrationNumber must match HRB/HRA followed by digits', errorCode: 'INVALID_REGISTRATION_NUMBER' }, 400)
        }

        const verification = createBusinessVerification(db, {
          beamId,
          country,
          registrationNumber,
          legalName,
          status: 'verified',
          verificationSource: 'de-format',
          sourceReference: registrationNumber,
          evidence: {
            registrationType: registrationNumber.split(' ')[0],
            validation: 'format',
          },
        })

        const updatedAgent = markAgentBusinessVerified(db, beamId)
        const credential = issueBusinessVC(beamId, {
          country,
          registrationNumber,
          legalName,
          verificationSource: verification.verification_source,
          sourceReference: verification.source_reference,
          verifiedAt: verification.verified_at,
        })

        return c.json({
          verified: true,
          status: verification.status,
          verification: serializeBusinessVerification(verification),
          credential,
          agent: updatedAgent ? serializeAgent(updatedAgent) : null,
        }, 201)
      }

      const registrationNumber = normalizeUkRegistrationNumber(registrationNumberInput)
      if (!registrationNumber) {
        return c.json({ error: 'UK registrationNumber must be 2-8 alphanumeric characters', errorCode: 'INVALID_REGISTRATION_NUMBER' }, 400)
      }

      const upstream = await verifyUkCompany(registrationNumber, legalName)
      const verification = createBusinessVerification(db, {
        beamId,
        country,
        registrationNumber,
        legalName,
        status: 'verified',
        verificationSource: 'companies-house',
        sourceReference: upstream.sourceReference,
        evidence: upstream.evidence,
      })

      const updatedAgent = markAgentBusinessVerified(db, beamId)
      const credential = issueBusinessVC(beamId, {
        country,
        registrationNumber,
        legalName,
        verificationSource: verification.verification_source,
        sourceReference: verification.source_reference,
        verifiedAt: verification.verified_at,
      })

      return c.json({
        verified: true,
        status: verification.status,
        verification: serializeBusinessVerification(verification),
        credential,
        agent: updatedAgent ? serializeAgent(updatedAgent) : null,
      }, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Business verification failed'
      const verificationSource = country === 'UK' ? 'companies-house' : 'de-format'
      const normalizedRegistrationNumber = country === 'UK'
        ? normalizeUkRegistrationNumber(registrationNumberInput) ?? registrationNumberInput.toUpperCase()
        : normalizeGermanRegistrationNumber(registrationNumberInput) ?? registrationNumberInput.toUpperCase()

      const verification = createBusinessVerification(db, {
        beamId,
        country,
        registrationNumber: normalizedRegistrationNumber,
        legalName,
        status: 'failed',
        verificationSource,
        sourceReference: normalizedRegistrationNumber,
        evidence: { error: message },
        verifiedAt: null,
      })

      const status = message === 'COMPANIES_HOUSE_API_KEY is not configured' ? 503 : 409
      return c.json({
        verified: false,
        status: verification.status,
        error: message,
        errorCode: status === 503 ? 'COMPANIES_HOUSE_UNAVAILABLE' : 'BUSINESS_VERIFICATION_FAILED',
        verification: serializeBusinessVerification(verification),
      }, status)
    }
  })

  router.get('/:beamId/business-status', (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const agent = getAgent(db, beamId)
    if (!agent) {
      return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
    }

    const verification = getLatestBusinessVerification(db, beamId)
    if (!verification) {
      return c.json({
        beamId,
        verified: agent.verified === 1 || agent.verification_tier !== 'basic',
        verificationTier: agent.verification_tier,
        businessVerification: null,
      })
    }

    return c.json({
      beamId,
      verified: agent.verified === 1 || agent.verification_tier !== 'basic',
      verificationTier: agent.verification_tier,
      businessVerification: serializeBusinessVerification(verification),
    })
  })

  return router
}
