import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/email.js', () => ({
  sendAgentVerificationEmail: vi.fn(async () => true),
}))

import { createDatabase } from '../src/db.js'
import { sendAgentVerificationEmail } from '../src/email.js'
import { createApp } from '../src/server.js'

function createIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicKeyBase64: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
  }
}

function signProfileUpdate(input: {
  privateKey: Parameters<typeof sign>[2]
  beamId: string
  profile: { description?: string | null; logo_url?: string | null; website?: string | null }
  timestamp: string
  nonce: string
}): string {
  const payload = JSON.stringify({
    type: 'agent_profile_update',
    beamId: input.beamId,
    profile: {
      description: input.profile.description ?? null,
      logo_url: input.profile.logo_url ?? null,
      website: input.profile.website ?? null,
    },
    timestamp: input.timestamp,
    nonce: input.nonce,
  })

  return sign(null, Buffer.from(payload, 'utf8'), input.privateKey).toString('base64')
}

describe('directory agent enhancements', () => {
  let db: Database
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    db = createDatabase(':memory:')
    app = createApp(db)
    vi.mocked(sendAgentVerificationEmail).mockResolvedValue(true)
  })

  afterEach(() => {
    delete process.env['ECHO_AGENT_SECRET']
    db.close()
    vi.clearAllMocks()
  })

  it('registers an agent with email and stores a verification token', async () => {
    const identity = createIdentity()
    const response = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        beamId: 'helper@testorg.beam.directory',
        org: 'testorg',
        displayName: 'Helper',
        capabilities: ['chat', 'search'],
        publicKey: identity.publicKeyBase64,
        email: 'helper@example.com',
      }),
    })

    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(body['email']).toBe('helper@example.com')
    expect(body['email_verified']).toBe(false)
    expect(body['verification_email_sent']).toBe(true)
    expect(body).not.toHaveProperty('email_token')

    const tokenRow = db.prepare('SELECT * FROM verification_tokens WHERE beam_id = ?').get('helper@testorg.beam.directory') as { token: string; email: string } | undefined
    expect(tokenRow?.email).toBe('helper@example.com')
    expect(tokenRow?.token).toBeTruthy()
    expect(sendAgentVerificationEmail).toHaveBeenCalledTimes(1)
  })

  it('verifies an email token and returns extended agent fields', async () => {
    const identity = createIdentity()
    await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        beamId: 'verified@testorg.beam.directory',
        org: 'testorg',
        displayName: 'Verified Agent',
        capabilities: ['chat'],
        publicKey: identity.publicKeyBase64,
        email: 'verified@example.com',
      }),
    })

    const tokenRow = db.prepare('SELECT token FROM verification_tokens WHERE beam_id = ?').get('verified@testorg.beam.directory') as { token: string }
    const verifyResponse = await app.request(`http://localhost/agents/verify?token=${tokenRow.token}`)
    expect(verifyResponse.status).toBe(200)

    const agentResponse = await app.request(`http://localhost/agents/${encodeURIComponent('verified@testorg.beam.directory')}`)
    expect(agentResponse.status).toBe(200)
    const agent = await agentResponse.json() as Record<string, unknown>
    expect(agent['email']).toBe('verified@example.com')
    expect(agent['email_verified']).toBe(true)
    expect(agent['verification_tier']).toBe('basic')
    expect(agent['description']).toBeNull()
    expect(agent['logo_url']).toBeNull()
    expect(agent['website']).toBeNull()

    const pendingToken = db.prepare('SELECT token FROM verification_tokens WHERE beam_id = ?').get('verified@testorg.beam.directory')
    expect(pendingToken).toBeUndefined()
  })

  it('requires a bearer token for reserved echo registrations when configured', async () => {
    process.env['ECHO_AGENT_SECRET'] = 'echo-secret'
    const identity = createIdentity()

    const unauthorized = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        beamId: 'echo@beam.directory',
        displayName: 'Echo Agent',
        capabilities: ['conversation.message'],
        publicKey: identity.publicKeyBase64,
      }),
    })

    expect(unauthorized.status).toBe(401)

    const authorized = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer echo-secret',
      },
      body: JSON.stringify({
        beamId: 'echo@beam.directory',
        displayName: 'Echo Agent',
        capabilities: ['conversation.message'],
        publicKey: identity.publicKeyBase64,
      }),
    })

    expect(authorized.status).toBe(201)
  })

  it('allows personal Beam IDs without an org', async () => {
    const identity = createIdentity()
    const response = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        beamId: 'alice@beam.directory',
        displayName: 'Alice',
        capabilities: ['assistant'],
        publicKey: identity.publicKeyBase64,
      }),
    })

    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(body['org']).toBe('personal')
    expect(body['personal']).toBe(true)
    expect(body['did']).toBe('did:beam:alice')

    const searchResponse = await app.request('http://localhost/agents/search?org=personal')
    expect(searchResponse.status).toBe(200)
    const searchBody = await searchResponse.json() as { agents: Array<Record<string, unknown>>; total: number }
    expect(searchBody.total).toBe(1)
    expect(searchBody.agents[0]?.beam_id).toBe('alice@beam.directory')
  })

  it('defaults generated Beam IDs to personal when org and email are absent', async () => {
    const identity = createIdentity()
    const response = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Alice Example',
        capabilities: ['assistant'],
        publicKey: identity.publicKeyBase64,
      }),
    })

    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(body['beam_id']).toBe('alice-example@beam.directory')
    expect(body['org']).toBe('personal')
    expect(body['personal']).toBe(true)
  })

  it('rate limits registration requests by IP', async () => {
    for (let index = 0; index < 10; index += 1) {
      const identity = createIdentity()
      const response = await app.request('http://localhost/agents/register', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.10',
        },
        body: JSON.stringify({
          beamId: `limited-${index}@beam.directory`,
          displayName: `Limited ${index}`,
          capabilities: ['assistant'],
          publicKey: identity.publicKeyBase64,
        }),
      })

      expect(response.status).toBe(201)
    }

    const blocked = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.10',
      },
      body: JSON.stringify({
        beamId: 'limited-overflow@beam.directory',
        displayName: 'Limited Overflow',
        capabilities: ['assistant'],
        publicKey: createIdentity().publicKeyBase64,
      }),
    })

    expect(blocked.status).toBe(429)
  })

  it('updates agent profile fields with Ed25519 signature auth', async () => {
    const identity = createIdentity()
    await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        beamId: 'profile@testorg.beam.directory',
        org: 'testorg',
        displayName: 'Profile Agent',
        capabilities: ['chat'],
        publicKey: identity.publicKeyBase64,
      }),
    })

    const profile = {
      description: 'Helpful support agent',
      logo_url: 'https://example.com/logo.png',
      website: 'https://example.com',
    }
    const timestamp = new Date().toISOString()
    const nonce = randomUUID()
    const signature = signProfileUpdate({
      privateKey: identity.privateKey,
      beamId: 'profile@testorg.beam.directory',
      profile,
      timestamp,
      nonce,
    })

    const response = await app.request(`http://localhost/agents/${encodeURIComponent('profile@testorg.beam.directory')}/profile`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-beam-timestamp': timestamp,
        'x-beam-nonce': nonce,
        'x-beam-signature': signature,
      },
      body: JSON.stringify(profile),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body['description']).toBe(profile.description)
    expect(body['logo_url']).toBe(profile.logo_url)
    expect(body['website']).toBe(profile.website)
  })

  it('browses agents with capability and verification filters', async () => {
    const first = createIdentity()
    const second = createIdentity()
    const third = createIdentity()

    for (const [beamId, publicKey] of [
      ['alpha@testorg.beam.directory', first.publicKeyBase64],
      ['beta@testorg.beam.directory', second.publicKeyBase64],
      ['gamma@testorg.beam.directory', third.publicKeyBase64],
    ] as const) {
      const response = await app.request('http://localhost/agents/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          beamId,
          org: 'testorg',
          displayName: beamId,
          capabilities: beamId.startsWith('gamma') ? ['search'] : ['chat', 'search'],
          publicKey,
        }),
      })
      expect(response.status).toBe(201)
    }

    db.prepare(`
      UPDATE agents
      SET verification_tier = ?, email_verified = ?, verified = ?, trust_score = ?
      WHERE beam_id = ?
    `).run('enterprise', 1, 1, 0.95, 'alpha@testorg.beam.directory')
    db.prepare(`
      UPDATE agents
      SET verification_tier = ?, email_verified = ?, verified = ?, trust_score = ?
      WHERE beam_id = ?
    `).run('verified', 1, 1, 0.75, 'beta@testorg.beam.directory')
    db.prepare(`
      UPDATE agents
      SET verification_tier = ?, email_verified = ?, verified = ?, trust_score = ?
      WHERE beam_id = ?
    `).run('business', 0, 0, 0.65, 'gamma@testorg.beam.directory')

    const response = await app.request('http://localhost/agents/browse?capability=chat&verification_tier=enterprise&verified_only=true&page=1&limit=10')
    expect(response.status).toBe(200)
    const body = await response.json() as { agents: Array<Record<string, unknown>>; total: number }
    expect(body.total).toBe(1)
    expect(body.agents).toHaveLength(1)
    expect(body.agents[0]?.beam_id).toBe('alpha@testorg.beam.directory')
  })

  it('returns directory agent stats', async () => {
    const sender = createIdentity()
    const recipient = createIdentity()

    for (const [beamId, publicKey, email] of [
      ['sender@testorg.beam.directory', sender.publicKeyBase64, 'sender@example.com'],
      ['recipient@testorg.beam.directory', recipient.publicKeyBase64, null],
    ] as const) {
      const response = await app.request('http://localhost/agents/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          beamId,
          org: 'testorg',
          displayName: beamId,
          capabilities: ['chat'],
          publicKey,
          email,
        }),
      })
      expect(response.status).toBe(201)
    }

    db.prepare('UPDATE agents SET email_verified = 1, verified = 1 WHERE beam_id = ?').run('sender@testorg.beam.directory')
    db.prepare(`
      INSERT INTO intent_log (
        nonce,
        from_beam_id,
        to_beam_id,
        intent_type,
        requested_at,
        completed_at,
        round_trip_latency_ms,
        status,
        error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('n1', 'sender@testorg.beam.directory', 'recipient@testorg.beam.directory', 'chat.send', new Date().toISOString(), new Date().toISOString(), 100, 'success', null)
    db.prepare(`
      INSERT INTO intent_log (
        nonce,
        from_beam_id,
        to_beam_id,
        intent_type,
        requested_at,
        completed_at,
        round_trip_latency_ms,
        status,
        error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('n2', 'recipient@testorg.beam.directory', 'sender@testorg.beam.directory', 'chat.reply', new Date().toISOString(), new Date().toISOString(), 300, 'success', null)
    db.prepare(`
      INSERT INTO intent_log (
        nonce,
        from_beam_id,
        to_beam_id,
        intent_type,
        requested_at,
        status,
        error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('n3', 'sender@testorg.beam.directory', 'recipient@testorg.beam.directory', 'chat.pending', new Date().toISOString(), 'pending', null)

    const response = await app.request('http://localhost/agents/stats')
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({
      total_agents: 2,
      verified_agents: 1,
      intents_processed: 3,
      avg_response_time_ms: 200,
    })
  })
})
