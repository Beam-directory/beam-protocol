import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminSession } from './admin-auth.js'
import {
  assignDirectoryRole,
  createDatabase,
  createWorkspaceMemberInvitation,
  listAuditLog,
} from './db.js'
import { getLocalDirectoryUrl } from './federation.js'
import { createApp } from './server.js'

type PlatformRole = 'admin' | 'operator' | 'viewer'

function platformHeaders(
  db: ReturnType<typeof createDatabase>,
  email: string,
  role: PlatformRole = 'viewer',
): Record<string, string> {
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
  assignDirectoryRole(db, { userId: email, role, directoryUrl: getLocalDirectoryUrl() })
  const { token } = createAdminSession(db, { email, role })
  return { Authorization: `Bearer ${token}` }
}

async function createWorkspace(
  app: ReturnType<typeof createApp>,
  db: ReturnType<typeof createDatabase>,
  slug: string,
  owner: string,
) {
  const response = await app.request(new Request('http://localhost/admin/workspaces', {
    method: 'POST',
    headers: { ...platformHeaders(db, owner), 'content-type': 'application/json' },
    body: JSON.stringify({ slug, name: `${slug} workspace` }),
  }))
  assert.equal(response.status, 201)
}

test('workspace invitation creates a one-time email-bound workspace session without platform access', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    await createWorkspace(app, db, 'invite-alpha', 'owner@example.com')
    await createWorkspace(app, db, 'invite-beta', 'beta-owner@example.com')
    const ownerHeaders = platformHeaders(db, 'owner@example.com')

    const createResponse = await app.request(new Request('http://localhost/admin/workspaces/invite-alpha/invitations', {
      method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'New.Member@Example.com', role: 'operator', expiresInHours: 72 }),
    }))
    assert.equal(createResponse.status, 201)
    assert.equal(createResponse.headers.get('cache-control'), 'no-store')
    const created = await createResponse.json() as {
      invitation: { id: string; email: string; role: string; status: string }
      url: string
    }
    assert.equal(created.invitation.email, 'new.member@example.com')
    assert.equal(created.invitation.role, 'operator')
    assert.equal(created.invitation.status, 'pending')
    assert.equal('tokenHash' in created.invitation, false)
    const token = new URL(created.url).searchParams.get('token') ?? ''
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)

    const stored = db.prepare(`
      SELECT token_hash
      FROM workspace_member_invitations
      WHERE id = ?
    `).get(created.invitation.id) as { token_hash: string }
    assert.notEqual(stored.token_hash, token)
    assert.equal(stored.token_hash.length, 64)

    const previewResponse = await app.request(`http://localhost/admin/workspaces/invitations/${token}`)
    assert.equal(previewResponse.status, 200)
    const preview = await previewResponse.json() as {
      invitation: { workspace: { slug: string }; emailMasked: string; role: string }
    }
    assert.equal(preview.invitation.workspace.slug, 'invite-alpha')
    assert.equal(preview.invitation.emailMasked.includes('new.member'), false)
    assert.equal(preview.invitation.role, 'operator')

    const returnTo = `/workspace-invite?token=${token}`
    const challengeResponse = await app.request(new Request('http://localhost/admin/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new.member@example.com', returnTo }),
    }))
    assert.equal(challengeResponse.status, 200)
    const challenge = await challengeResponse.json() as { token: string; scope: string }
    assert.equal(challenge.scope, 'workspace')

    const verifyResponse = await app.request(new Request('http://localhost/admin/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: challenge.token }),
    }))
    assert.equal(verifyResponse.status, 200)
    const verified = await verifyResponse.json() as { token: string; scope: string; returnTo: string }
    assert.equal(verified.scope, 'workspace')
    assert.equal(verified.returnTo, returnTo)
    const inviteeHeaders = { Authorization: `Bearer ${verified.token}` }

    const globalRolesResponse = await app.request(new Request('http://localhost/admin/roles', { headers: inviteeHeaders }))
    assert.equal(globalRolesResponse.status, 403)
    assert.equal((await globalRolesResponse.json() as { errorCode: string }).errorCode, 'PLATFORM_ROLE_REQUIRED')

    const beforeAccept = await app.request(new Request('http://localhost/admin/workspaces', { headers: inviteeHeaders }))
    assert.equal(beforeAccept.status, 200)
    assert.equal((await beforeAccept.json() as { total: number }).total, 0)

    const acceptResponse = await app.request(new Request(`http://localhost/admin/workspaces/invitations/${token}/accept`, {
      method: 'POST',
      headers: inviteeHeaders,
    }))
    assert.equal(acceptResponse.status, 200)
    const accepted = await acceptResponse.json() as { workspace: { slug: string }; member: { role: string } }
    assert.equal(accepted.workspace.slug, 'invite-alpha')
    assert.equal(accepted.member.role, 'operator')

    const afterAccept = await app.request(new Request('http://localhost/admin/workspaces', { headers: inviteeHeaders }))
    assert.equal(afterAccept.status, 200)
    const afterAcceptBody = await afterAccept.json() as { total: number; workspaces: Array<{ slug: string }> }
    assert.equal(afterAcceptBody.total, 1)
    assert.deepEqual(afterAcceptBody.workspaces.map((workspace) => workspace.slug), ['invite-alpha'])

    const policyResponse = await app.request(new Request('http://localhost/admin/workspaces/invite-alpha/policy', { headers: inviteeHeaders }))
    assert.equal(policyResponse.status, 200)
    const crossTenantResponse = await app.request(new Request('http://localhost/admin/workspaces/invite-beta', { headers: inviteeHeaders }))
    assert.equal(crossTenantResponse.status, 404)

    const replayResponse = await app.request(new Request(`http://localhost/admin/workspaces/invitations/${token}/accept`, {
      method: 'POST',
      headers: inviteeHeaders,
    }))
    assert.equal(replayResponse.status, 404)
    assert.equal((await replayResponse.json() as { errorCode: string }).errorCode, 'WORKSPACE_INVITATION_NOT_PENDING')

    const actions = new Set(listAuditLog(db, { limit: 50 }).map((entry) => entry.action))
    assert.equal(actions.has('admin.workspace_invitation.created'), true)
    assert.equal(actions.has('admin.workspace_invitation.accepted'), true)
  } finally {
    db.close()
  }
})

