import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import Stripe from 'stripe'
import { publicIndividualName } from './trust/assertion.js'
import { signPayload, verifyPayload } from './crypto.js'
import { createDatabase, markOrgVerified } from './db.js'
import { createApp } from './server.js'
import { setStripeIdentitySessionCreatorForTests } from './trust/stripe-identity.js'

test('a public individual name is a first name and last initial, or the Beam address', () => {
  assert.equal(publicIndividualName({ givenName: 'Tobias', familyName: 'Kub', beamHandle: 'tobias' }), 'Tobias K.')
  assert.equal(publicIndividualName({ givenName: 'tobias', familyName: 'özdemir', beamHandle: 'tobias' }), 'tobias Ö.')
  assert.equal(publicIndividualName({ givenName: 'Tobias', familyName: 'Kub', beamHandle: 'tobias' })?.includes('Kub'), false)
  assert.equal(publicIndividualName({ givenName: 'Tobias', familyName: null, beamHandle: 'tobias' }), 'tobias@beam.directory')
  assert.equal(publicIndividualName({ givenName: null, familyName: null, beamHandle: 'tobias' }), 'tobias@beam.directory')
  assert.equal(publicIndividualName({ givenName: 'individual', familyName: null, beamHandle: null }), null)
})

const WEBHOOK_SECRET = 'whsec_test_mock_secret'
const SENTINELS = [
  'ID-SHOULD-NOT-STORE',
  'Secret Street 1',
  'DOC-SHOULD-NOT-STORE',
  'file_SHOULD_NOT_STORE',
  'dob-1990-01-02',
]

function keypair() {
  const keys = generateKeyPairSync('ed25519')
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey,
  }
}

let ipCounter = 40
function nextIp(): string {
  ipCounter += 1
  return `203.0.113.${ipCounter}`
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
    body: JSON.stringify(body),
  })
}

async function withApp(
  stripeOn: boolean,
  run: (ctx: {
    db: ReturnType<typeof createDatabase>
    app: ReturnType<typeof createApp>
    calls: () => number
  }) => Promise<void>,
) {
  const previous = {
    secret: process.env['STRIPE_SECRET_KEY'],
    hook: process.env['STRIPE_IDENTITY_WEBHOOK_SECRET'],
    priv: process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'],
    pub: process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'],
  }
  const db = createDatabase(':memory:')
  const app = createApp(db)
  if (stripeOn) {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_mock'
    process.env['STRIPE_IDENTITY_WEBHOOK_SECRET'] = WEBHOOK_SECRET
  } else {
    delete process.env['STRIPE_SECRET_KEY']
    delete process.env['STRIPE_IDENTITY_WEBHOOK_SECRET']
  }
  let calls = 0
  setStripeIdentitySessionCreatorForTests(async () => {
    calls += 1
    return {
      id: `vs_test_${calls}`,
      clientSecret: `cs_test_${calls}`,
      url: `https://verify.stripe.com/mock/${calls}`,
      status: 'requires_input',
    }
  })
  try {
    await run({ db, app, calls: () => calls })
  } finally {
    setStripeIdentitySessionCreatorForTests(null)
    for (const [key, value] of Object.entries({
      STRIPE_SECRET_KEY: previous.secret,
      STRIPE_IDENTITY_WEBHOOK_SECRET: previous.hook,
      BEAM_DIRECTORY_SIGNING_PRIVATE_KEY: previous.priv,
      BEAM_DIRECTORY_SIGNING_PUBLIC_KEY: previous.pub,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    db.close()
  }
}

async function createIndividual(
  app: ReturnType<typeof createApp>,
  handle = 'tobias',
  email = 'tobias@example.com',
) {
  const keys = keypair()
  const response = await app.request(jsonRequest('/people/individual', {
    email,
    handle,
    displayName: 'Tobias',
    publicKey: keys.publicKey,
  }))
  const body = await response.json() as {
    apiKey: string
    person: { id: string; beamId: string; subject: string; org: string | null }
    identity: { beamId: string; apiKey: string }
  }
  assert.equal(response.status, 201, JSON.stringify(body))
  return { ...body, keys }
}

function sessionObject(id: string, status: string, country = 'DE') {
  return {
    id,
    object: 'identity.verification_session',
    status,
    client_secret: 'cs_should_not_persist',
    url: 'https://verify.stripe.com/should-not-persist',
    verified_outputs: {
      first_name: 'Tobias',
      last_name: 'Kub',
      issuing_country: country,
      dob: { day: 2, month: 1, year: 1990, sentinel: 'dob-1990-01-02' },
      id_number: 'ID-SHOULD-NOT-STORE',
      address: { line1: 'Secret Street 1' },
    },
    last_verification_report: {
      document: {
        issuing_country: country,
        number: 'DOC-SHOULD-NOT-STORE',
        files: ['file_SHOULD_NOT_STORE'],
      },
    },
  }
}

function signedEvent(type: string, session: Record<string, unknown>, eventId: string) {
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    type,
    created: 1_760_000_000,
    data: { object: session },
  })
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
  return { payload, header }
}

async function postWebhook(app: ReturnType<typeof createApp>, type: string, sessionId: string, eventId: string, status: string) {
  const { payload, header } = signedEvent(type, sessionObject(sessionId, status), eventId)
  return app.request(new Request('http://localhost/webhooks/stripe/identity', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': header,
      'x-forwarded-for': nextIp(),
    },
    body: payload,
  }))
}

