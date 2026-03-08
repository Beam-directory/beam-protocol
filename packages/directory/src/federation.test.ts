import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createApp } from './server.js'
import {
  assignDirectoryRole,
  createDatabase,
  logAuditEvent,
  registerAgent,
  upsertFederatedAgentCache,
} from './db.js'
import { discoverDID, discoverDirectory } from './discovery.js'
import {
  applyTrustAssertion,
  applyTrustDecay,
  calculateTrustDelta,
  getCachedFederatedAgent,
  getEffectiveFederatedTrust,
  getLocalDirectoryUrl,
  registerPeer,
  resolveAgentAcrossFederation,
  syncAgents,
} from './federation.js'
import { relayIntentFromHttp } from './websocket.js'
import type { IntentFrame } from './types.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function withFetchStub<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    return handler(url, init)
  }) as typeof fetch

  globalThis.fetch = stub
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

function signIntentFrame(frame: Omit<IntentFrame, 'signature'>, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): IntentFrame {
  const payload = JSON.stringify({
    type: 'intent',
    from: frame.from,
    to: frame.to,
    intent: frame.intent,
    payload: frame.payload,
    timestamp: frame.timestamp,
    nonce: frame.nonce,
  })

  return {
    ...frame,
    signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
  }
}

test('peer registration and sync cache federated agents', async () => {
  const db = createDatabase(':memory:')

  try {
    registerPeer(db, 'https://peer.example', 'peer-public-key')

    await syncAgents(db, 'https://peer.example', {
      fetchImpl: async () => jsonResponse({
        agents: [
          {
            beam_id: 'remote@peer.beam.directory',
            display_name: 'Remote Agent',
            capabilities: ['lookup'],
            public_key: 'remote-public-key',
            trust_score: 0.8,
            ttl: 120,
          },
        ],
      }),
    })

    const cached = getCachedFederatedAgent(db, 'remote@peer.beam.directory')
    assert.ok(cached)
    assert.equal(cached.directoryUrl, 'https://peer.example')
    assert.equal(cached.agent.public_key, 'remote-public-key')
    assert.equal(getEffectiveFederatedTrust(db, 'remote@peer.beam.directory'), 0.4)
  } finally {
    db.close()
  }
})

test('cross-directory agent resolution falls back to peers', async () => {
  const db = createDatabase(':memory:')

  try {
    registerPeer(db, 'https://peer.example', 'peer-public-key')

    const resolved = await resolveAgentAcrossFederation(db, 'remote@peer.beam.directory', {
      fetchImpl: async () => jsonResponse({
        agent: {
          beam_id: 'remote@peer.beam.directory',
          display_name: 'Remote Agent',
          capabilities: ['lookup'],
          public_key: 'remote-public-key',
          trust_score: 0.75,
          ttl: 300,
        },
      }),
      autoDiscover: false,
    })

    assert.ok(resolved)
    assert.equal(resolved?.scope, 'peer')
    assert.equal(resolved?.directoryUrl, 'https://peer.example')
    assert.equal(resolved?.agent.beam_id, 'remote@peer.beam.directory')
  } finally {
    db.close()
  }
})

test('trust propagation decays over time', () => {
  const db = createDatabase(':memory:')

  try {
    assert.equal(calculateTrustDelta(0.8, 1), 0.4)
    assert.equal(calculateTrustDelta(0.8, 2), 0.2)

    const assertedAt = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
    applyTrustAssertion(db, {
      beamId: 'remote@peer.beam.directory',
      sourceDirectoryUrl: 'https://peer.example',
      originDirectoryUrl: 'https://peer.example',
      assertedTrust: 0.8,
      hopCount: 1,
      assertedAt,
    })

    const decayed = getEffectiveFederatedTrust(db, 'remote@peer.beam.directory')
    assert.ok(decayed < 0.4)
    assert.equal(decayed, applyTrustDecay(0.4, assertedAt))
  } finally {
    db.close()
  }
})

