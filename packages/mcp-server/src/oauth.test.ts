import test from 'node:test'
import assert from 'node:assert/strict'
import { OAuthError } from '@modelcontextprotocol/server'
import { IntrospectionTokenVerifier, loadOAuthAuthorizationServerMetadata } from './oauth.js'

test('loads authorization-server metadata only with exact issuer and PKCE S256', async () => {
  const metadata = await loadOAuthAuthorizationServerMetadata({
    issuer: new URL('https://identity.example.com'),
    metadataUrl: new URL('https://identity.example.com/.well-known/oauth-authorization-server'),
    introspectionUrl: new URL('https://identity.example.com/oauth/introspect'),
  }, async () => new Response(JSON.stringify({
    issuer: 'https://identity.example.com',
    authorization_endpoint: 'https://identity.example.com/oauth/authorize',
    token_endpoint: 'https://identity.example.com/oauth/token',
    introspection_endpoint: 'https://identity.example.com/oauth/introspect',
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  }), { status: 200 }))
  assert.equal(metadata.issuer, 'https://identity.example.com')
})

test('rejects an introspection endpoint that is not the configured endpoint', async () => {
  await assert.rejects(
    loadOAuthAuthorizationServerMetadata({
      issuer: new URL('https://identity.example.com'),
      metadataUrl: new URL('https://identity.example.com/.well-known/oauth-authorization-server'),
      introspectionUrl: new URL('https://identity.example.com/oauth/introspect'),
    }, async () => new Response(JSON.stringify({
      issuer: 'https://identity.example.com',
      authorization_endpoint: 'https://identity.example.com/oauth/authorize',
      token_endpoint: 'https://identity.example.com/oauth/token',
      introspection_endpoint: 'https://attacker.example/oauth/introspect',
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    }), { status: 200 })),
    /introspection_endpoint does not match/,
  )
})

test('introspection verifier enforces active expiry and exact MCP resource audience', async () => {
  let authorization = ''
  const verifier = new IntrospectionTokenVerifier({
    introspectionUrl: new URL('https://identity.example.com/oauth/introspect'),
    clientId: 'beam-resource-server',
    clientSecret: 'vault-secret',
    resource: new URL('https://mcp.example.com/mcp'),
    fetcher: async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return new Response(JSON.stringify({
        active: true,
        client_id: 'grok-client',
        sub: 'person-123',
        scope: 'beam:read beam:send',
        aud: ['https://mcp.example.com/mcp'],
        exp: Math.floor(Date.now() / 1_000) + 300,
      }), { status: 200 })
    },
  })
  const info = await verifier.verifyAccessToken('opaque-access-token')
  assert.equal(info.clientId, 'grok-client')
  assert.deepEqual(info.scopes, ['beam:read', 'beam:send'])
  assert.equal(info.resource?.href, 'https://mcp.example.com/mcp')
  assert.match(authorization, /^Basic /)
  assert.equal(authorization.includes('vault-secret'), false)
})

test('introspection verifier rejects tokens for another audience', async () => {
  const verifier = new IntrospectionTokenVerifier({
    introspectionUrl: new URL('https://identity.example.com/oauth/introspect'),
    clientId: 'beam-resource-server',
    clientSecret: 'vault-secret',
    resource: new URL('https://mcp.example.com/mcp'),
    fetcher: async () => new Response(JSON.stringify({
      active: true,
      client_id: 'grok-client',
      scope: 'beam:read',
      aud: 'https://other.example.com/mcp',
      exp: Math.floor(Date.now() / 1_000) + 300,
    }), { status: 200 }),
  })
  await assert.rejects(
    verifier.verifyAccessToken('wrong-audience-token'),
    (error: unknown) => OAuthError.isInstance(error) && error.code === 'invalid_token',
  )
})
