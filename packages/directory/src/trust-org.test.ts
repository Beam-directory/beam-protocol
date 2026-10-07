import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { createAdminSession } from './admin-auth.js'
import { assignDirectoryRole, createDatabase, getAgent, listAuditLog, registerAgent } from './db.js'
import { createAgentApiKey, hashApiKey } from './api-key.js'
import { signPayload } from './crypto.js'
import { getLocalDirectoryUrl } from './federation.js'
import { createApp } from './server.js'
import { isPublicAddress, bodyContainsVerification } from './trust/well-known.js'
import { isValidLei } from './trust/registry-format.js'

function publicKeyBase64(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

function adminHeaders(db: ReturnType<typeof createDatabase>): Record<string, string> {
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'trust-org-test-secret'
  assignDirectoryRole(db, {
    userId: 'reviewer@beam.directory',
    role: 'operator',
    directoryUrl: getLocalDirectoryUrl(),
  })
  const session = createAdminSession(db, { email: 'reviewer@beam.directory', role: 'operator' })
  return { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }
}

test('coppen.de and coppen.at are different organizations', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'trust-org-test-secret'
    const app = createApp(db)
    const de = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.20' },
      body: JSON.stringify({ name: 'coppen', displayName: 'COPPEN GmbH', domain: 'https://www.coppen.de' }),
    }))
    assert.equal(de.status, 201)
    const deBody = await de.json() as { domain: string; name: string }
    assert.equal(deBody.domain, 'coppen.de')
    assert.equal(deBody.name, 'coppen')

    const collided = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.21' },
      body: JSON.stringify({ name: 'coppen', displayName: 'Coppen AT', domain: 'coppen.at' }),
    }))
    assert.equal(collided.status, 409)

    const at = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.22' },
      body: JSON.stringify({ name: 'coppen-at', displayName: 'Coppen AT', domain: 'coppen.at' }),
    }))
    assert.equal(at.status, 201)
    const atBody = await at.json() as { domain: string; name: string }
    assert.equal(atBody.domain, 'coppen.at')
    assert.equal(atBody.name, 'coppen-at')
    assert.notEqual(deBody.domain, atBody.domain)
  } finally {
    db.close()
  }
})

test('organization agents require a client public key and API keys cannot rotate signing keys', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'trust-org-test-secret'
    const app = createApp(db)
    const created = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.30' },
      body: JSON.stringify({ name: 'acme', displayName: 'Acme', domain: 'acme.example' }),
    }))
    const { apiKey } = await created.json() as { apiKey: string }
    db.prepare('UPDATE orgs SET verified = 1, claim_expires_at = NULL WHERE name = ?').run('acme')

    const missingKey = await app.request(new Request('http://localhost/orgs/acme/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'otto' }),
    }))
    assert.equal(missingKey.status, 400)
    assert.equal((await missingKey.json() as { errorCode: string }).errorCode, 'PUBLIC_KEY_REQUIRED')

    const firstKey = generateKeyPairSync('ed25519')
    const publicKey = firstKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const issued = await app.request(new Request('http://localhost/orgs/acme/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'otto', publicKey }),
    }))
    assert.equal(issued.status, 201)
    const issuedBody = await issued.json() as { beamId: string; apiKey: string; privateKey?: string; publicKey: string }
    assert.equal(issuedBody.privateKey, undefined)
    assert.equal(issuedBody.publicKey, publicKey)

    const nextKey = publicKeyBase64()
    const apiKeyOnly = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(issuedBody.beamId)}/keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': issuedBody.apiKey },
      body: JSON.stringify({ new_public_key: nextKey, timestamp: new Date().toISOString() }),
    }))
    assert.equal(apiKeyOnly.status, 400)
    assert.equal((await apiKeyOnly.json() as { errorCode: string }).errorCode, 'INVALID_ROTATION_PROOF')
    assert.equal(getAgent(db, issuedBody.beamId)?.public_key, publicKey)

    const orgRotated = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(issuedBody.beamId)}/keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ new_public_key: nextKey, timestamp: new Date().toISOString() }),
    }))
    assert.equal(orgRotated.status, 200)
    assert.equal(getAgent(db, issuedBody.beamId)?.public_key, nextKey)

    const signedKey = generateKeyPairSync('ed25519')
    const signedPublic = signedKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const timestamp = new Date().toISOString()
    const signature = signPayload({
      action: 'keys.rotate',
      beamId: issuedBody.beamId,
      newPublicKey: signedPublic,
      timestamp,
    }, signedKey.privateKey)
    const wrongSigner = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(issuedBody.beamId)}/keys/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        new_public_key: signedPublic,
        timestamp,
        signature,
      }),
    }))
    assert.equal(wrongSigner.status, 400)

    const current = generateKeyPairSync('ed25519')
    registerAgent(db, {
      beamId: 'signer@acme.beam.directory',
      displayName: 'Signer',
      capabilities: [],
      publicKey: current.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      apiKeyHash: hashApiKey(createAgentApiKey('signer@acme.beam.directory')),
      org: 'acme',
    })
    const replacement = publicKeyBase64()
    const signedTimestamp = new Date().toISOString()
    const currentPublic = current.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const goodSignature = signPayload({
      action: 'keys.rotate',
      beamId: 'signer@acme.beam.directory',
      newPublicKey: replacement,
      timestamp: signedTimestamp,
    }, current.privateKey)
    const signed = await app.request(new Request('http://localhost/agents/signer@acme.beam.directory/keys/rotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        new_public_key: replacement,
        timestamp: signedTimestamp,
        signature: goodSignature,
      }),
    }))
    assert.equal(signed.status, 200)
    assert.equal(getAgent(db, 'signer@acme.beam.directory')?.public_key, replacement)
    assert.notEqual(currentPublic, replacement)
  } finally {
    db.close()
  }
})