test('stripe identity stays off without both secrets, and manual KYC still records pending', async () => {
  await withApp(false, async ({ app, db }) => {
    const provider = await app.request(new Request('http://localhost/people/individual/provider', {
      headers: { 'x-forwarded-for': nextIp() },
    }))
    assert.equal(provider.status, 200)
    assert.deepEqual(await provider.json(), { provider: 'stripe_identity', enabled: false })

    const created = await createIndividual(app, 'ada', 'ada@example.com')
    const session = await app.request(jsonRequest('/people/individual/verification-sessions', {}, {
      authorization: `Bearer ${created.apiKey}`,
    }))
    assert.equal(session.status, 503)
    assert.equal((await session.json() as { errorCode: string }).errorCode, 'IDENTITY_PROVIDER_DISABLED')
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM kyc_sessions').get() as { count: number }).count, 0)

    const org = await app.request(jsonRequest('/orgs', { name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }))
    assert.equal(org.status, 201)
    const createdOrg = await org.json() as { apiKey: string; name: string }
    assert.equal(markOrgVerified(db, createdOrg.name)?.name, 'coppen')
    const apiKey = createdOrg.apiKey
    const personKey = keypair()
    const person = await app.request(jsonRequest('/orgs/coppen/people', {
      email: 'clara@coppen.de',
      displayName: 'Clara',
      role: 'Einkauf',
      publicKey: personKey.publicKey,
      rights: { actions: ['read'] },
    }, { 'x-api-key': apiKey }))
    assert.equal(person.status, 201)
    const personId = (await person.json() as { person: { id: string } }).person.id
    const kyc = await app.request(jsonRequest(`/orgs/coppen/people/${personId}/kyc`, { provider: 'manual' }, { 'x-api-key': apiKey }))
    assert.equal(kyc.status, 200)
    const reviewed = await kyc.json() as { person: { kycStatus: string; kycProvider: string } }
    assert.equal(reviewed.person.kycStatus, 'pending')
    assert.equal(reviewed.person.kycProvider, 'manual')
  })
})

