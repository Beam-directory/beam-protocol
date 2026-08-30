import assert from 'node:assert/strict'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { AgentProfile, AgentRecord, BeamIdString, ResultFrame } from 'beam-protocol-sdk'
import { createBeamMcpHttpHandler, hardenBeamMcpHttpServer, type BeamMcpRemoteAuditRecord } from './http.js'
import type { BeamMcpHttpConfig } from './http-config.js'
import type { BeamNetworkGateway } from './network-client.js'
import { IntrospectionTokenVerifier, loadOAuthAuthorizationServerMetadata } from './oauth.js'
import type { BeamGateway } from './tools.js'

const ownBeamId = 'grok@acme.beam.directory' as BeamIdString
const targetBeamId = 'support@partner.beam.directory' as BeamIdString
const accessToken = 'opaque-test-access-token'
const introspectionClientId = 'beam-mcp-resource-server'
const introspectionClientSecret = 'test-introspection-secret'

async function listen(server: HttpServer): Promise<URL> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return new URL(`http://127.0.0.1:${address.port}`)
}

async function closeServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function json(response: import('node:http').ServerResponse, status: number, value: Record<string, unknown>): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function agent(beamId: BeamIdString): AgentProfile {
  return {
    beamId,
    displayName: beamId.split('@')[0] ?? beamId,
    capabilities: ['conversation.message'],
    publicKey: 'not-returned-public-key',
    org: beamId.split('@')[1]?.split('.')[0] ?? '',
    trustScore: 0.96,
    verified: true,
    verificationTier: 'business',
    verificationStatus: 'verified',
    createdAt: '2026-08-23T00:00:00.000Z',
    lastSeen: '2026-08-23T00:00:00.000Z',
    apiKey: 'not-returned-api-key',
  }
}

function gatewayFixture(): { gateway: BeamGateway; sends: Array<Record<string, unknown>> } {
  const sends: Array<Record<string, unknown>> = []
  const agents = new Map<string, AgentRecord>([
    [ownBeamId, agent(ownBeamId)],
    [targetBeamId, agent(targetBeamId)],
  ])
  return {
    sends,
    gateway: {
      async getStats() {
        return { totalAgents: 2, verifiedAgents: 2, intentsProcessed: 1, version: 'test' }
      },
      async lookup(beamId) {
        return agents.get(beamId) ?? null
      },
      async send(to, intent, payload, timeoutMs) {
        sends.push({ to, intent, payload, timeoutMs })
        return {
          v: '1',
          success: true,
          payload: { accepted: true },
          nonce: 'remote-e2e-result-nonce',
          timestamp: '2026-08-23T00:00:01.000Z',
          signature: 'remote-e2e-signed-result',
        } satisfies ResultFrame
      },
    },
  }
}

function networkGatewayFixture(): { gateway: BeamNetworkGateway; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    gateway: {
      async identity() { return { identity: { beamId: ownBeamId }, counts: { contacts: 1, inbound: 0, outbound: 0 } } },
      async discover(query) { return { results: [], query } },
      async connections(statuses) { return { connections: [], statuses: statuses ?? [] } },
      async conversations() { return { conversations: [] } },
      async messages(conversationId, limit, before) { return { messages: [], conversationId, limit, before: before ?? null } },
      async requestConnection(recipientBeamId, message) {
        calls.push({ tool: 'requestConnection', recipientBeamId, message })
        return { connection: { recipientBeamId, status: 'pending' } }
      },
      async respondConnection(connectionId, decision) {
        calls.push({ tool: 'respondConnection', connectionId, decision })
        return { connection: { connectionId, status: decision } }
      },
      async openDirect(counterpartBeamId) {
        calls.push({ tool: 'openDirect', counterpartBeamId })
        return { conversation: { conversationId: 'conversation-123', counterpartBeamId } }
      },
      async createGroup(title, memberBeamIds) {
        calls.push({ tool: 'createGroup', title, memberBeamIds })
        return { conversation: { conversationId: 'group-123', title } }
      },
      async sendMessage(conversationId, body) {
        calls.push({ tool: 'sendMessage', conversationId, body })
        return { message: { messageId: 'message-123', conversationId } }
      },
    },
  }
}

