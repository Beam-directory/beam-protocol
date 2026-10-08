import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

function readRepoFile(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

function dryRun(scriptName, args) {
  const result = spawnSync(process.execPath, [new URL(scriptName, import.meta.url).pathname, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('hosted MCP pilot keeps the default profile off and isolates send', () => {
  const fly = readRepoFile('../../ops/mcp-pilot/fly/mcp.fly.toml')
  const send = readRepoFile('../../ops/mcp-pilot/fly/mcp.send.fly.toml')
  const tenant = readRepoFile('../../ops/mcp-tenant/compose.yaml')
  const httpServer = readRepoFile('../../packages/mcp-server/src/http.ts')
  const networkClient = readRepoFile('../../packages/mcp-server/src/network-client.ts')

  assert.match(fly, /BEAM_MCP_ENABLE_NETWORK = "false"/)
  assert.match(fly, /BEAM_MCP_ENABLE_SEND = "false"/)
  assert.doesNotMatch(fly, /BEAM_MCP_ENABLE_NETWORK = "true"/)
  assert.doesNotMatch(fly, /BEAM_MCP_ENABLE_SEND = "true"/)
  assert.match(send, /BEAM_MCP_ENABLE_NETWORK = "true"/)
  assert.match(send, /BEAM_MCP_ENABLE_SEND = "true"/)
  assert.match(send, /BEAM_MCP_SEND_LIMIT_PER_HOUR = "30"/)
  assert.match(send, /BEAM_ID = "grok@coppen\.beam\.directory"/)
  assert.match(tenant, /BEAM_MCP_ENABLE_NETWORK: "false"/)
  assert.match(tenant, /BEAM_MCP_ENABLE_SEND: "false"/)
  assert.match(httpServer, /const MAX_MCP_REQUEST_BYTES = 1024 \* 1024/)
  assert.match(httpServer, /const requiredScopes = \['beam:read'\]/)
  assert.match(networkClient, /const MAX_NETWORK_RESPONSE_BYTES = 2 \* 1024 \* 1024/)
})

test('Keycloak pilot helpers keep beam:send optional and off unless requested', () => {
  const clientUuid = '00000000-0000-0000-0000-000000000000'
  const readOnly = dryRun('./finalize-keycloak-grok-client.mjs', ['--client-uuid', clientUuid])
  const send = dryRun('./finalize-keycloak-grok-client.mjs', ['--client-uuid', clientUuid, '--enable-send-scope'])
  const realm = dryRun('./configure-keycloak-mcp-pilot.mjs', [])
  const realmSend = dryRun('./configure-keycloak-mcp-pilot.mjs', ['--enable-send-scope'])

  assert.deepEqual(readOnly.defaultScopes, ['beam-mcp-audience'])
  assert.deepEqual(readOnly.optionalScopes, ['beam:read'])
  assert.equal(readOnly.sendScopeAssigned, false)
  assert.equal(readOnly.clientName, 'Grok / Beam read-only pilot')
  assert.deepEqual(send.defaultScopes, ['beam-mcp-audience'])
  assert.deepEqual(send.optionalScopes, ['beam:read', 'beam:send'])
  assert.equal(send.sendScopeAssigned, true)
  assert.equal(send.clientName, 'Grok / Beam send pilot')
  assert.equal(realm.sendScopeCreated, false)
  assert.equal(realmSend.sendScopeCreated, true)
})
