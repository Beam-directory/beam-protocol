import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminSession } from './admin-auth.js'
import { createApp } from './server.js'
import { assignDirectoryRole, createDatabase, listAuditLog } from './db.js'
import { getLocalDirectoryUrl } from './federation.js'

function createRoleHeaders(
  db: ReturnType<typeof createDatabase>,
  email: string,
  role: 'admin' | 'operator' | 'viewer',
) {
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
  assignDirectoryRole(db, {
    userId: email,
    role,
    directoryUrl: getLocalDirectoryUrl(),
  })
  const session = createAdminSession(db, { email, role })
  return {
    Authorization: `Bearer ${session.token}`,
  }
}

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

test('directory role listing is viewer-readable while assignment and revoke stay admin-only', async () => {
  const db = createDatabase(':memory:')

  try {
    process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
    assignDirectoryRole(db, {
      userId: 'admin@example.com',
      role: 'admin',
      directoryUrl: getLocalDirectoryUrl(),
    })
    assignDirectoryRole(db, {
      userId: 'operator@example.com',
      role: 'operator',
      directoryUrl: getLocalDirectoryUrl(),
    })
    assignDirectoryRole(db, {
      userId: 'viewer@example.com',
      role: 'viewer',
      directoryUrl: getLocalDirectoryUrl(),
    })

    const app = createApp(db)

    const viewerListResponse = await app.request(new Request('http://localhost/admin/roles', {
      headers: createRoleHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(viewerListResponse.status, 200)
    const viewerListBody = await viewerListResponse.json() as {
      roles: Array<{ email: string; role: string }>
      total: number
    }
    assert.equal(viewerListBody.total, 3)
    assert.ok(viewerListBody.roles.some((entry) => entry.email === 'admin@example.com' && entry.role === 'admin'))
    assert.ok(viewerListBody.roles.some((entry) => entry.email === 'operator@example.com' && entry.role === 'operator'))
    assert.ok(viewerListBody.roles.some((entry) => entry.email === 'viewer@example.com' && entry.role === 'viewer'))

    const operatorCreateResponse = await app.request(new Request('http://localhost/admin/roles', {
      method: 'POST',
      headers: {
        ...createRoleHeaders(db, 'operator@example.com', 'operator'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'new-operator@example.com', role: 'operator' }),
    }))
    assert.equal(operatorCreateResponse.status, 403)

    const adminCreateResponse = await app.request(new Request('http://localhost/admin/roles', {
      method: 'POST',
      headers: {
        ...createRoleHeaders(db, 'admin@example.com', 'admin'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'new-operator@example.com', role: 'operator' }),
    }))
    assert.equal(adminCreateResponse.status, 201)
    const adminCreateBody = await adminCreateResponse.json() as { email: string; role: string }
    assert.equal(adminCreateBody.email, 'new-operator@example.com')
    assert.equal(adminCreateBody.role, 'operator')

    const operatorDeleteResponse = await app.request(new Request('http://localhost/admin/roles/new-operator%40example.com', {
      method: 'DELETE',
      headers: createRoleHeaders(db, 'operator@example.com', 'operator'),
    }))
    assert.equal(operatorDeleteResponse.status, 403)

    const adminDeleteResponse = await app.request(new Request('http://localhost/admin/roles/new-operator%40example.com', {
      method: 'DELETE',
      headers: createRoleHeaders(db, 'admin@example.com', 'admin'),
    }))
    assert.equal(adminDeleteResponse.status, 204)

    const afterDeleteResponse = await app.request(new Request('http://localhost/admin/roles', {
      headers: createRoleHeaders(db, 'viewer@example.com', 'viewer'),
    }))
    assert.equal(afterDeleteResponse.status, 200)
    const afterDeleteBody = await afterDeleteResponse.json() as {
      roles: Array<{ email: string; role: string }>
    }
    assert.ok(!afterDeleteBody.roles.some((entry) => entry.email === 'new-operator@example.com'))
  } finally {
    db.close()
  }
})
