import { generateKeyPairSync } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/email.js', () => ({
  sendAgentVerificationEmail: vi.fn(async () => true),
  sendIdentityClaimEmail: vi.fn(async () => true),
  sendOperatorDigestEmail: vi.fn(async () => true),
}))

import { createAdminSession } from '../src/admin-auth.js'
import { sendOperatorDigestEmail } from '../src/email.js'
import { assignDirectoryRole, createDatabase, createDomainVerification, updatePublicEndpointShieldPolicy } from '../src/db.js'
import { getLocalDirectoryUrl } from '../src/federation.js'
import { createApp } from '../src/server.js'

function publicKey(): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
}

async function registerAgent(app: ReturnType<typeof createApp>, beamId: string, email: string) {
  const response = await app.request('http://localhost/agents/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      beamId,
      displayName: 'Einkauf',
      capabilities: ['chat'],
      publicKey: publicKey(),
      email,
    }),
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<{ apiKey: string }>
}

function sealBody(overrides: Record<string, unknown> = {}) {
  return {
    email: 'ada@coppen.example',
    company: 'COPPEN GmbH',
    agentCount: 3,
    contactName: 'Ada Operator',
    domain: 'coppen.example',
    source: 'seal-application',
    workflowType: 'seal-application',
    workflowSummary: 'Kontakt: Ada Operator\nDomain: coppen.example\nEntwurfspreise zur Kenntnis genommen.',
    hp_company: '',
    ...overrides,
  }
}

async function postWaitlist(app: ReturnType<typeof createApp>, body: Record<string, unknown>) {
  return app.request('http://localhost/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://beam.directory' },
    body: JSON.stringify(body),
  })
}