test('an identity session requires a person key, stays singular, and ignores a bad signature', async () => {
  await withApp(true, async ({ app, db, calls }) => {
    const anon = await app.request(jsonRequest('/people/individual/verification-sessions', {}))
    assert.equal(anon.status, 401)

    const created = await createIndividual(app)
    assert.equal(created.person.subject, 'individual')
    assert.equal(created.person.org, null)
    assert.equal(created.person.beamId, 'tobias@beam.directory')
    assert.equal(created.identity.beamId, 'tobias@beam.directory')

    const first = await app.request(jsonRequest('/people/individual/verification-sessions', {}, {
      authorization: `Bearer ${created.apiKey}`,
    }))
    assert.equal(first.status, 201)
    const started = await first.json() as { verification: { sessionId: string; clientSecret: string; reused: boolean } }
    assert.equal(started.verification.sessionId, 'vs_test_1')
    assert.equal(started.verification.clientSecret, 'cs_test_1')
    assert.equal(started.verification.reused, false)
    assert.equal(calls(), 1)

    const again = await app.request(jsonRequest('/people/individual/verification-sessions', {}, {
      authorization: `Bearer ${created.apiKey}`,
    }))
    assert.equal(again.status, 409)
    const active = await again.json() as { errorCode: string; verification: { sessionId: string; reused: boolean } }
    assert.equal(active.errorCode, 'VERIFICATION_SESSION_ACTIVE')
    assert.equal(active.verification.sessionId, 'vs_test_1')
    assert.equal(active.verification.reused, true)
    assert.equal(calls(), 1)

    const bad = await app.request(new Request('http://localhost/webhooks/stripe/identity', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1,v1=deadbeef',
        'x-forwarded-for': nextIp(),
      },
      body: JSON.stringify({ id: 'evt_bad', type: 'identity.verification_session.verified' }),
    }))
    assert.equal(bad.status, 400)
    assert.equal((await bad.json() as { errorCode: string }).errorCode, 'INVALID_SIGNATURE')
    assert.equal(
      (db.prepare('SELECT kyc_status FROM persons WHERE id = ?').get(created.person.id) as { kyc_status: string }).kyc_status,
      'pending',
    )

    const needsInput = await postWebhook(app, 'identity.verification_session.requires_input', 'vs_test_1', 'evt_needs_input', 'requires_input')
    assert.equal(needsInput.status, 200)
    assert.equal((await needsInput.json() as { duplicate: boolean }).duplicate, false)
    const replay = await postWebhook(app, 'identity.verification_session.requires_input', 'vs_test_1', 'evt_needs_input', 'requires_input')
    assert.equal(replay.status, 200)
    assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true)
    assert.equal(
      (db.prepare('SELECT status FROM kyc_sessions WHERE id = ?').get('vs_test_1') as { status: string }).status,
      'requires_input',
    )

    const blocked = await app.request(jsonRequest('/people/individual/agents', {
      agentName: 'grok',
      displayName: 'Grok',
      publicKey: keypair().publicKey,
    }, { authorization: `Bearer ${created.apiKey}` }))
    assert.equal(blocked.status, 403)
    assert.equal((await blocked.json() as { errorCode: string }).errorCode, 'INDIVIDUAL_KYC_REQUIRED')
  })
})

test('canceled allows another session, verified stores only the minimised result, and a later cancel does not downgrade it', async () => {
  await withApp(true, async ({ app, db, calls }) => {
    const created = await createIndividual(app, 'mina', 'mina@example.com')
    const first = await app.request(jsonRequest('/people/individual/verification-sessions', {}, {
      authorization: `Bearer ${created.apiKey}`,
    }))
    assert.equal(first.status, 201)
    const canceled = await postWebhook(app, 'identity.verification_session.canceled', 'vs_test_1', 'evt_cancel_1', 'canceled')
    assert.equal(canceled.status, 200)
    assert.equal(
      (db.prepare('SELECT kyc_status, kyc_provider FROM persons WHERE id = ?').get(created.person.id) as { kyc_status: string; kyc_provider: string | null }).kyc_status,
      'unverified',
    )

    const second = await app.request(jsonRequest('/people/individual/verification-sessions', {}, {
      authorization: `Bearer ${created.apiKey}`,
    }))
    assert.equal(second.status, 201)
    assert.equal(calls(), 2)
    const verified = await postWebhook(app, 'identity.verification_session.verified', 'vs_test_2', 'evt_verified', 'verified')
    assert.equal(verified.status, 200)
    const person = db.prepare('SELECT * FROM persons WHERE id = ?').get(created.person.id) as {
      kyc_status: string
      kyc_provider: string
      verified_given_name: string
      verified_family_name: string
      issuing_country: string
      kyc_verified_at: string
    }
    assert.equal(person.kyc_status, 'verified')
    assert.equal(person.kyc_provider, 'stripe_identity')
    assert.equal(person.verified_given_name, 'Tobias')
    assert.equal(person.verified_family_name, 'Kub')
    assert.equal(person.issuing_country, 'DE')
    assert.ok(person.kyc_verified_at)

    const dump = JSON.stringify({
      persons: db.prepare('SELECT * FROM persons').all(),
      sessions: db.prepare('SELECT * FROM kyc_sessions').all(),
      events: db.prepare('SELECT * FROM stripe_identity_events').all(),
      audit: db.prepare('SELECT action, actor, target, details FROM audit_log').all(),
    })
    for (const sentinel of SENTINELS) assert.equal(dump.includes(sentinel), false, sentinel)
    assert.equal(dump.includes('cs_should_not_persist'), false)
    assert.equal(dump.includes('should-not-persist'), false)
    assert.equal(dump.includes('stripe_identity'), true)

    const later = await postWebhook(app, 'identity.verification_session.canceled', 'vs_test_2', 'evt_cancel_after', 'canceled')
    assert.equal(later.status, 200)
    assert.equal(
      (db.prepare('SELECT kyc_status, verified_given_name FROM persons WHERE id = ?').get(created.person.id) as { kyc_status: string; verified_given_name: string }).kyc_status,
      'verified',
    )
    assert.equal(
      (db.prepare('SELECT verified_given_name FROM persons WHERE id = ?').get(created.person.id) as { verified_given_name: string }).verified_given_name,
      'Tobias',
    )

    const duplicate = await postWebhook(app, 'identity.verification_session.verified', 'vs_test_2', 'evt_verified', 'verified')
    assert.equal((await duplicate.json() as { duplicate: boolean }).duplicate, true)

    for (let n = 0; n < 2; n += 1) {
      const extra = await app.request(jsonRequest('/people/individual/verification-sessions', {}, {
        authorization: `Bearer ${created.apiKey}`,
      }))
      assert.equal(extra.status, 409)
      assert.equal((await extra.json() as { errorCode: string }).errorCode, 'ALREADY_VERIFIED')
    }
  })
})