test('workspace invitations reject wrong identities, revoked tokens, expired tokens, and non-owners', async () => {
  const db = createDatabase(':memory:')
  try {
    const app = createApp(db)
    await createWorkspace(app, db, 'invite-guards', 'owner@example.com')
    const ownerHeaders = platformHeaders(db, 'owner@example.com')

    const addOperator = await app.request(new Request('http://localhost/admin/workspaces/invite-guards/members', {
      method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'operator@example.com', role: 'operator' }),
    }))
    assert.equal(addOperator.status, 201)

    const operatorCreate = await app.request(new Request('http://localhost/admin/workspaces/invite-guards/invitations', {
      method: 'POST',
      headers: { ...platformHeaders(db, 'operator@example.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'blocked@example.com', role: 'viewer' }),
    }))
    assert.equal(operatorCreate.status, 403)

    const createResponse = await app.request(new Request('http://localhost/admin/workspaces/invite-guards/invitations', {
      method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com', role: 'viewer' }),
    }))
    const created = await createResponse.json() as { invitation: { id: string }; url: string }
    const token = new URL(created.url).searchParams.get('token') ?? ''

    const wrongIdentityResponse = await app.request(new Request(`http://localhost/admin/workspaces/invitations/${token}/accept`, {
      method: 'POST',
      headers: platformHeaders(db, 'wrong@example.com'),
    }))
    assert.equal(wrongIdentityResponse.status, 403)
    assert.equal((await wrongIdentityResponse.json() as { errorCode: string }).errorCode, 'WORKSPACE_INVITATION_EMAIL_MISMATCH')

    const revokeResponse = await app.request(new Request(`http://localhost/admin/workspaces/invite-guards/invitations/${created.invitation.id}`, {
      method: 'DELETE',
      headers: ownerHeaders,
    }))
    assert.equal(revokeResponse.status, 200)
    const revokedPreview = await app.request(`http://localhost/admin/workspaces/invitations/${token}`)
    assert.equal(revokedPreview.status, 404)

    const workspace = db.prepare('SELECT id FROM workspaces WHERE slug = ?').get('invite-guards') as { id: number }
    const expiredToken = 'e'.repeat(43)
    createWorkspaceMemberInvitation(db, {
      id: 'expired-invitation',
      workspaceId: workspace.id,
      email: 'expired@example.com',
      role: 'viewer',
      tokenHash: (await import('node:crypto')).createHash('sha256').update(expiredToken).digest('hex'),
      invitedBy: 'owner@example.com',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })

    const expiredPreview = await app.request(`http://localhost/admin/workspaces/invitations/${expiredToken}`)
    assert.equal(expiredPreview.status, 404)
    const expiredLogin = await app.request(new Request('http://localhost/admin/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'expired@example.com' }),
    }))
    assert.equal(expiredLogin.status, 403)
  } finally {
    db.close()
  }
})
