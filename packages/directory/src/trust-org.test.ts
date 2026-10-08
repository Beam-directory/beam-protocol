import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import test from 'node:test'
import { createAdminSession } from './admin-auth.js'
import { assignDirectoryRole, createDatabase, createOrg, getAgent, getOrg, listAuditLog, markOrgVerified, registerAgent } from './db.js'
import { createAgentApiKey, hashApiKey } from './api-key.js'
import { signPayload } from './crypto.js'
import { getLocalDirectoryUrl } from './federation.js'
import { createApp } from './server.js'
import { ensureTrustOrgSchema } from './trust/schema.js'
import { namespaceForDomain } from './trust/org-domain.js'
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
    const deBody = await de.json() as { domain: string; name: string; requestedName: string }
    assert.equal(deBody.domain, 'coppen.de')
    assert.equal(deBody.name, 'coppen--de')
    assert.equal(deBody.requestedName, 'coppen')
    assert.equal(markOrgVerified(db, deBody.name)?.name, 'coppen')

    const at = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.22' },
      body: JSON.stringify({ name: 'coppen', displayName: 'Coppen AT', domain: 'coppen.at' }),
    }))
    assert.equal(at.status, 201)
    const atBody = await at.json() as { domain: string; name: string }
    assert.equal(atBody.domain, 'coppen.at')
    assert.equal(atBody.name, 'coppen--at')
    assert.equal(markOrgVerified(db, atBody.name)?.name, 'coppen--at')
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
    const { apiKey, name } = await created.json() as { apiKey: string; name: string }
    assert.equal(markOrgVerified(db, name)?.name, 'acme')

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
    const { apiKey, name } = await created.json() as { apiKey: string; name: string }
    assert.equal(markOrgVerified(db, name, 'dns')?.name, 'coppen')

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
    assert.equal(isPublicAddress('2001:4860:4860::8888'), true)
    for (const address of [
      '::ffff:7f00:1',
      '::ffff:127.0.0.1',
      '64:ff9b::a00:1',
      '2002:a00:1::1',
      'fec0::1',
      '::127.0.0.1',
      '198.18.0.1',
      '192.0.0.8',
      '::1',
      'fc00::1',
      'fe80::1',
    ]) {
      assert.equal(isPublicAddress(address), false, address)
    }
    assert.equal(bodyContainsVerification('beam-verification=abc\n', 'abc'), true)
    assert.equal(bodyContainsVerification('beam-verification=other', 'abc'), false)
  } finally {
    db.close()
  }
})

test('unverified claims do not occupy the public label and suffix slugs do not collide', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const claim = async (name: string, domain: string, ip: string) => {
      const response = await app.request(new Request('http://localhost/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ name, displayName: name, domain }),
      }))
      const body = await response.json() as { name?: string; requestedName?: string; errorCode?: string }
      return { status: response.status, body }
    }

    const squatter = await claim('coppen', 'coppen.com', '203.0.113.50')
    assert.equal(squatter.status, 201)
    assert.equal(squatter.body.name, 'coppen--com')
    assert.equal(getOrg(db, 'coppen'), null)

    const hyphenSquatter = await claim('coppen-de', 'coppen-de.com', '203.0.113.51')
    assert.equal(hyphenSquatter.status, 201)
    assert.equal(hyphenSquatter.body.name, 'coppen-de--com')

    const real = await claim('coppen', 'coppen.de', '203.0.113.52')
    assert.equal(real.status, 201)
    assert.equal(real.body.name, 'coppen--de')
    const promoted = markOrgVerified(db, 'coppen--de')
    assert.equal(promoted?.name, 'coppen')
    assert.equal(getOrg(db, 'coppen')?.domain, 'coppen.de')

    assert.equal(namespaceForDomain('coppen.co.uk')?.disambiguated, 'coppen--co-uk')
    assert.equal(namespaceForDomain('coppen-co.uk')?.disambiguated, 'coppen-co--uk')
    const uk = await claim('coppen', 'coppen.co.uk', '203.0.113.53')
    const hyphenUk = await claim('coppen-co', 'coppen-co.uk', '203.0.113.54')
    assert.equal(uk.status, 201)
    assert.equal(hyphenUk.status, 201)
    assert.notEqual(uk.body.name, hyphenUk.body.name)
  } finally {
    db.close()
  }
})

test('agent config changes to the encryption key require a signature, organization key, or admin', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    const created = await app.request(new Request('http://localhost/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.60' },
      body: JSON.stringify({ name: 'acme', displayName: 'Acme', domain: 'acme.example' }),
    }))
    const { apiKey, name } = await created.json() as { apiKey: string; name: string }
    assert.equal(markOrgVerified(db, name)?.name, 'acme')
    const signing = generateKeyPairSync('ed25519')
    const publicKey = signing.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const issued = await app.request(new Request('http://localhost/orgs/acme/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ agentName: 'otto', publicKey }),
    }))
    const { beamId, apiKey: agentKey } = await issued.json() as { beamId: string; apiKey: string }
    const dh = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const endpoint = 'https://hooks.example/beam'

    const apiKeyOnly = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': agentKey },
      body: JSON.stringify({ dhPublicKey: dh, httpEndpoint: endpoint }),
    }))
    assert.equal(apiKeyOnly.status, 401)
    assert.equal(getAgent(db, beamId)?.dh_public_key, null)

    const timestamp = new Date().toISOString()
    const nonce = `nonce-${randomBytes(12).toString('hex')}`
    const payload = { type: 'agent.config', beamId, httpEndpoint: endpoint, dhPublicKey: dh, timestamp, nonce }
    const signature = signPayload(payload, signing.privateKey)
    const signed = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
    }))
    assert.equal(signed.status, 200)
    assert.equal(getAgent(db, beamId)?.dh_public_key, dh)
    assert.equal(getAgent(db, beamId)?.http_endpoint, endpoint)

    const replay = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, signature }),
    }))
    assert.equal(replay.status, 409)

    const replacement = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const byOrg = await app.request(new Request(`http://localhost/agents/${encodeURIComponent(beamId)}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ dhPublicKey: replacement }),
    }))
    assert.equal(byOrg.status, 200)
    assert.equal(getAgent(db, beamId)?.dh_public_key, replacement)

    const removed = await app.request(new Request('http://localhost/agents/keypair/x25519', { method: 'POST' }))
    assert.equal(removed.status, 404)
  } finally {
    db.close()
  }
})

test('skipping the unique domain index is logged', () => {
  const db = createDatabase(':memory:')
  try {
    createOrg(db, {
      name: 'left',
      displayName: 'Left',
      domain: 'shared.example',
      apiKeyHash: 'a'.repeat(64),
      verificationToken: 'left-token',
    })
    db.exec('DROP INDEX IF EXISTS idx_orgs_domain_unique')
    createOrg(db, {
      name: 'right',
      displayName: 'Right',
      domain: 'shared.example',
      apiKeyHash: 'b'.repeat(64),
      verificationToken: 'right-token',
    })
    const lines: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      ensureTrustOrgSchema(db)
    } finally {
      console.error = original
    }
    assert.match(lines.join('\n'), /SKIPPED unique index idx_orgs_domain_unique/)
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_orgs_domain_unique'`).get(), undefined)
    assert.equal(listAuditLog(db, { action: 'org.domain_index.skipped', limit: 5 }).length, 1)
  } finally {
    db.close()
  }
})
