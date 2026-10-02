import { generateKeyPairSync } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/email.js', () => ({
  sendAgentVerificationEmail: vi.fn(async () => true),
  sendIdentityClaimEmail: vi.fn(async () => true),
  sendOperatorDigestEmail: vi.fn(async () => true),
}))

import { sendOperatorDigestEmail } from '../src/email.js'
import { createDatabase } from '../src/db.js'
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
})