async function startAuthorizationServer(input: {
  scopes: string[]
  getResource: () => string
}): Promise<{ issuer: URL; metadataUrl: URL; introspectionUrl: URL; introspections: string[]; close: () => Promise<void> }> {
  let issuer = new URL('http://127.0.0.1')
  const introspections: string[] = []
  const expectedAuthorization = `Basic ${Buffer.from(`${encodeURIComponent(introspectionClientId)}:${encodeURIComponent(introspectionClientSecret)}`).toString('base64')}`
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', issuer)
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      json(response, 200, {
        issuer: issuer.href.replace(/\/$/, ''),
        authorization_endpoint: new URL('/authorize', issuer).href,
        token_endpoint: new URL('/token', issuer).href,
        introspection_endpoint: new URL('/introspect', issuer).href,
        registration_endpoint: new URL('/register', issuer).href,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/introspect') {
      if (request.headers.authorization !== expectedAuthorization) {
        json(response, 401, { error: 'invalid_client' })
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const token = params.get('token') ?? ''
      introspections.push(token)
      json(response, 200, {
        active: token === accessToken,
        client_id: 'grok-remote-client',
        sub: 'person-123',
        tenant: 'acme',
        scope: input.scopes.join(' '),
        aud: input.getResource(),
        exp: Math.floor(Date.now() / 1_000) + 300,
      })
      return
    }
    json(response, 404, { error: 'not_found' })
  })
  issuer = await listen(server)
  return {
    issuer,
    metadataUrl: new URL('/.well-known/oauth-authorization-server', issuer),
    introspectionUrl: new URL('/introspect', issuer),
    introspections,
    close: () => closeServer(server),
  }
}

async function startRemoteMcp(input: { enableNetwork?: boolean; enableSend: boolean; scopes: string[] }) {
  let publicUrl = ''
  const authorizationServer = await startAuthorizationServer({
    scopes: input.scopes,
    getResource: () => publicUrl,
  })
  const metadata = await loadOAuthAuthorizationServerMetadata({
    issuer: authorizationServer.issuer,
    metadataUrl: authorizationServer.metadataUrl,
    introspectionUrl: authorizationServer.introspectionUrl,
  })
  const { gateway, sends } = gatewayFixture()
  const network = networkGatewayFixture()
  const audits: BeamMcpRemoteAuditRecord[] = []
  let nodeHandler: ReturnType<typeof toNodeHandler> | undefined
  const server = createServer((request, response) => {
    if (!nodeHandler) {
      response.writeHead(503).end()
      return
    }
    void nodeHandler(request, response)
  })
  hardenBeamMcpHttpServer(server)
  const baseUrl = await listen(server)
  const mcpUrl = new URL('/mcp', baseUrl)
  publicUrl = mcpUrl.href
  const config: BeamMcpHttpConfig = {
    host: '127.0.0.1',
    port: Number.parseInt(mcpUrl.port, 10),
    publicUrl: mcpUrl,
    allowedHostnames: ['127.0.0.1'],
    allowedOriginHostnames: ['127.0.0.1'],
    enableNetwork: input.enableNetwork ?? true,
    enableSend: input.enableSend,
    oauth: {
      issuer: authorizationServer.issuer,
      metadataUrl: authorizationServer.metadataUrl,
      introspectionUrl: authorizationServer.introspectionUrl,
      clientId: introspectionClientId,
      clientSecret: introspectionClientSecret,
    },
  }
  const handler = createBeamMcpHttpHandler({
    config,
    oauthMetadata: metadata,
    verifier: new IntrospectionTokenVerifier({
      introspectionUrl: authorizationServer.introspectionUrl,
      clientId: introspectionClientId,
      clientSecret: introspectionClientSecret,
      resource: mcpUrl,
    }),
    gateway,
    networkGateway: network.gateway,
    ownBeamId,
    allowedIntents: new Set(['conversation.message']),
    requireVerifiedTarget: true,
    minimumVerificationTier: 'verified',
    minimumTrustScore: 0.5,
    auditSink: (record) => audits.push(record),
  })
  nodeHandler = toNodeHandler(handler)

  return {
    mcpUrl,
    sends,
    networkCalls: network.calls,
    audits,
    introspections: authorizationServer.introspections,
    close: async () => {
      await handler.close()
      await closeServer(server)
      await authorizationServer.close()
    },
  }
}

