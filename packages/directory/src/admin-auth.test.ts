import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './server.js'
import { assignDirectoryRole, createDatabase, listAuditLog } from './db.js'
import { getLocalDirectoryUrl } from './federation.js'

test('admin auth issues sessions, supports session introspection, and audits login/logout', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    assignDirectoryRole(db, {
      userId: 'ops@example.com',
      role: 'admin',
      directoryUrl: getLocalDirectoryUrl(),
    })

    const app = createApp(db)
    const challengeResponse = await app.request(new Request('http://localhost/admin/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ops@example.com' }),
    }))

    assert.equal(challengeResponse.status, 200)
    const challenge = await challengeResponse.json() as { token?: string; url?: string; dev: boolean }
    assert.equal(challenge.dev, true)
    assert.ok(challenge.token)
    assert.ok(challenge.url?.includes('/auth/callback?token='))

    const verifyResponse = await app.request(new Request('http://localhost/admin/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: challenge.token }),
    }))

    assert.equal(verifyResponse.status, 200)
    assert.ok((verifyResponse.headers.get('set-cookie') ?? '').includes('beam_admin_session='))

    const verified = await verifyResponse.json() as { token: string; email: string; role: string }
    assert.equal(verified.email, 'ops@example.com')
    assert.equal(verified.role, 'admin')

    const sessionResponse = await app.request(new Request('http://localhost/admin/auth/session', {
      headers: { Authorization: `Bearer ${verified.token}` },
    }))
    assert.equal(sessionResponse.status, 200)
    const session = await sessionResponse.json() as { email: string; role: string }
    assert.equal(session.email, 'ops@example.com')
    assert.equal(session.role, 'admin')

    const logoutResponse = await app.request(new Request('http://localhost/admin/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${verified.token}` },
    }))
    assert.equal(logoutResponse.status, 200)

    const afterLogoutResponse = await app.request(new Request('http://localhost/admin/auth/session', {
      headers: { Authorization: `Bearer ${verified.token}` },
    }))
    assert.equal(afterLogoutResponse.status, 401)

    const auditActions = listAuditLog(db, { limit: 10 }).map((entry) => entry.action)
    assert.ok(auditActions.includes('admin.auth.challenge.issued'))
    assert.ok(auditActions.includes('admin.auth.login'))
    assert.ok(auditActions.includes('admin.auth.logout'))
  } finally {
    db.close()
  }
})