test('registry filings stay pending until a reviewer records the representation decision', async () => {
  const db = createDatabase(':memory:')
  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'trust-org-test-secret'
    const app = createApp(db)
    const created = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.40' },
      body: JSON.stringify({ name: 'coppen', displayName: 'COPPEN GmbH', domain: 'coppen.de' }),
    }))
    const { apiKey } = await created.json() as { apiKey: string }
    db.prepare('UPDATE orgs SET verified = 1, claim_expires_at = NULL, domain_verified_via = ? WHERE name = ?').run('dns', 'coppen')

    const submitted = await app.request(new Request('http://localhost/orgs/coppen/registry', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        kind: 'handelsregister',
        country: 'DE',
        registrationNumber: 'HRB68658',
        registerCourt: 'Amtsgericht Ludwigshafen',
        legalName: 'COPPEN GmbH',
        applicantName: 'Tobias Kub',
        applicantRole: 'Geschäftsführer',
      }),
    }))
    assert.equal(submitted.status, 201)
    const submittedBody = await submitted.json() as { filing: { id: number; status: string; registrationNumber: string } }
    assert.equal(submittedBody.filing.status, 'pending')
    assert.equal(submittedBody.filing.registrationNumber, 'HRB 68658')

    const invalidLei = await app.request(new Request('http://localhost/orgs/coppen/registry', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        kind: 'lei',
        country: 'DE',
        registrationNumber: '969500QFCQP3Q4Q4Q4Q4',
        legalName: 'COPPEN GmbH',
        applicantName: 'Tobias Kub',
        applicantRole: 'prokurist',
      }),
    }))
    assert.equal(invalidLei.status, 400)

    const reviewed = await app.request(new Request(`http://localhost/admin/orgs/coppen/registry/${submittedBody.filing.id}/review`, {
      method: 'POST',
      headers: adminHeaders(db),
      body: JSON.stringify({
        decision: 'approved',
        note: 'Registerauszug zeigt den Antragsteller als Geschäftsführer.',
      }),
    }))
    assert.equal(reviewed.status, 200)
    assert.equal((await reviewed.json() as { filing: { status: string; reviewedBy: string } }).filing.status, 'approved')
    const audit = listAuditLog(db, { action: 'org.registry.reviewed', limit: 5 })
    assert.equal(audit.length, 1)
    assert.equal(audit[0]?.actor, 'reviewer@beam.directory')
    assert.equal(isValidLei('5493001KJTIIGC8Y1R12'), true)
    assert.equal(isPublicAddress('127.0.0.1'), false)
    assert.equal(isPublicAddress('10.1.2.3'), false)
    assert.equal(isPublicAddress('8.8.8.8'), true)
    assert.equal(bodyContainsVerification('beam-verification=abc\n', 'abc'), true)
    assert.equal(bodyContainsVerification('beam-verification=other', 'abc'), false)
  } finally {
    db.close()
  }
})