test('dns discovery resolves SRV and DID with cache', async () => {
  const db = createDatabase(':memory:')
  let srvCalls = 0
  let txtCalls = 0

  try {
    const resolver = {
      resolveAny: async () => {
        srvCalls++
        return [{ type: 'SRV', name: 'directory.example', port: 443, priority: 10, weight: 5, ttl: 120 }]
      },
      resolveTxt: async () => {
        txtCalls++
        return [['did:web:example.com']]
      },
    }

    const firstDirectory = await discoverDirectory(db, 'example.com', { resolver })
    const secondDirectory = await discoverDirectory(db, 'example.com', { resolver })
    const did = await discoverDID(db, 'example.com', { resolver })

    assert.equal(firstDirectory?.directoryUrl, 'https://directory.example')
    assert.equal(firstDirectory?.ttl, 120)
    assert.equal(secondDirectory?.source, 'cache')
    assert.equal(did?.did, 'did:web:example.com')
    assert.equal(srvCalls, 1)
    assert.equal(txtCalls, 1)
  } finally {
    db.close()
  }
})

test('federation relay forwards intents with hop counting', async () => {
  const db = createDatabase(':memory:')
  const previousSecret = process.env['BEAM_FEDERATION_SHARED_SECRET']
  const previousDirectoryUrl = process.env['BEAM_DIRECTORY_URL']

  process.env['BEAM_FEDERATION_SHARED_SECRET'] = 'shared-secret'
  process.env['BEAM_DIRECTORY_URL'] = 'https://local.example'

  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    registerAgent(db, {
      beamId: 'sender@local.beam.directory',
      displayName: 'Sender',
      capabilities: ['payments'],
      publicKey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64'),
      org: 'local',
    })

    registerPeer(db, 'https://peer.example', 'peer-public-key')
    upsertFederatedAgentCache(db, {
      beamId: 'remote@peer.beam.directory',
      homeDirectoryUrl: 'https://peer.example',
      document: {
        beam_id: 'remote@peer.beam.directory',
        display_name: 'Remote Agent',
        capabilities: ['payments'],
        public_key: 'remote-public-key',
        trust_score: 0.9,
      },
    })

    const frame = signIntentFrame({
      v: '1',
      from: 'sender@local.beam.directory',
      to: 'remote@peer.beam.directory',
      intent: 'payment.status_check',
      payload: { invoiceId: 'inv-123' },
      nonce: randomUUID(),
      timestamp: new Date().toISOString(),
    }, privateKey)

    await withFetchStub(async (url, init) => {
      assert.equal(url, 'https://peer.example/federation/relay')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('x-beam-source-directory'), 'https://local.example')
      assert.equal(headers.get('x-beam-hop-count'), '1')
      assert.equal(headers.get('x-beam-federation-secret'), 'shared-secret')
      return jsonResponse({
        v: '1',
        success: true,
        nonce: frame.nonce,
        timestamp: new Date().toISOString(),
        latency: 12,
        payload: { ok: true },
      })
    }, async () => {
      const result = await relayIntentFromHttp(db, frame, 5_000)
      assert.equal(result.success, true)
      assert.equal(result.nonce, frame.nonce)
    })
  } finally {
    process.env['BEAM_FEDERATION_SHARED_SECRET'] = previousSecret
    process.env['BEAM_DIRECTORY_URL'] = previousDirectoryUrl
    db.close()
  }
})

test('audit log endpoint is admin-only through RBAC', async () => {
  const db = createDatabase(':memory:')
  const previousAdminKey = process.env['BEAM_ADMIN_KEY']
  const previousDirectoryUrl = process.env['BEAM_DIRECTORY_URL']

  process.env['BEAM_ADMIN_KEY'] = ''
  process.env['BEAM_DIRECTORY_URL'] = 'https://local.example'

  try {
    assignDirectoryRole(db, {
      userId: 'alice',
      role: 'admin',
      directoryUrl: getLocalDirectoryUrl(),
    })
    logAuditEvent(db, {
      action: 'federation.peer.register',
      actor: 'alice',
      target: 'https://peer.example',
      details: { trustLevel: 0.5 },
    })

    const app = createApp(db)
    const response = await app.request(new Request('http://localhost/admin/audit?limit=10', {
      headers: { 'x-directory-user': 'alice' },
    }))

    assert.equal(response.status, 200)
    const payload = await response.json() as { total: number; entries: Array<{ action: string }> }
    assert.equal(payload.total, 1)
    assert.equal(payload.entries[0]?.action, 'federation.peer.register')
  } finally {
    process.env['BEAM_ADMIN_KEY'] = previousAdminKey
    process.env['BEAM_DIRECTORY_URL'] = previousDirectoryUrl
    db.close()
  }
})