async function connectClient(url: URL): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: { token: async () => accessToken },
  })
  const client = new Client({ name: 'beam-remote-e2e', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

test('official MCP client proves a read-only OAuth-protected remote connector over HTTP', async () => {
  const remote = await startRemoteMcp({ enableSend: false, scopes: ['beam:read'] })
  let connected: Awaited<ReturnType<typeof connectClient>> | undefined
  try {
    connected = await connectClient(remote.mcpUrl)
    const tools = await connected.client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'beam_network_connections',
      'beam_network_conversations',
      'beam_network_discover',
      'beam_network_identity',
      'beam_network_messages',
      'beam_prepare_handoff',
      'beam_status',
    ])
    const identity = await connected.client.callTool({ name: 'beam_network_identity', arguments: {} })
    assert.equal((identity.structuredContent as Record<string, unknown>)['identity'] !== undefined, true)
    const result = await connected.client.callTool({ name: 'beam_status', arguments: { target: targetBeamId } })
    assert.equal(result.isError, undefined)
    const structured = result.structuredContent as Record<string, unknown>
    assert.equal(structured['connectedAs'], ownBeamId)
    assert.equal((structured['connector'] as Record<string, unknown>)['networkRead'], true)
    assert.equal((structured['connector'] as Record<string, unknown>)['networkWrite'], false)
    const target = structured['target'] as Record<string, unknown>
    assert.equal((target['assurance'] as Record<string, unknown>)['tier'], 'business')
    assert.ok(remote.introspections.length >= 2)
    assert.ok(remote.introspections.every((token) => token === accessToken))
    assert.ok(remote.audits.some((record) => record.tool === 'beam_status' && record.outcome === 'success'))
  } finally {
    if (connected) {
      await connected.transport.terminateSession().catch(() => undefined)
      await connected.client.close()
    }
    await remote.close()
  }
})

test('official MCP client preserves send scope, confirmation, signed result, and content-free audit', async () => {
  const remote = await startRemoteMcp({ enableSend: true, scopes: ['beam:read', 'beam:send'] })
  let connected: Awaited<ReturnType<typeof connectClient>> | undefined
  const message = 'Sensitive customer handoff that must never enter the OAuth audit'
  try {
    connected = await connectClient(remote.mcpUrl)
    const tools = await connected.client.listTools()
    assert.ok(tools.tools.some((tool) => tool.name === 'beam_send'))

    const preview = await connected.client.callTool({
      name: 'beam_prepare_handoff',
      arguments: { to: targetBeamId, message, context: { ticket: 'SUP-42' } },
    })
    assert.equal(preview.isError, undefined)
    assert.equal(JSON.stringify(preview).includes(message), false)

    const blocked = await connected.client.callTool({
      name: 'beam_send',
      arguments: { to: targetBeamId, message, confirmed: false },
    })
    assert.equal(blocked.isError, true)
    assert.equal(remote.sends.length, 0)

    const delivered = await connected.client.callTool({
      name: 'beam_send',
      arguments: { to: targetBeamId, message, confirmed: true },
    })
    assert.equal(delivered.isError, undefined)
    assert.equal(remote.sends.length, 1)
    const structured = delivered.structuredContent as Record<string, unknown>
    assert.equal((structured['result'] as Record<string, unknown>)['signed'], true)

    const networkBlocked = await connected.client.callTool({
      name: 'beam_network_send_message',
      arguments: { conversationId: 'conversation-123', body: message, confirmed: false },
    })
    assert.equal(networkBlocked.isError, true)
    assert.equal(remote.networkCalls.length, 0)

    const networkDelivered = await connected.client.callTool({
      name: 'beam_network_send_message',
      arguments: { conversationId: 'conversation-123', body: message, confirmed: true },
    })
    assert.equal(networkDelivered.isError, undefined)
    assert.equal(remote.networkCalls.length, 1)

    const auditJson = JSON.stringify(remote.audits)
    assert.equal(auditJson.includes(message), false)
    assert.equal(auditJson.includes(accessToken), false)
    assert.equal(auditJson.includes('test-introspection-secret'), false)
    assert.ok(remote.audits.some((record) => record.tool === 'beam_send' && record.outcome === 'rejected'))
    assert.ok(remote.audits.some((record) => record.tool === 'beam_send' && record.outcome === 'success'))
    assert.ok(remote.audits.some((record) => record.tool === 'beam_network_send_message' && record.outcome === 'rejected'))
    assert.ok(remote.audits.some((record) => record.tool === 'beam_network_send_message' && record.outcome === 'success'))
    assert.ok(remote.audits.every((record) => record.principal.clientId === 'grok-remote-client'))
  } finally {
    if (connected) {
      await connected.transport.terminateSession().catch(() => undefined)
      await connected.client.close()
    }
    await remote.close()
  }
})
