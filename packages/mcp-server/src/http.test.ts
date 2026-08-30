import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AuthInfo, OAuthMetadata, OAuthTokenVerifier } from '@modelcontextprotocol/server'
import type { BeamIdString } from 'beam-protocol-sdk'
import { createBeamMcpHttpHandler, hardenBeamMcpHttpServer } from './http.js'
import type { BeamMcpHttpConfig } from './http-config.js'

const config: BeamMcpHttpConfig = {
  host: '127.0.0.1',
  port: 3333,
  publicUrl: new URL('https://mcp.example.com/mcp'),
  allowedHostnames: ['mcp.example.com'],
  allowedOriginHostnames: ['mcp.example.com'],
  enableNetwork: false,
  enableSend: true,
  oauth: {
    issuer: new URL('https://identity.example.com'),
    metadataUrl: new URL('https://identity.example.com/.well-known/oauth-authorization-server'),
    introspectionUrl: new URL('https://identity.example.com/oauth/introspect'),
    clientId: 'beam-resource-server',
    clientSecret: 'vault-secret',
  },
}

const oauthMetadata: OAuthMetadata = {
  issuer: 'https://identity.example.com',
  authorization_endpoint: 'https://identity.example.com/oauth/authorize',
  token_endpoint: 'https://identity.example.com/oauth/token',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
}

const verifier: OAuthTokenVerifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return {
      token,
      clientId: 'grok-client',
      scopes: ['beam:read'],
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
      resource: new URL('https://mcp.example.com/mcp'),
    }
  },
}

function createHandler(enableSend = true) {
  return createBeamMcpHttpHandler({
    config: { ...config, enableSend },
    oauthMetadata,
    verifier,
    gateway: {
      getStats: async () => ({ totalAgents: 0, verifiedAgents: 0, intentsProcessed: 0, version: 'test' }),
      lookup: async () => null,
      send: async () => { throw new Error('not used') },
    },
    ownBeamId: 'grok@example.beam.directory' as BeamIdString,
    allowedIntents: new Set(['conversation.message']),
    requireVerifiedTarget: true,
    minimumVerificationTier: 'verified',
    minimumTrustScore: 0.5,
  })
}

test('remote MCP serves RFC 9728 discovery and a public minimal health response', async () => {
  const handler = createHandler()
  try {
    const metadataResponse = await handler.fetch(new Request('https://mcp.example.com/.well-known/oauth-protected-resource/mcp', {
      headers: { host: 'mcp.example.com' },
    }))
    assert.equal(metadataResponse.status, 200)
    const metadata = await metadataResponse.json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] }
    assert.equal(metadata.resource, 'https://mcp.example.com/mcp')
    assert.deepEqual(metadata.authorization_servers, ['https://identity.example.com'])
    assert.deepEqual(metadata.scopes_supported, ['beam:read', 'beam:send'])

    const health = await handler.fetch(new Request('https://mcp.example.com/health', {
      headers: { host: 'mcp.example.com' },
    }))
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { status: 'ok', transport: 'streamable-http', oauth: true })
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(health.headers.get('x-frame-options'), 'DENY')
    assert.match(health.headers.get('content-security-policy') ?? '', /default-src 'none'/)
  } finally {
    await handler.close()
  }
})

test('remote MCP challenges unauthenticated requests and rejects untrusted hosts', async () => {
  const handler = createHandler()
  try {
    const unauthorized = await handler.fetch(new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'mcp.example.com' },
      body: '{}',
    }))
    assert.equal(unauthorized.status, 401)
    const challenge = unauthorized.headers.get('www-authenticate') ?? ''
    assert.match(challenge, /resource_metadata=/)
    assert.match(challenge, /scope="beam:read beam:send"/)

    const badHost = await handler.fetch(new Request('https://evil.example/mcp', {
      headers: { host: 'evil.example' },
    }))
    assert.equal(badHost.status, 403)
  } finally {
    await handler.close()
  }
})

test('remote MCP is read-only by policy and caps authenticated request bodies', async () => {
  const handler = createHandler(false)
  try {
    const metadataResponse = await handler.fetch(new Request('https://mcp.example.com/.well-known/oauth-protected-resource/mcp', {
      headers: { host: 'mcp.example.com' },
    }))
    const metadata = await metadataResponse.json() as { scopes_supported: string[] }
    assert.deepEqual(metadata.scopes_supported, ['beam:read'])

    const oversized = await handler.fetch(new Request('https://mcp.example.com/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-read-token',
        'content-type': 'application/json',
        host: 'mcp.example.com',
      },
      body: new Uint8Array(1024 * 1024 + 1),
    }))
    assert.equal(oversized.status, 413)
  } finally {
    await handler.close()
  }
})

test('remote Node listener uses bounded production HTTP defaults', () => {
  const server = createServer()
  hardenBeamMcpHttpServer(server)
  assert.equal(server.requestTimeout, 30_000)
  assert.equal(server.headersTimeout, 15_000)
  assert.equal(server.keepAliveTimeout, 5_000)
  assert.equal(server.maxHeadersCount, 100)
  assert.equal(server.maxRequestsPerSocket, 1_000)
})
