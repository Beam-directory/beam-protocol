import { randomBytes } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'
import type { ResolverOptions } from 'node:dns'
import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { AgentRow } from '../types.js'
import { BEAM_ID_RE } from '../validation.js'
import {
  createDomainVerification,
  getAgent,
  getLatestDomainVerification,
  markAgentDomainVerified,
  updateDomainVerificationStatus,
} from '../db.js'

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
    verified: row.verified === 1 || row.verification_tier === 'verified',
    flagged: row.flagged === 1,
    verificationTier: row.verification_tier,
  }
}

function flattenTxtRecords(records: string[][]): string[] {
  return records.map((entry) => entry.join(''))
}

export function verificationRouter(db: Database, resolveTxtFn: ResolveTxtFn = resolveTxt): Hono {
  const router = new Hono()

  router.post('/:beamId/verify/domain', async (c) => {
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

    const domain = normalizeDomain(String((body as Record<string, unknown>).domain ?? ''))
    if (!DOMAIN_RE.test(domain)) {
      return c.json({ error: 'domain must be a valid DNS hostname', errorCode: 'INVALID_DOMAIN' }, 400)
    }

    const challengeToken = randomBytes(18).toString('hex')
    const verification = createDomainVerification(db, { beamId, domain, challengeToken })
    const txtName = `_beam-verify.${domain}`
    const txtValue = `beam:${beamId}:${challengeToken}`

    return c.json({
      beamId,
      domain,
      status: verification.status,
      dnsRecord: {
        name: txtName,
        type: 'TXT',
        value: txtValue,
      },
      createdAt: verification.created_at,
    }, 201)
  })

  router.get('/:beamId/verify/domain/check', async (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    if (!BEAM_ID_RE.test(beamId)) {
      return c.json({ error: 'Invalid beamId format', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const verification = getLatestDomainVerification(db, beamId)
    if (!verification) {
      return c.json({ error: 'No domain verification attempt found', errorCode: 'NOT_FOUND' }, 404)
    }

    const txtName = `_beam-verify.${verification.domain}`
    const expectedValue = `beam:${beamId}:${verification.challenge_token}`

    try {
      const records = flattenTxtRecords(await resolveTxtFn(txtName))
      if (!records.includes(expectedValue)) {
        updateDomainVerificationStatus(db, verification.id, 'failed')
        return c.json({
          verified: false,
          status: 'failed',
          domain: verification.domain,
          txtName,
          message: 'DNS TXT challenge record did not match expected value',
        }, 409)
      }

      updateDomainVerificationStatus(db, verification.id, 'verified')
      const agent = markAgentDomainVerified(db, beamId)
      return c.json({
        verified: true,
        status: 'verified',
        domain: verification.domain,
        txtName,
        agent: agent ? serializeAgent(agent) : null,
      })
    } catch (error) {
      updateDomainVerificationStatus(db, verification.id, 'failed')
      return c.json({
        verified: false,
        status: 'failed',
        domain: verification.domain,
        txtName,
        error: error instanceof Error ? error.message : 'Failed to resolve DNS TXT record',
        errorCode: 'DNS_LOOKUP_FAILED',
      }, 502)
    }
  })

  return router
}
