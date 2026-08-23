import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminSession } from './admin-auth.js'
import {
  assignDirectoryRole,
  createDatabase,
  listAuditLog,
} from './db.js'
import { getLocalDirectoryUrl } from './federation.js'
import { createApp } from './server.js'

type GlobalRole = 'admin' | 'operator' | 'viewer'

function createSessionHeaders(
  db: ReturnType<typeof createDatabase>,
  email: string,
  role: GlobalRole = 'viewer',
): Record<string, string> {
  process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-secret'
  assignDirectoryRole(db, {
    userId: email,
    role,
    directoryUrl: getLocalDirectoryUrl(),
  })
  const { token } = createAdminSession(db, { email, role })
  return { Authorization: `Bearer ${token}` }
}

async function createWorkspace(
  app: ReturnType<typeof createApp>,
  db: ReturnType<typeof createDatabase>,
  slug: string,
  ownerEmail: string,
): Promise<void> {
  const response = await app.request(new Request('http://localhost/admin/workspaces', {
    method: 'POST',
    headers: {
      ...createSessionHeaders(db, ownerEmail),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ slug, name: `${slug} workspace` }),
  }))
  assert.equal(response.status, 201)
}

test('workspace creation assigns its human creator as owner and list/detail access is tenant isolated', async () => {
  const db = createDatabase(':memory:')

  try {
    const app = createApp(db)
    await createWorkspace(app, db, 'alpha-tenant', 'alpha@example.com')
    await createWorkspace(app, db, 'beta-tenant', 'beta@example.com')

    const alphaList = await app.request(new Request('http://localhost/admin/workspaces', {
      headers: createSessionHeaders(db, 'alpha@example.com'),
    }))
    assert.equal(alphaList.status, 200)
    const alphaListBody = await alphaList.json() as { total: number; workspaces: Array<{ slug: string }> }
    assert.equal(alphaListBody.total, 1)
    assert.deepEqual(alphaListBody.workspaces.map((workspace) => workspace.slug), ['alpha-tenant'])

    const crossTenantDetail = await app.request(new Request('http://localhost/admin/workspaces/beta-tenant', {
      headers: createSessionHeaders(db, 'alpha@example.com'),
    }))
    assert.equal(crossTenantDetail.status, 404)
    assert.deepEqual(await crossTenantDetail.json(), {
      error: 'Workspace not found',
      errorCode: 'NOT_FOUND',
    })

    const ownerMembers = await app.request(new Request('http://localhost/admin/workspaces/alpha-tenant/members', {
      headers: createSessionHeaders(db, 'alpha@example.com'),
    }))
    assert.equal(ownerMembers.status, 200)
    const ownerMembersBody = await ownerMembers.json() as {
      total: number
      members: Array<{
        principalId: string
        principalType: string
        role: string
        createdAt: string
        updatedAt: string
      }>
    }
    assert.equal(ownerMembersBody.total, 1)
    assert.equal(ownerMembersBody.members[0]?.principalId, 'alpha@example.com')
    assert.equal(ownerMembersBody.members[0]?.principalType, 'human')
    assert.equal(ownerMembersBody.members[0]?.role, 'owner')
    assert.ok(ownerMembersBody.members[0]?.createdAt)
    assert.ok(ownerMembersBody.members[0]?.updatedAt)

    const platformAdminList = await app.request(new Request('http://localhost/admin/workspaces', {
      headers: createSessionHeaders(db, 'platform@example.com', 'admin'),
    }))
    assert.equal(platformAdminList.status, 200)
    const platformAdminListBody = await platformAdminList.json() as { total: number; workspaces: Array<{ slug: string }> }
    assert.equal(platformAdminListBody.total, 2)
    assert.deepEqual(
      new Set(platformAdminListBody.workspaces.map((workspace) => workspace.slug)),
      new Set(['alpha-tenant', 'beta-tenant']),
    )

    const platformAdminDetail = await app.request(new Request('http://localhost/admin/workspaces/beta-tenant', {
      headers: createSessionHeaders(db, 'platform@example.com', 'admin'),
    }))
    assert.equal(platformAdminDetail.status, 200)
  } finally {
    db.close()
  }
})

