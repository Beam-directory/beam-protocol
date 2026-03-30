import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminSession } from '../src/admin-auth.js'
import {
  assignDirectoryRole,
  createDatabase,
  listAuditLog,
  listShieldAuditLog,
  updatePublicEndpointShieldPolicy,
} from '../src/db.js'
import { getLocalDirectoryUrl } from '../src/federation.js'
import { createApp } from '../src/server.js'
import type { IntentFrame } from '../src/types.js'

function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey,
  }
}

function buildRegisterBody(beamId: string, publicKey: string) {
  return {
    beamId,
    displayName: beamId.split('@')[0],
    capabilities: ['agent.ping'],
    publicKey,
    visibility: 'public',
  }
}

function buildSignedIntent(frame: Omit<IntentFrame, 'signature'>, privateKey: ReturnType<typeof generateIdentity>['privateKey']): IntentFrame {
  const payload = JSON.stringify({
    type: 'intent',
    from: frame.from,
    to: frame.to,
    intent: frame.intent,
    payload: frame.payload,
    timestamp: frame.timestamp,
    nonce: frame.nonce,
  })

  return {
    ...frame,
    signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  }
}

describe('public endpoint abuse controls', () => {
  let db: ReturnType<typeof createDatabase>

  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', 'secret-admin-jwt')
    db = createDatabase(':memory:')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    db.close()
  })

  it('updates public endpoint policy and throttles registration bursts by IP', async () => {
    assignDirectoryRole(db, {
      userId: 'ops@example.com',
      role: 'admin',
      directoryUrl: getLocalDirectoryUrl(),
    })
    const adminSession = createAdminSession(db, {
      email: 'ops@example.com',
      role: 'admin',
    })
    const app = createApp(db)

    const patchResponse = await app.request(new Request('http://localhost/shield/policies/public-endpoints', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${adminSession.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ registrationPerMinute: 2 }),
    }))
    expect(patchResponse.status).toBe(200)

    const identity = generateIdentity()
    const headers = {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.5',
    }

    const first = await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRegisterBody('alpha@beam.directory', identity.publicKey)),
    }))
    const second = await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRegisterBody('beta@beam.directory', identity.publicKey)),
    }))
    const third = await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRegisterBody('gamma@beam.directory', identity.publicKey)),
    }))

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(third.status).toBe(429)

    const audit = listAuditLog(db, { action: 'public.rate_limit.throttled' })
    expect(audit[0]?.actor).toBe('ip:203.0.113.5')
    const shieldAudit = listShieldAuditLog(db, { senderBeamId: 'ip:203.0.113.5' })
    expect(shieldAudit.length).toBeGreaterThan(0)
  })

  it('allows trusted IPs to bypass public endpoint throttles', async () => {
    updatePublicEndpointShieldPolicy(db, {
      registrationPerMinute: 1,
      trustedIps: ['203.0.113.44'],
    })

    const app = createApp(db)
    const identity = generateIdentity()
    const headers = {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.44',
    }

    const first = await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRegisterBody('trusted-1@beam.directory', identity.publicKey)),
    }))
    const second = await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRegisterBody('trusted-2@beam.directory', identity.publicKey)),
    }))

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
  })

  it('degrades malformed registration bursts gracefully', async () => {
    updatePublicEndpointShieldPolicy(db, { registrationPerMinute: 2 })
    const app = createApp(db)

    const headers = {
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.10',
    }

    const first = await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers,
      body: '{"beamId"',
    }))
    const second = await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers,
      body: '{"beamId"',
    }))
    const third = await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers,
      body: '{"beamId"',
    }))

    expect(first.status).toBe(400)
    expect(second.status).toBe(400)
    expect(third.status).toBe(429)
  })

  it('rate limits /intents/send by sender identity across IPs and logs shield blocks', async () => {
    updatePublicEndpointShieldPolicy(db, {
      intentSendPerIpPerMinute: 10,
      intentSendPerSenderPerMinute: 1,
    })
    const senderIdentity = generateIdentity()
    const receiverIdentity = generateIdentity()
    const app = createApp(db)

    await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildRegisterBody('sender@beam.directory', senderIdentity.publicKey)),
    }))
    await app.request(new Request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildRegisterBody('receiver@beam.directory', receiverIdentity.publicKey)),
    }))

    db.prepare(`UPDATE agents SET shield_config = ? WHERE beam_id = ?`).run(JSON.stringify({
      mode: 'closed',
      allowlist: [],
      blocklist: [],
      minTrust: 0.3,
      rateLimit: 20,
    }), 'receiver@beam.directory')

    const firstFrame = buildSignedIntent({
      v: '1',
      from: 'sender@beam.directory',
      to: 'receiver@beam.directory',
      intent: 'agent.ping',
      payload: { message: 'one' },
      nonce: randomUUID(),
      timestamp: new Date().toISOString(),
    }, senderIdentity.privateKey)
    const secondFrame = buildSignedIntent({
      ...firstFrame,
      payload: { message: 'two' },
      nonce: randomUUID(),
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    }, senderIdentity.privateKey)

    const first = await app.request(new Request('http://localhost/intents/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.11',
      },
      body: JSON.stringify(firstFrame),
    }))
    const second = await app.request(new Request('http://localhost/intents/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.12',
      },
      body: JSON.stringify(secondFrame),
    }))

    expect(first.status).toBe(403)
    expect(second.status).toBe(429)

    const shieldLogs = listShieldAuditLog(db, { senderBeamId: 'sender@beam.directory' })
    expect(shieldLogs.length).toBeGreaterThan(0)
    expect(shieldLogs.some((entry) => entry.decision === 'reject')).toBe(true)
  })
})