test('three sessions in an hour stop a fourth, and a verified individual assertion names no company', async () => {
  await withApp(true, async ({ app, db }) => {
    const created = await createIndividual(app, 'noah', 'noah@example.com')
    for (let n = 1; n <= 3; n += 1) {
      const started = await app.request(jsonRequest('/people/individual/verification-sessions', {}, {
        authorization: `Bearer ${created.apiKey}`,
      }))
      assert.equal(started.status, 201)
      const body = await started.json() as { verification: { sessionId: string } }
      const canceled = await postWebhook(
        app,
        'identity.verification_session.canceled',
        body.verification.sessionId,
        `evt_hour_${n}`,
        'canceled',
      )
      assert.equal(canceled.status, 200)
    }
    const limited = await app.request(jsonRequest('/people/individual/verification-sessions', {}, {
      authorization: `Bearer ${created.apiKey}`,
    }))
    assert.equal(limited.status, 429)
    assert.equal((await limited.json() as { errorCode: string }).errorCode, 'IDENTITY_RATE_LIMITED')

    const verifiedPerson = await createIndividual(app, 'lina', 'lina@example.com')
    const session = await app.request(jsonRequest('/people/individual/verification-sessions', {}, {
      authorization: `Bearer ${verifiedPerson.apiKey}`,
    }))
    assert.equal(session.status, 201)
    const sessionId = (await session.json() as { verification: { sessionId: string } }).verification.sessionId
    assert.equal((await postWebhook(app, 'identity.verification_session.verified', sessionId, 'evt_lina', 'verified')).status, 200)

    const agentKey = keypair()
    const agent = await app.request(jsonRequest('/people/individual/agents', {
      agentName: 'grok',
      displayName: 'Grok',
      publicKey: agentKey.publicKey,
      capabilities: ['chat'],
    }, { authorization: `Bearer ${verifiedPerson.apiKey}` }))
    assert.equal(agent.status, 201)
    const beamId = (await agent.json() as { beamId: string; org: null }).beamId
    assert.equal(beamId, 'grok@beam.directory')

    const tooWide = {
      type: 'mandate' as const,
      jti: 'mandate-too-wide',
      version: 1 as const,
      personId: verifiedPerson.person.id,
      agentBeamId: beamId,
      org: null,
      scopes: { actions: ['order'], order: { maxAmount: '100000.01', currency: 'EUR' } },
      expiresAt: '2027-01-01T00:00:00.000Z',
      escalationPersonId: null,
    }
    const rejected = await app.request(jsonRequest(`/agents/${encodeURIComponent(beamId)}/mandates`, {
      jti: tooWide.jti,
      scopes: tooWide.scopes,
      expiresAt: tooWide.expiresAt,
      escalationPersonId: null,
      signature: signPayload(tooWide, verifiedPerson.keys.privateKey),
    }))
    assert.equal(rejected.status, 400)
    assert.equal((await rejected.json() as { errorCode: string }).errorCode, 'MANDATE_EXCEEDS_RIGHTS')

    const within = { ...tooWide, jti: 'mandate-within', scopes: { actions: ['read'] } }
    const signed = await app.request(jsonRequest(`/agents/${encodeURIComponent(beamId)}/mandates`, {
      jti: within.jti,
      scopes: within.scopes,
      expiresAt: within.expiresAt,
      escalationPersonId: null,
      signature: signPayload(within, verifiedPerson.keys.privateKey),
    }))
    assert.equal(signed.status, 201)

    const hidden = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`, {
      headers: { 'x-forwarded-for': nextIp() },
    }))
    assert.equal(hidden.status, 404)
    const issuer = keypair()
    process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'] = issuer.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'] = issuer.publicKey
    const owned = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`, {
      headers: { authorization: `Bearer ${verifiedPerson.apiKey}`, 'x-forwarded-for': nextIp() },
    }))
    assert.equal(owned.status, 200)
    const assertion = await owned.json() as {
      org: null
      person: { subject: string; level: string; provider: string; role: string; kycStatus: string; publicName: string }
      mandate: { jti: string } | null
      signature: string
      publicKey: string
    }
    assert.equal(assertion.org, null)
    assert.equal(assertion.person.subject, 'individual')
    assert.equal(assertion.person.level, 'person_id_verified')
    assert.equal(assertion.person.provider, 'stripe_identity')
    assert.equal(assertion.person.role, 'individual')
    assert.equal(assertion.person.publicName, 'Tobias K.')
    assert.equal(assertion.mandate?.jti, 'mandate-within')
    const encoded = JSON.stringify(assertion)
    assert.equal(encoded.includes('Tobias K.'), true)
    assert.equal(encoded.includes('Kub'), false)
    assert.equal(encoded.includes('coppen'), false)
    const { signature, publicKey, ...unsigned } = assertion
    assert.equal(verifyPayload(unsigned, signature, publicKey), true)

    db.prepare(`UPDATE agents SET visibility = 'public' WHERE beam_id = ?`).run(beamId)
    const pub = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`, {
      headers: { 'x-forwarded-for': nextIp() },
    }))
    assert.equal(pub.status, 200)
  })
})

test('a company trust assertion keeps the organisation person shape', async () => {
  await withApp(false, async ({ app, db }) => {
    const org = await app.request(jsonRequest('/orgs', { name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }))
    assert.equal(org.status, 201)
    const createdOrg = await org.json() as { apiKey: string; name: string }
    const apiKey = createdOrg.apiKey
    assert.equal(markOrgVerified(db, createdOrg.name)?.name, 'coppen')
    const personKey = keypair()
    const person = await app.request(jsonRequest('/orgs/coppen/people', {
      email: 'clara@coppen.de',
      displayName: 'Clara',
      role: 'Einkauf',
      publicKey: personKey.publicKey,
      rights: { actions: ['read'] },
    }, { 'x-api-key': apiKey }))
    assert.equal(person.status, 201)
    const personId = (await person.json() as { person: { id: string } }).person.id
    db.prepare(`UPDATE persons SET kyc_status = 'verified', kyc_provider = 'manual' WHERE id = ?`).run(personId)
    const agentKey = keypair()
    const agent = await app.request(jsonRequest('/orgs/coppen/agents', {
      agentName: 'buyer',
      publicKey: agentKey.publicKey,
      responsiblePersonId: personId,
    }, { 'x-api-key': apiKey }))
    assert.equal(agent.status, 201)
    const beamId = (await agent.json() as { beamId: string }).beamId
    const mandate = {
      type: 'mandate' as const,
      jti: 'company-mandate',
      version: 1 as const,
      personId,
      agentBeamId: beamId,
      org: 'coppen',
      scopes: { actions: ['read'] },
      expiresAt: '2027-01-01T00:00:00.000Z',
      escalationPersonId: null,
    }
    const signed = await app.request(jsonRequest(`/agents/${encodeURIComponent(beamId)}/mandates`, {
      jti: mandate.jti,
      scopes: mandate.scopes,
      expiresAt: mandate.expiresAt,
      escalationPersonId: null,
      signature: signPayload(mandate, personKey.privateKey),
    }))
    assert.equal(signed.status, 201)
    const issuer = keypair()
    process.env['BEAM_DIRECTORY_SIGNING_PRIVATE_KEY'] = issuer.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    process.env['BEAM_DIRECTORY_SIGNING_PUBLIC_KEY'] = issuer.publicKey
    db.prepare(`UPDATE agents SET visibility = 'public' WHERE beam_id = ?`).run(beamId)
    const response = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/trust-assertion`, {
      headers: { 'x-forwarded-for': nextIp() },
    }))
    assert.equal(response.status, 200)
    const assertion = await response.json() as { org: { name: string }; person: Record<string, unknown> }
    assert.equal(assertion.org.name, 'coppen')
    assert.deepEqual(Object.keys(assertion.person).sort(), ['kycStatus', 'ref', 'role'])
  })
})
