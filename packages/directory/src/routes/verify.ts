import { randomBytes } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'
import type { ResolverOptions } from 'node:dns'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Database } from 'better-sqlite3'
import { issueDomainVC } from '../credentials.js'
import type { AgentRow, DomainVerificationRow } from '../types.js'
import { BEAM_ID_RE } from '../validation.js'
import {
  createDomainVerification,
  getAgent,
  getLatestDomainVerification,
  markAgentDomainVerified,
  updateDomainVerificationStatus,
} from '../db.js'
import { agentApiKeyMatches, getSuppliedApiKey } from '../api-key.js'

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

type ResolveTxtFn = (hostname: string, options?: ResolverOptions) => Promise<string[][]>

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function serializeAgent(row: AgentRow): object {
  const { email_token: _emailToken, ...agent } = row
  return {
    ...agent,
    capabilities: JSON.parse(row.capabilities) as string[],
    personal: row.personal === 1,
    verified: row.verified === 1 || row.verification_tier !== 'basic',
    flagged: row.flagged === 1,
    verificationTier: row.verification_tier,
  }
}

function flattenTxtRecords(records: string[][]): string[] {
  return records.map((entry) => entry.join(''))
}

function getDnsRecord(domain: string, challengeToken: string): { name: string; type: 'TXT'; value: string } {
  return {
    name: `_beam-verify.${domain}`,
    type: 'TXT',
    value: `beam-verify=${challengeToken}`,
  }
}

async function parseDomainRequest(c: Context): Promise<string | Response> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
  }

  const domain = normalizeDomain(String((body as Record<string, unknown>).domain ?? ''))
  if (!DOMAIN_RE.test(domain)) {
    return c.json({ error: 'domain must be a valid DNS hostname', errorCode: 'INVALID_DOMAIN' }, 400)
  }

  return domain
}

function getAgentOrError(db: Database, c: Context, beamId: string): AgentRow | Response {
  if (!BEAM_ID_RE.test(beamId)) {
    return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
  }

  const agent = getAgent(db, beamId)
  if (!agent) {
    return c.json({ error: `Agent ${beamId} not found`, errorCode: 'NOT_FOUND' }, 404)
  }

  return agent
}

function buildDomainStatus(agent: AgentRow, verification: DomainVerificationRow | null): object {
  const dnsRecord = verification ? getDnsRecord(verification.domain, verification.challenge_token) : null

  return {
    beamId: agent.beam_id,
    verified: agent.verified === 1 || agent.verification_tier === 'verified',
    verificationTier: agent.verification_tier,
    domain: verification?.domain ?? null,
    status: verification?.status ?? 'not_started',
    dnsRecord,
    createdAt: verification?.created_at ?? null,
    verifiedAt: verification?.verified_at ?? null,
  }
}

export function verificationRouter(db: Database, resolveTxtFn: ResolveTxtFn = resolveTxt): Hono {
  const router = new Hono()

  const requireAgentApiKey = (c: Context, agent: AgentRow): Response | null => {
    const suppliedApiKey = getSuppliedApiKey(c.req.raw)
    return agentApiKeyMatches(agent, suppliedApiKey)
      ? null
      : c.json({ error: 'Missing or invalid API key', errorCode: 'UNAUTHORIZED' }, 401)
  }

  const startDomainVerification = async (c: Context) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    const agent = getAgentOrError(db, c, beamId)
    if (agent instanceof Response) {
      return agent
    }
    const authError = requireAgentApiKey(c, agent)
    if (authError) {
      return authError
    }

    const domainOrError = await parseDomainRequest(c)
    if (domainOrError instanceof Response) {
      return domainOrError
    }

    const challengeToken = randomBytes(18).toString('hex')
    const verification = createDomainVerification(db, { beamId, domain: domainOrError, challengeToken })
    const dnsRecord = getDnsRecord(domainOrError, challengeToken)

    return c.json({
      beamId,
      domain: domainOrError,
      status: verification.status,
      dnsRecord,
      instructions: `Create a TXT record for ${dnsRecord.name} with value ${dnsRecord.value}`,
      createdAt: verification.created_at,
    }, 201)
  }

  const checkDomainVerification = async (c: Context) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    const agent = getAgentOrError(db, c, beamId)
    if (agent instanceof Response) {
      return agent
    }
    const authError = requireAgentApiKey(c, agent)
    if (authError) {
      return authError
    }

    const verification = getLatestDomainVerification(db, beamId)
    if (!verification) {
      return c.json({ error: 'No domain verification attempt found', errorCode: 'NOT_FOUND' }, 404)
    }

    const dnsRecord = getDnsRecord(verification.domain, verification.challenge_token)

    try {
      const records = flattenTxtRecords(await resolveTxtFn(dnsRecord.name))
      if (!records.includes(dnsRecord.value)) {
        updateDomainVerificationStatus(db, verification.id, 'failed')
        return c.json({
          verified: false,
          status: 'failed',
          domain: verification.domain,
          dnsRecord,
          records,
          message: 'DNS TXT challenge record did not match expected value',
        }, 409)
      }

      const updatedVerification = updateDomainVerificationStatus(db, verification.id, 'verified')
      const updatedAgent = markAgentDomainVerified(db, beamId)
      return c.json({
        verified: true,
        status: 'verified',
        domain: verification.domain,
        dnsRecord,
        credential: issueDomainVC(beamId, verification.domain),
        agent: updatedAgent ? serializeAgent(updatedAgent) : serializeAgent(agent),
        verifiedAt: updatedVerification?.verified_at ?? null,
      })
    } catch (error) {
      updateDomainVerificationStatus(db, verification.id, 'failed')
      return c.json({
        verified: false,
        status: 'failed',
        domain: verification.domain,
        dnsRecord,
        error: error instanceof Error ? error.message : 'Failed to resolve DNS TXT record',
        errorCode: 'DNS_LOOKUP_FAILED',
      }, 502)
    }
  }

  router.post('/:beamId/verify-domain', startDomainVerification)
  router.post('/:beamId/verify/domain', startDomainVerification)
  router.post('/:beamId/check-domain', checkDomainVerification)
  router.get('/:beamId/verify/domain/check', checkDomainVerification)

  router.get('/:beamId/domain-status', (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    const agent = getAgentOrError(db, c, beamId)
    if (agent instanceof Response) {
      return agent
    }

    return c.json(buildDomainStatus(agent, getLatestDomainVerification(db, beamId)))
  })

  return router
}