describe('public verified-agent seal', () => {
  let db: Database
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = createDatabase(':memory:')
    app = createApp(db)
  })

  afterEach(() => {
    db.close()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('serves an SVG seal only for public verified company agents and never includes email', async () => {
    const hiddenEmail = 'owner.hidden@example.com'
    await registerAgent(app, 'einkauf@beam.directory', hiddenEmail)
    db.prepare(`
      UPDATE agents
      SET personal = 0, org = 'coppen', visibility = 'public', verification_tier = 'business', verified = 1
      WHERE beam_id = 'einkauf@beam.directory'
    `).run()

    const seal = await app.request('http://localhost/agents/einkauf%40beam.directory/seal.svg')
    expect(seal.status).toBe(200)
    expect(seal.headers.get('content-type')).toContain('image/svg+xml')
    const svg = await seal.text()
    expect(svg).toContain('<svg')
    expect(svg).toContain('coppen')
    expect(svg).toContain('business')
    expect(svg).not.toContain(hiddenEmail)
    expect(svg).not.toContain('@')

    db.prepare(`UPDATE agents SET visibility = 'unlisted' WHERE beam_id = 'einkauf@beam.directory'`).run()
    const unlisted = await app.request('http://localhost/agents/einkauf%40beam.directory/seal.svg')
    expect(unlisted.status).toBe(404)

    db.prepare(`
      UPDATE agents
      SET visibility = 'public', personal = 1
      WHERE beam_id = 'einkauf@beam.directory'
    `).run()
    const personal = await app.request('http://localhost/agents/einkauf%40beam.directory/seal.svg')
    expect(personal.status).toBe(404)
  })

  it('stores a seal application through the waitlist without sending email', async () => {
    const response = await app.request('http://localhost/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://beam.directory' },
      body: JSON.stringify({
        email: 'ada@coppen.example',
        company: 'COPPEN GmbH',
        agentCount: 3,
        source: 'seal-application',
        workflowType: 'seal-application',
        workflowSummary: 'Kontakt: Ada\nDomain: coppen.example\nEntwurfspreise zur Kenntnis genommen.',
      }),
    })

    expect(response.status).toBe(201)
    const body = await response.json() as { source: string; workflowType: string; company: string }
    expect(body.source).toBe('seal-application')
    expect(body.workflowType).toBe('seal-application')
    expect(body.company).toBe('COPPEN GmbH')
    expect(vi.mocked(sendOperatorDigestEmail)).not.toHaveBeenCalled()

    const stored = db.prepare(`SELECT email, source, workflow_type FROM waitlist WHERE email = ?`).get('ada@coppen.example') as {
      email: string
      source: string
      workflow_type: string
    }
    expect(stored.source).toBe('seal-application')
    expect(stored.workflow_type).toBe('seal-application')
  })

  it('hides unlisted agents and DNS challenge tokens from anonymous callers', async () => {
    vi.stubEnv('JWT_SECRET', 'seal-test-secret')
    const registered = await registerAgent(app, 'einkauf@beam.directory', 'owner.hidden@example.com')
    createDomainVerification(db, {
      beamId: 'einkauf@beam.directory',
      domain: 'coppen.example',
      challengeToken: 'secret-token',
    })

    const hiddenAgent = await app.request('http://localhost/agents/einkauf%40beam.directory')
    expect(hiddenAgent.status).toBe(404)
    const hiddenAgentBody = await hiddenAgent.text()
    expect(hiddenAgentBody).not.toContain('owner.hidden@example.com')
    expect(hiddenAgentBody).not.toContain('secret-token')

    const hiddenStatus = await app.request('http://localhost/agents/einkauf%40beam.directory/domain-status')
    expect(hiddenStatus.status).toBe(404)
    expect(await hiddenStatus.text()).not.toContain('secret-token')

    db.prepare(`
      UPDATE agents
      SET personal = 0, org = 'coppen', visibility = 'public'
      WHERE beam_id = 'einkauf@beam.directory'
    `).run()

    const publicStatus = await app.request('http://localhost/agents/einkauf%40beam.directory/domain-status')
    expect(publicStatus.status).toBe(200)
    const publicBody = await publicStatus.json() as { domain: string; dnsRecord: { value: string } | null }
    expect(publicBody.domain).toBe('coppen.example')
    expect(publicBody.dnsRecord).toBeNull()
    expect(JSON.stringify(publicBody)).not.toContain('secret-token')

    const ownerStatus = await app.request('http://localhost/agents/einkauf%40beam.directory/domain-status', {
      headers: { 'x-api-key': registered.apiKey },
    })
    expect(ownerStatus.status).toBe(200)
    expect((await ownerStatus.json() as { dnsRecord: { value: string } }).dnsRecord.value).toBe('beam-verify=secret-token')

    db.prepare(`UPDATE agents SET visibility = 'private' WHERE beam_id = 'einkauf@beam.directory'`).run()
    const privateLookup = await app.request('http://localhost/agents/einkauf%40beam.directory')
    expect(privateLookup.status).toBe(404)

    assignDirectoryRole(db, {
      userId: 'ops@example.com',
      role: 'admin',
      directoryUrl: getLocalDirectoryUrl(),
    })
    const admin = createAdminSession(db, { email: 'ops@example.com', role: 'admin' })
    const adminLookup = await app.request('http://localhost/agents/einkauf%40beam.directory', {
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(adminLookup.status).toBe(200)
    expect((await adminLookup.json() as { visibility: string }).visibility).toBe('private')

    const adminStatus = await app.request('http://localhost/agents/einkauf%40beam.directory/domain-status', {
      headers: { authorization: `Bearer ${admin.token}` },
    })
    expect(adminStatus.status).toBe(200)
    expect(JSON.stringify(await adminStatus.json())).toContain('secret-token')
  })

  it('rate-limits, rejects spam, and dedupes seal applications without changing beta requests', async () => {
    const honeypot = await postWaitlist(app, sealBody({ hp_company: 'https://spam.example' }))
    expect(honeypot.status).toBe(201)
    expect(db.prepare('SELECT COUNT(*) AS count FROM waitlist').get()).toEqual({ count: 0 })

    const invalid = await postWaitlist(app, sealBody({ email: 'not-an-email', company: 'x'.repeat(201) }))
    expect(invalid.status).toBe(400)

    const missingDomain = await postWaitlist(app, sealBody({
      domain: 'localhost',
      workflowSummary: 'Kontakt: Ada Operator',
    }))
    expect(missingDomain.status).toBe(400)
    expect((await missingDomain.json() as { errorCode: string }).errorCode).toBe('INVALID_DOMAIN')

    const beta = await postWaitlist(app, {
      email: 'buyer@example.com',
      source: 'hosted-beta-page',
      company: 'Northwind',
      agentCount: 4,
      workflowType: 'hosted-beta-partner-handoff',
      workflowSummary: 'Existing beta request.',
    })
    expect(beta.status).toBe(201)

    const sealForSameEmail = await postWaitlist(app, sealBody({ email: 'buyer@example.com' }))
    expect(sealForSameEmail.status).toBe(201)
    const rows = db.prepare(`
      SELECT source, company FROM waitlist WHERE email = 'buyer@example.com' ORDER BY id ASC
    `).all() as Array<{ source: string; company: string }>
    expect(rows).toEqual([
      { source: 'hosted-beta-page', company: 'Northwind' },
      { source: 'seal-application', company: 'COPPEN GmbH' },
    ])

    const followUp = await postWaitlist(app, {
      email: 'buyer@example.com',
      source: 'hosted-beta-follow-up',
      company: 'Northwind Renewed',
      agentCount: 6,
      workflowType: 'hosted-beta-partner-handoff',
    })
    expect(followUp.status).toBe(200)
    const betaRow = db.prepare(`
      SELECT company, source FROM waitlist WHERE source = 'hosted-beta-follow-up'
    `).get() as { company: string; source: string }
    expect(betaRow).toEqual({ company: 'Northwind Renewed', source: 'hosted-beta-follow-up' })

    const first = await postWaitlist(app, sealBody())
    expect(first.status).toBe(201)
    const duplicate = await postWaitlist(app, sealBody({
      workflowSummary: 'Kontakt: Ada Operator\nDomain: coppen.example\nBitte erneut.',
    }))
    expect(duplicate.status).toBe(200)
    expect((await duplicate.json() as { status: string; workflowSummary: string }).workflowSummary).toContain('Entwurfspreise')
    expect(db.prepare(`SELECT COUNT(*) AS count FROM waitlist WHERE email = 'ada@coppen.example'`).get()).toEqual({ count: 1 })

    const otherOrg = await postWaitlist(app, sealBody({ company: 'Andere GmbH' }))
    expect(otherOrg.status).toBe(201)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM waitlist WHERE email = 'ada@coppen.example'`).get()).toEqual({ count: 2 })

    db.prepare(`UPDATE waitlist SET created_at = ? WHERE email = ? AND company = ?`).run(
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      'ada@coppen.example',
      'COPPEN GmbH',
    )
    const afterWindow = await postWaitlist(app, sealBody())
    expect(afterWindow.status).toBe(201)
    expect(db.prepare(`SELECT COUNT(*) AS count FROM waitlist WHERE email = 'ada@coppen.example' AND company = 'COPPEN GmbH'`).get()).toEqual({ count: 2 })

    db.prepare('DELETE FROM rate_limits').run()
    updatePublicEndpointShieldPolicy(db, { waitlistPerMinute: 2 })
    const limitedApp = createApp(db)
    const firstLimited = await postWaitlist(limitedApp, sealBody({ email: 'one@coppen.example' }))
    const secondLimited = await postWaitlist(limitedApp, sealBody({ email: 'two@coppen.example' }))
    const thirdLimited = await postWaitlist(limitedApp, sealBody({ email: 'three@coppen.example' }))
    expect(firstLimited.status).toBe(201)
    expect(secondLimited.status).toBe(201)
    expect(thirdLimited.status).toBe(429)
    expect((await thirdLimited.json() as { errorCode: string }).errorCode).toBe('RATE_LIMITED')
  })
})
