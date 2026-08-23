import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBeamMcpHttpConfig } from './http-config.js'

function baseEnv(): NodeJS.ProcessEnv {
  return {
    BEAM_MCP_PUBLIC_URL: 'https://mcp.example.com/mcp',
    BEAM_MCP_OAUTH_ISSUER: 'https://identity.example.com',
    BEAM_MCP_OAUTH_METADATA_URL: 'https://identity.example.com/.well-known/oauth-authorization-server',
    BEAM_MCP_OAUTH_INTROSPECTION_URL: 'https://identity.example.com/oauth/introspect',
    BEAM_MCP_OAUTH_CLIENT_ID: 'beam-mcp',
    BEAM_MCP_OAUTH_CLIENT_SECRET: 'secret-from-vault',
  }
}

test('loads a fail-closed HTTPS remote MCP configuration', () => {
  const config = loadBeamMcpHttpConfig(baseEnv())
  assert.equal(config.publicUrl.href, 'https://mcp.example.com/mcp')
  assert.deepEqual(config.allowedHostnames, ['mcp.example.com'])
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 3333)
  assert.equal(config.enableSend, false)
})

test('loads the OAuth introspection secret from a mounted file', () => {
  const env = baseEnv()
  const directory = mkdtempSync(join(tmpdir(), 'beam-mcp-oauth-'))
  const file = join(directory, 'oauth-client-secret')
  try {
    writeFileSync(file, 'mounted-oauth-secret\n', { encoding: 'utf8', mode: 0o600 })
    delete env['BEAM_MCP_OAUTH_CLIENT_SECRET']
    env['BEAM_MCP_OAUTH_CLIENT_SECRET_FILE'] = file
    assert.equal(loadBeamMcpHttpConfig(env).oauth.clientSecret, 'mounted-oauth-secret')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('remote send capability requires an explicit valid boolean flag', () => {
  const enabled = baseEnv()
  enabled['BEAM_MCP_ENABLE_SEND'] = 'true'
  assert.equal(loadBeamMcpHttpConfig(enabled).enableSend, true)

  const typo = baseEnv()
  typo['BEAM_MCP_ENABLE_SEND'] = 'yes'
  assert.throws(() => loadBeamMcpHttpConfig(typo), /must be true or false/)
})

test('rejects insecure public and OAuth endpoints by default', () => {
  const env = baseEnv()
  env['BEAM_MCP_PUBLIC_URL'] = 'http://mcp.example.com/mcp'
  assert.throws(() => loadBeamMcpHttpConfig(env), /must use HTTPS/)
})

test('allows explicit loopback HTTP for local integration tests only', () => {
  const env: NodeJS.ProcessEnv = {
    BEAM_MCP_PUBLIC_URL: 'http://127.0.0.1:3333/mcp',
    BEAM_MCP_OAUTH_ISSUER: 'http://127.0.0.1:4444',
    BEAM_MCP_OAUTH_METADATA_URL: 'http://127.0.0.1:4444/.well-known/oauth-authorization-server',
    BEAM_MCP_OAUTH_INTROSPECTION_URL: 'http://127.0.0.1:4444/introspect',
    BEAM_MCP_OAUTH_CLIENT_ID: 'beam-mcp',
    BEAM_MCP_OAUTH_CLIENT_SECRET: 'local-secret',
    BEAM_MCP_DANGEROUSLY_ALLOW_INSECURE_OAUTH: 'true',
  }
  const config = loadBeamMcpHttpConfig(env)
  assert.equal(config.publicUrl.protocol, 'http:')
})
