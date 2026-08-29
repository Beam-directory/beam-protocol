import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { createDatabase, getAgent } from './db.js'
import { createApp } from './server.js'

function publicKeyBase64(): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
}

function withLocalClaimLinks(): () => void {
  const previous = {
    BEAM_ALLOW_LOCAL_CLAIM_URLS: process.env['BEAM_ALLOW_LOCAL_CLAIM_URLS'],
    PUBLIC_SITE_URL: process.env['PUBLIC_SITE_URL'],
    SMTP_HOST: process.env['SMTP_HOST'],
    RESEND_API_KEY: process.env['RESEND_API_KEY'],
  }
  process.env['BEAM_ALLOW_LOCAL_CLAIM_URLS'] = 'true'
  process.env['PUBLIC_SITE_URL'] = 'https://beam.directory'
  delete process.env['SMTP_HOST']
  delete process.env['RESEND_API_KEY']

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('personal identity claim verifies email before creating a private Beam identity', async () => {
  const restore = withLocalClaimLinks()
  const db = createDatabase(':memory:')
  const app = createApp(db)

  try {
    const request = await app.request('http://localhost/identity-claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Tobias Kub',
        handle: 'tobias-kub',
        email: 'tobias@example.com',
      }),
    })

    assert.equal(request.status, 202)
    const requested = await request.json() as { beamId: string; claimUrl: string }
    assert.equal(requested.beamId, 'tobias-kub@beam.directory')
    const token = new URLSearchParams(new URL(requested.claimUrl).hash.slice(1)).get('token')
    assert.ok(token)
    const rawTokenMatches = db.prepare('SELECT COUNT(*) AS count FROM identity_claims WHERE token_hash = ?')
      .get(token) as { count: number }
    assert.equal(rawTokenMatches.count, 0)

    const pending = await app.request('http://localhost/identity-claims/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    assert.equal(pending.status, 200)
    const pendingBody = await pending.json() as { status: string; email: string }
    assert.equal(pendingBody.status, 'ready')
    assert.equal(pendingBody.email, 'to****@example.com')

    const complete = await app.request('http://localhost/identity-claims/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, publicKey: publicKeyBase64() }),
    })

    assert.equal(complete.status, 201)
    assert.equal(complete.headers.get('cache-control'), 'no-store')
    const completed = await complete.json() as {
      status: string
      identity: { beam_id: string; did: string; personal: boolean; identity_kind: string; email_verified: boolean; visibility: string }
      credential: { apiKey: string; directoryUrl: string }
    }
    assert.equal(completed.status, 'claimed')
    assert.equal(completed.identity.beam_id, 'tobias-kub@beam.directory')
    assert.equal(completed.identity.did, 'did:beam:tobias-kub')
    assert.equal(completed.identity.personal, true)
    assert.equal(completed.identity.identity_kind, 'person')
    assert.equal(completed.identity.email_verified, true)
    assert.equal(completed.identity.visibility, 'unlisted')
    assert.match(completed.credential.apiKey, /^bk_/)

    const stored = getAgent(db, 'tobias-kub@beam.directory')
    assert.equal(stored?.email_verified, 1)
    assert.equal(stored?.visibility, 'unlisted')

    const replay = await app.request('http://localhost/identity-claims/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, publicKey: publicKeyBase64() }),
    })
    assert.equal(replay.status, 404)
  } finally {
    db.close()
    restore()
  }
})

test('identity claim rejects unavailable handles and invalid signing keys', async () => {
  const restore = withLocalClaimLinks()
  const db = createDatabase(':memory:')
  const app = createApp(db)

  try {
    const tooShort = await app.request('http://localhost/identity-claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Short Name', handle: 'x', email: 'short@example.com' }),
    })
    assert.equal(tooShort.status, 400)

    const first = await app.request('http://localhost/identity-claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'First Person', handle: 'shared-name', email: 'first@example.com' }),
    })
    assert.equal(first.status, 202)
    const firstToken = new URLSearchParams(new URL(((await first.json()) as { claimUrl: string }).claimUrl).hash.slice(1)).get('token')
    assert.ok(firstToken)

    const resend = await app.request('http://localhost/identity-claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'First Person', handle: 'shared-name', email: 'first@example.com' }),
    })
    assert.equal(resend.status, 202)
    const token = new URLSearchParams(new URL(((await resend.json()) as { claimUrl: string }).claimUrl).hash.slice(1)).get('token')
    assert.ok(token)

    const replaced = await app.request('http://localhost/identity-claims/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: firstToken }),
    })
    assert.equal(replaced.status, 404)

    const conflict = await app.request('http://localhost/identity-claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Second Person', handle: 'shared-name', email: 'second@example.com' }),
    })
    assert.equal(conflict.status, 409)

    const invalid = await app.request('http://localhost/identity-claims/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, publicKey: 'not-a-key' }),
    })
    assert.equal(invalid.status, 400)

    const valid = await app.request('http://localhost/identity-claims/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, publicKey: publicKeyBase64() }),
    })
    assert.equal(valid.status, 201)
  } finally {
    db.close()
    restore()
  }
})