test('workspace roles gate reads, writes, and owner-only member management', async () => {
  const db = createDatabase(':memory:')

  try {
    const app = createApp(db)
    await createWorkspace(app, db, 'role-gate', 'owner@example.com')
    const ownerHeaders = createSessionHeaders(db, 'owner@example.com')

    const inviteOperator = await app.request(new Request('http://localhost/admin/workspaces/role-gate/members', {
      method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Operator@Example.com', role: 'operator' }),
    }))
    assert.equal(inviteOperator.status, 201)
    const operatorMember = await inviteOperator.json() as {
      member: { id: number; principalId: string; role: string }
      invitation: { mode: string; accepted: boolean }
    }
    assert.equal(operatorMember.member.principalId, 'operator@example.com')
    assert.equal(operatorMember.member.role, 'operator')
    assert.deepEqual(operatorMember.invitation, { mode: 'direct_access_grant', accepted: true })

    const inviteViewer = await app.request(new Request('http://localhost/admin/workspaces/role-gate/members', {
      method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'viewer@example.com', role: 'viewer' }),
    }))
    assert.equal(inviteViewer.status, 201)
    const viewerMember = await inviteViewer.json() as { member: { id: number } }

    const inviteMachineOwner = await app.request(new Request('http://localhost/admin/workspaces/role-gate/members', {
      method: 'POST',
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'ops-bot@beam.directory', principalType: 'agent', role: 'owner' }),
    }))
    assert.equal(inviteMachineOwner.status, 409)
    assert.equal((await inviteMachineOwner.json() as { errorCode: string }).errorCode, 'WORKSPACE_OWNER_REQUIRED')

    const operatorWrite = await app.request(new Request('http://localhost/admin/workspaces/role-gate/policy', {
      method: 'PATCH',
      headers: {
        ...createSessionHeaders(db, 'operator@example.com'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }))
    assert.equal(operatorWrite.status, 200)

    const viewerRead = await app.request(new Request('http://localhost/admin/workspaces/role-gate/policy', {
      headers: createSessionHeaders(db, 'viewer@example.com'),
    }))
    assert.equal(viewerRead.status, 200)

    const viewerWrite = await app.request(new Request('http://localhost/admin/workspaces/role-gate/policy', {
      method: 'PATCH',
      headers: {
        ...createSessionHeaders(db, 'viewer@example.com'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }))
    assert.equal(viewerWrite.status, 403)
    assert.equal((await viewerWrite.json() as { errorCode: string }).errorCode, 'WORKSPACE_ROLE_REQUIRED')

    const operatorMemberList = await app.request(new Request('http://localhost/admin/workspaces/role-gate/members', {
      headers: createSessionHeaders(db, 'operator@example.com'),
    }))
    assert.equal(operatorMemberList.status, 403)

    const removeViewer = await app.request(new Request(`http://localhost/admin/workspaces/role-gate/members/${viewerMember.member.id}`, {
      method: 'DELETE',
      headers: ownerHeaders,
    }))
    assert.equal(removeViewer.status, 200)

    const actions = new Set(listAuditLog(db, { limit: 50 }).map((row) => row.action))
    assert.equal(actions.has('admin.workspace_member.invited'), true)
    assert.equal(actions.has('admin.workspace_member.removed'), true)
    assert.equal(actions.has('admin.workspace_policy.updated'), true)
  } finally {
    db.close()
  }
})

test('workspace member role changes retain at least one owner and are audited', async () => {
  const db = createDatabase(':memory:')

  try {
    const app = createApp(db)
    await createWorkspace(app, db, 'owner-invariant', 'first-owner@example.com')
    const firstOwnerHeaders = createSessionHeaders(db, 'first-owner@example.com')

    const inviteSecondOwner = await app.request(new Request('http://localhost/admin/workspaces/owner-invariant/members', {
      method: 'POST',
      headers: { ...firstOwnerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'second-owner@example.com', role: 'owner' }),
    }))
    assert.equal(inviteSecondOwner.status, 201)
    const secondOwner = await inviteSecondOwner.json() as { member: { id: number } }

    const memberList = await app.request(new Request('http://localhost/admin/workspaces/owner-invariant/members', {
      headers: firstOwnerHeaders,
    }))
    const memberListBody = await memberList.json() as { members: Array<{ id: number; principalId: string }> }
    const firstOwner = memberListBody.members.find((member) => member.principalId === 'first-owner@example.com')
    assert.ok(firstOwner)

    const demoteFirstOwner = await app.request(new Request(`http://localhost/admin/workspaces/owner-invariant/members/${firstOwner.id}`, {
      method: 'PATCH',
      headers: { ...firstOwnerHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    }))
    assert.equal(demoteFirstOwner.status, 200)

    const platformAdminHeaders = createSessionHeaders(db, 'platform@example.com', 'admin')
    const demoteLastOwner = await app.request(new Request(`http://localhost/admin/workspaces/owner-invariant/members/${secondOwner.member.id}`, {
      method: 'PATCH',
      headers: { ...platformAdminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'operator' }),
    }))
    assert.equal(demoteLastOwner.status, 409)
    assert.equal((await demoteLastOwner.json() as { errorCode: string }).errorCode, 'WORKSPACE_OWNER_REQUIRED')

    const deleteLastOwner = await app.request(new Request(`http://localhost/admin/workspaces/owner-invariant/members/${secondOwner.member.id}`, {
      method: 'DELETE',
      headers: platformAdminHeaders,
    }))
    assert.equal(deleteLastOwner.status, 409)
    assert.equal((await deleteLastOwner.json() as { errorCode: string }).errorCode, 'WORKSPACE_OWNER_REQUIRED')

    const formerOwnerMemberList = await app.request(new Request('http://localhost/admin/workspaces/owner-invariant/members', {
      headers: firstOwnerHeaders,
    }))
    assert.equal(formerOwnerMemberList.status, 403)

    const roleUpdates = listAuditLog(db, { action: 'admin.workspace_member.updated' })
    assert.equal(roleUpdates.length, 1)
    const details = JSON.parse(roleUpdates[0]?.details ?? '{}') as { previousRole?: string; memberRole?: string }
    assert.deepEqual(details, {
      workspaceRole: 'owner',
      platformRole: 'viewer',
      previousRole: 'owner',
      memberRole: 'viewer',
    })
  } finally {
    db.close()
  }
})
