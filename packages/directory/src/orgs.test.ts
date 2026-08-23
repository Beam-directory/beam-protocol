import assert from 'node:assert/strict'
import test from 'node:test'
import { createDatabase, getOrg, markOrgVerified, updatePublicEndpointShieldPolicy } from './db.js'
import { createApp } from './server.js'

function createOrgRequest(
  app: ReturnType<typeof createApp>,
  body: Record<string, unknown>,
  ip = '203.0.113.80',
) {
  return app.request(new Request('http://localhost/orgs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  }))
}

test('organization claims require a matching registrable domain and expire fail-closed', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'org-claim-test-secret'
    const app = createApp(db)

    const missingDomain = await createOrgRequest(app, { name: 'acme', displayName: 'Acme' })
    assert.equal(missingDomain.status, 400)
    assert.equal((await missingDomain.json() as { errorCode: string }).errorCode, 'INVALID_DOMAIN')

    const mismatch = await createOrgRequest(app, {
      name: 'northwind',
      displayName: 'Northwind',
      domain: 'www.acme.example',
    })
    assert.equal(mismatch.status, 403)
    assert.equal((await mismatch.json() as { errorCode: string }).errorCode, 'ORG_NAMESPACE_DOMAIN_MISMATCH')

    const created = await createOrgRequest(app, {
      name: 'acme',
      displayName: 'Acme',
      domain: 'www.acme.example',
    })
    assert.equal(created.status, 201)
    const createdBody = await created.json() as { apiKey: string; domain: string; claimExpiresAt: string }
    assert.equal(createdBody.domain, 'acme.example')
    assert.ok(Date.parse(createdBody.claimExpiresAt) > Date.now())
    assert.match(created.headers.get('cache-control') ?? '', /no-store/i)

    const beforeVerification = await app.request(new Request('http://localhost/orgs/acme/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': createdBody.apiKey },
      body: JSON.stringify({ agentName: 'grok', capabilities: ['conversation.message'] }),
    }))
    assert.equal(beforeVerification.status, 403)
    assert.equal((await beforeVerification.json() as { errorCode: string }).errorCode, 'ORG_VERIFICATION_REQUIRED')

    db.prepare('UPDATE orgs SET claim_expires_at = ? WHERE name = ?').run(
      new Date(Date.now() - 1_000).toISOString(),
      'acme',
    )
    const expiredVerification = await app.request(new Request('http://localhost/orgs/acme/verify', {
      method: 'POST',
      headers: { 'x-api-key': createdBody.apiKey },
    }))
    assert.equal(expiredVerification.status, 410)
    assert.equal((await expiredVerification.json() as { errorCode: string }).errorCode, 'ORG_CLAIM_EXPIRED')

    const reclaimed = await createOrgRequest(app, {
      name: 'acme',
      displayName: 'Acme New Owner',
      domain: 'acme.example',
    }, '203.0.113.81')
    assert.equal(reclaimed.status, 201)
    const reclaimedBody = await reclaimed.json() as { apiKey: string }
    assert.notEqual(reclaimedBody.apiKey, createdBody.apiKey)
    assert.equal(getOrg(db, 'acme')?.display_name, 'Acme New Owner')
  } finally {
    db.close()
  }
})

test('verified organization claims issue Beam IDs and clear claim expiry', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'org-claim-test-secret'
    const app = createApp(db)
    const created = await createOrgRequest(app, {
      name: 'acme',
      displayName: 'Acme',
      domain: 'acme.example',
    })
    const { apiKey } = await created.json() as { apiKey: string }

    const verified = markOrgVerified(db, 'acme')
    assert.equal(verified?.verified, 1)
    assert.equal(verified?.claim_expires_at, null)

    const issued = await app.request(new Request('http://localhost/orgs/acme/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'grok', capabilities: ['conversation.message'] }),
    }))
    assert.equal(issued.status, 201)
    assert.equal((await issued.json() as { beamId: string }).beamId, 'grok@acme.beam.directory')
  } finally {
    db.close()
  }
})

test('organization claim endpoints use the public registration rate limit', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'org-claim-test-secret'
    updatePublicEndpointShieldPolicy(db, { registrationPerMinute: 1 })
    const app = createApp(db)

    const first = await createOrgRequest(app, { name: 'bad', domain: 'acme.example' }, '198.51.100.91')
    assert.equal(first.status, 403)
    const throttled = await createOrgRequest(app, { name: 'northwind', domain: 'northwind.example' }, '198.51.100.91')
    assert.equal(throttled.status, 429)
  } finally {
    db.close()
  }
})
