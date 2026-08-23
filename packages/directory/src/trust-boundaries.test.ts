import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Hono } from 'hono'
import type Stripe from 'stripe'
import { assignDirectoryRole, createDatabase, createDomainVerification, createOrg, getAgent, registerAgent, updateDomainVerificationStatus } from './db.js'
import { createAdminSession } from './admin-auth.js'
import { createAgentApiKey, hashApiKey } from './api-key.js'
import { getLocalDirectoryUrl } from './federation.js'
import { billingRouter } from './routes/billing.js'
import { businessVerificationRouter } from './routes/business-verify.js'
import { agentsRouter } from './routes/agents.js'

function registerKeyedAgent(db: ReturnType<typeof createDatabase>, beamId: string) {
  const apiKey = createAgentApiKey(beamId)
  const { publicKey } = generateKeyPairSync('ed25519')
  registerAgent(db, {
    beamId,
    displayName: 'Trust Boundary Agent',
    capabilities: ['conversation.message'],
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    org: 'acme',
    apiKeyHash: hashApiKey(apiKey),
  })
  return apiKey
}

describe('billing and identity assurance trust boundaries', () => {
  let db: ReturnType<typeof createDatabase>

  beforeEach(() => {
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_test_only'
    process.env['APP_URL'] = 'https://beam.directory'
    process.env['JWT_SECRET'] = 'trust-boundaries-test-secret'
    db = createDatabase(':memory:')
  })

  afterEach(() => {
    delete process.env['STRIPE_WEBHOOK_SECRET']
    delete process.env['APP_URL']
    delete process.env['JWT_SECRET']
    db.close()
  })

  it('requires agent ownership for checkout and never converts payment into verification', async () => {
    const beamId = 'buyer@acme.beam.directory'
    const apiKey = registerKeyedAgent(db, beamId)
    let checkoutParams: Record<string, unknown> | null = null

    const fakeStripe = {
      checkout: {
        sessions: {
          create: async (params: Record<string, unknown>) => {
            checkoutParams = params
            return { id: 'cs_test', url: 'https://checkout.stripe.test/session' }
          },
        },
      },
      webhooks: {
        constructEvent: (rawBody: string) => JSON.parse(rawBody),
      },
    } as unknown as Stripe

    const app = new Hono()
    app.route('/billing', billingRouter(db, fakeStripe))

    const unauthorized = await app.request('http://localhost/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ beamId, plan: 'pro' }),
    })
    assert.equal(unauthorized.status, 401)

    const checkout = await app.request('http://localhost/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        beamId,
        plan: 'pro',
        successUrl: 'https://evil.example/phish',
      }),
    })
    assert.equal(checkout.status, 200)
    assert.equal(checkoutParams?.['success_url'], 'https://beam.directory/billing/success?session_id={CHECKOUT_SESSION_ID}')

    const webhook = await app.request('http://localhost/billing/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid-test-signature' },
      body: JSON.stringify({
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_test',
            subscription: 'sub_test',
            metadata: { beam_id: beamId, plan: 'pro' },
          },
        },
      }),
    })
    assert.equal(webhook.status, 200)

    const agent = getAgent(db, beamId)
    assert.equal(agent?.plan, 'pro')
    assert.equal(agent?.verification_tier, 'basic')
    assert.equal(agent?.verified, 0)

    const privateStatus = await app.request(`http://localhost/billing/status/${encodeURIComponent(beamId)}`)
    assert.equal(privateStatus.status, 401)
  })

  it('rejects self-asserted assurance and prevents unauthenticated Beam-ID takeover', async () => {
    const beamId = 'self-claim@beam.directory'
    const { publicKey } = generateKeyPairSync('ed25519')
    const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const app = new Hono()
    app.route('/agents', agentsRouter(db))
    const body = {
      beamId,
      displayName: 'Self Claim',
      capabilities: ['conversation.message'],
      publicKey: publicKeyBase64,
      email: 'operator@acme.example',
    }

    const selfAsserted = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, emailVerified: true, verificationTier: 'business' }),
    })
    assert.equal(selfAsserted.status, 403)
    assert.equal((await selfAsserted.json() as { errorCode: string }).errorCode, 'ASSURANCE_CLAIM_NOT_ALLOWED')
    assert.equal(getAgent(db, beamId), null)

    const registered = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(registered.status, 201)
    assert.equal(getAgent(db, beamId)?.verification_tier, 'basic')
    assert.equal(getAgent(db, beamId)?.email_verified, 0)

    db.prepare("UPDATE agents SET verification_tier = 'business', verified = 1 WHERE beam_id = ?").run(beamId)
    const beforeTakeover = getAgent(db, beamId)
    const { publicKey: attackerPublicKey } = generateKeyPairSync('ed25519')
    const reRegistered = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        publicKey: attackerPublicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      }),
    })
    assert.equal(reRegistered.status, 409)
    assert.equal((await reRegistered.json() as { errorCode: string }).errorCode, 'BEAM_ID_ALREADY_REGISTERED')
    assert.equal(getAgent(db, beamId)?.public_key, beforeTakeover?.public_key)
    assert.equal(getAgent(db, beamId)?.api_key_hash, beforeTakeover?.api_key_hash)
    assert.equal(getAgent(db, beamId)?.verification_tier, 'business')
    assert.equal(getAgent(db, beamId)?.verified, 1)
  })

  it('requires organization namespace ownership for public organization registration', async () => {
    const orgApiKey = 'beam_org_acme_owner_key'
    createOrg(db, {
      name: 'acme',
      displayName: 'Acme GmbH',
      apiKeyHash: hashApiKey(orgApiKey),
      verificationToken: 'acme-verification-token',
    })
    const { publicKey } = generateKeyPairSync('ed25519')
    const body = {
      beamId: 'grok@acme.beam.directory',
      org: 'acme',
      displayName: 'Acme Grok',
      capabilities: ['conversation.message'],
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    }
    const app = new Hono()
    app.route('/agents', agentsRouter(db))

    const unauthorized = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(unauthorized.status, 403)
    assert.equal((await unauthorized.json() as { errorCode: string }).errorCode, 'ORG_OWNERSHIP_REQUIRED')
    assert.equal(getAgent(db, body.beamId), null)

    const authorized = await app.request('http://localhost/agents/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': orgApiKey },
      body: JSON.stringify(body),
    })
    assert.equal(authorized.status, 201)
    assert.match(authorized.headers.get('cache-control') ?? '', /no-store/i)
    assert.match((await authorized.json() as { apiKey: string }).apiKey, /^bk_/)
  })

  it('keeps business verification pending until an administrator reviews registry and domain evidence', async () => {
    const beamId = 'operator@acme.beam.directory'
    const apiKey = registerKeyedAgent(db, beamId)
    const app = new Hono()
    app.route('/agents', businessVerificationRouter(db))

    const unauthorized = await app.request(`http://localhost/agents/${encodeURIComponent(beamId)}/verify-business`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ country: 'DE', registrationNumber: 'HRB 12345', legalName: 'Acme GmbH' }),
    })
    assert.equal(unauthorized.status, 401)

    const submitted = await app.request(`http://localhost/agents/${encodeURIComponent(beamId)}/verify-business`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ country: 'DE', registrationNumber: 'HRB 12345', legalName: 'Acme GmbH' }),
    })
    assert.equal(submitted.status, 202)
    const submission = await submitted.json() as { verification: { id: number }; verified: boolean; status: string }
    assert.equal(submission.verified, false)
    assert.equal(submission.status, 'pending')
    assert.equal(getAgent(db, beamId)?.verification_tier, 'basic')

    assignDirectoryRole(db, {
      userId: 'reviewer@beam.directory',
      role: 'admin',
      directoryUrl: getLocalDirectoryUrl(),
    })
    const admin = createAdminSession(db, { email: 'reviewer@beam.directory', role: 'admin' })
    const reviewUrl = `http://localhost/agents/${encodeURIComponent(beamId)}/business-review`
    const reviewBody = {
      verificationId: submission.verification.id,
      decision: 'approve',
      evidenceReference: 'https://register.example/evidence/12345',
    }

    const missingDomain = await app.request(reviewUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
      body: JSON.stringify(reviewBody),
    })
    assert.equal(missingDomain.status, 409)

    const domain = createDomainVerification(db, {
      beamId,
      domain: 'acme.example',
      challengeToken: 'challenge',
    })
    updateDomainVerificationStatus(db, domain.id, 'verified')

    const approved = await app.request(reviewUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
      body: JSON.stringify(reviewBody),
    })
    assert.equal(approved.status, 200)
    const approval = await approved.json() as { verified: boolean; credential: unknown }
    assert.equal(approval.verified, true)
    assert.ok(approval.credential)
    assert.equal(getAgent(db, beamId)?.verification_tier, 'business')
  })

  it('does not let a subscription cancellation erase independent verification', async () => {
    const beamId = 'independent@acme.beam.directory'
    registerKeyedAgent(db, beamId)
    db.prepare("UPDATE agents SET plan = 'business', verification_tier = 'business', verified = 1 WHERE beam_id = ?").run(beamId)
    db.prepare(`
      INSERT INTO billing (beam_id, stripe_subscription_id, tier, status, created_at)
      VALUES (?, 'sub_cancel', 'business', 'active', ?)
    `).run(beamId, new Date().toISOString())

    const fakeStripe = {
      webhooks: { constructEvent: (rawBody: string) => JSON.parse(rawBody) },
    } as unknown as Stripe
    const app = new Hono()
    app.route('/billing', billingRouter(db, fakeStripe))

    const response = await app.request('http://localhost/billing/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'valid-test-signature' },
      body: JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_cancel' } } }),
    })
    assert.equal(response.status, 200)
    assert.equal(getAgent(db, beamId)?.plan, 'free')
    assert.equal(getAgent(db, beamId)?.verification_tier, 'business')
    assert.equal(getAgent(db, beamId)?.verified, 1)
  })
})
