import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createAdminSession } from './admin-auth.js'
import { createApp } from './server.js'
import {
  assignDirectoryRole,
  createDatabase,
  finalizeIntentLog,
  logIntentStart,
  registerAgent,
  setIntentLifecycleStatus,
} from './db.js'
import { getLocalDirectoryUrl } from './federation.js'

type Role = 'admin' | 'operator' | 'viewer'

function createRoleHeaders(
  db: ReturnType<typeof createDatabase>,
  email: string,
  role: Role,
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

async function assertAuthError(response: Response, status: 401 | 403, errorCode: 'UNAUTHORIZED' | 'FORBIDDEN') {
  assert.equal(response.status, status)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/u)
  const payload = await response.json() as { error?: string; errorCode?: string }
  assert.equal(payload.errorCode, errorCode)
  assert.equal(typeof payload.error, 'string')
}

test('ACL HTTP administration requires admin while viewers may list entries', async () => {
  const db = createDatabase(':memory:')

  try {
    const app = createApp(db)
    const viewerHeaders = createRoleHeaders(db, 'viewer@example.com', 'viewer')
    const operatorHeaders = createRoleHeaders(db, 'operator@example.com', 'operator')
    const adminHeaders = createRoleHeaders(db, 'admin@example.com', 'admin')
    const aclInput = {
      targetBeamId: 'receiver@example.beam.directory',
      intentType: 'conversation.message',
      allowedFrom: 'sender@example.beam.directory',
    }
    const { publicKey } = generateKeyPairSync('ed25519')
    registerAgent(db, {
      beamId: aclInput.targetBeamId,
      displayName: 'Receiver',
      capabilities: [aclInput.intentType],
      publicKey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
      org: 'example',
    })

    await assertAuthError(await app.request(new Request('http://localhost/acl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(aclInput),
    })), 401, 'UNAUTHORIZED')

    for (const headers of [viewerHeaders, operatorHeaders]) {
      await assertAuthError(await app.request(new Request('http://localhost/acl', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify(aclInput),
      })), 403, 'FORBIDDEN')
    }

    const createResponse = await app.request(new Request('http://localhost/acl', {
      method: 'POST',
      headers: {
        ...adminHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify(aclInput),
    }))
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json() as { id: number }
    assert.ok(created.id > 0)

    await assertAuthError(await app.request(new Request(
      `http://localhost/acl/${encodeURIComponent(aclInput.targetBeamId)}`,
    )), 401, 'UNAUTHORIZED')

    const listResponse = await app.request(new Request(
      `http://localhost/acl/${encodeURIComponent(aclInput.targetBeamId)}`,
      { headers: viewerHeaders },
    ))
    assert.equal(listResponse.status, 200)
    assert.equal(listResponse.headers.get('cache-control'), 'no-store')
    const listed = await listResponse.json() as {
      acl: Array<{ id: number; intent_type: string; allowed_from: string }>
      total: number
    }
    assert.equal(listed.total, 1)
    assert.equal(listed.acl[0]?.id, created.id)
    assert.equal(listed.acl[0]?.intent_type, aclInput.intentType)
    assert.equal(listed.acl[0]?.allowed_from, aclInput.allowedFrom)

    for (const headers of [viewerHeaders, operatorHeaders]) {
      await assertAuthError(await app.request(new Request(`http://localhost/acl/${created.id}`, {
        method: 'DELETE',
        headers,
      })), 403, 'FORBIDDEN')
    }

    const deleteResponse = await app.request(new Request(`http://localhost/acl/${created.id}`, {
      method: 'DELETE',
      headers: adminHeaders,
    }))
    assert.equal(deleteResponse.status, 200)
    assert.deepEqual(await deleteResponse.json(), { ok: true, id: created.id })
  } finally {
    db.close()
  }
})

test('recent collaboration intents require at least a viewer session', async () => {
  const db = createDatabase(':memory:')

  try {
    const app = createApp(db)
    const viewerHeaders = createRoleHeaders(db, 'viewer@example.com', 'viewer')
    const frame = {
      v: '1' as const,
      from: 'sender@example.beam.directory',
      to: 'receiver@example.beam.directory',
      intent: 'conversation.message',
      payload: { message: 'sensitive collaboration metadata' },
      nonce: 'private-intent-nonce',
      timestamp: new Date().toISOString(),
      signature: 'test-signature',
    }
    logIntentStart(db, frame)
    setIntentLifecycleStatus(db, { nonce: frame.nonce, status: 'validated' })
    setIntentLifecycleStatus(db, { nonce: frame.nonce, status: 'dispatched' })
    setIntentLifecycleStatus(db, { nonce: frame.nonce, status: 'delivered' })
    finalizeIntentLog(db, {
      nonce: frame.nonce,
      fromBeamId: frame.from,
      toBeamId: frame.to,
      status: 'acked',
      latencyMs: 12,
    })

    await assertAuthError(
      await app.request(new Request('http://localhost/intents/recent?limit=5')),
      401,
      'UNAUTHORIZED',
    )

    await assertAuthError(await app.request(new Request('http://localhost/intents/recent?limit=5', {
      headers: { Authorization: 'Bearer invalid-session' },
    })), 401, 'UNAUTHORIZED')

    const response = await app.request(new Request('http://localhost/intents/recent?limit=5', {
      headers: viewerHeaders,
    }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json() as {
      intents: Array<{ nonce: string; from: string; to: string; status: string }>
      total: number
    }
    assert.equal(body.total, 1)
    assert.equal(body.intents[0]?.nonce, frame.nonce)
    assert.equal(body.intents[0]?.from, frame.from)
    assert.equal(body.intents[0]?.to, frame.to)
    assert.equal(body.intents[0]?.status, 'acked')
  } finally {
    db.close()
  }
})
