import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { BeamIdentity } from 'beam-protocol-sdk'

const execFile = promisify(execFileCallback)
const accessToken = 'opaque-container-e2e-token'
const oauthClientId = 'beam-mcp-resource-server'
const oauthClientSecret = 'container-e2e-introspection-secret'
const ownBeamId = 'grok-container@acme.beam.directory'
const targetBeamId = 'support-container@partner.beam.directory'

function json(response, status, body) {
  const serialized = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
  })
  response.end(serialized)
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not expose a TCP port')
  return new URL(`http://127.0.0.1:${address.port}`)
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function reservePort() {
  const server = createServer()
  const url = await listen(server)
  await closeServer(server)
  return Number.parseInt(url.port, 10)
}

function directoryAgent(beamId) {
  return {
    beam_id: beamId,
    display_name: beamId === ownBeamId ? 'Grok container' : 'Partner support',
    capabilities: ['conversation.message'],
    public_key: 'redacted-test-public-key',
    org: beamId === ownBeamId ? 'acme' : 'partner',
    trust_score: 0.96,
    verified: true,
    verification_tier: 'business',
    verification_status: 'verified',
    assurance_scope: 'local',
    created_at: '2026-08-23T00:00:00.000Z',
    last_seen: '2026-08-23T00:00:00.000Z',
  }
}

function sanitizedLogTail(logs, sensitiveValues) {
  let sanitized = logs
  for (const value of sensitiveValues) {
    if (value) sanitized = sanitized.replaceAll(value, '[REDACTED]')
  }
  return sanitized.trim().slice(-4_096)
}

function containerFailure(message, logs, sensitiveValues) {
  const tail = sanitizedLogTail(logs, sensitiveValues)
  return new Error(tail ? `${message}\nSanitized container logs:\n${tail}` : message)
}

async function waitForHealth(url, child, getLogs, sensitiveValues, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw containerFailure(`MCP container exited early with code ${child.exitCode}`, getLogs(), sensitiveValues)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.status === 200) return
      lastError = new Error(`health returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw containerFailure(
    `MCP container health timed out: ${lastError?.message ?? 'unknown error'}`,
    getLogs(),
    sensitiveValues,
  )
}

async function prepareSecretMountsForRuntime(secretDirectory) {
  await execFile('docker', [
    'run', '--rm',
    '--network', 'none',
    '--user', '0:0',
    '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${secretDirectory},dst=/run/secrets`,
    'beam-mcp:local',
    '-c', 'chmod 0711 /run/secrets && chown 1000:1000 /run/secrets/* && chmod 0400 /run/secrets/*',
  ])
}

async function stopContainer(child, name) {
  if (child.exitCode === null) child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode === null) {
    await execFile('docker', ['rm', '--force', name]).catch(() => undefined)
  }
}

const identity = BeamIdentity.generate({ agentName: 'grok-container', orgName: 'acme' }).export()
const secretDirectory = await mkdtemp(join(tmpdir(), 'beam-mcp-container-e2e-'))
const servers = []
let dockerChild
let connected
const containerName = `beam-mcp-container-e2e-${process.pid}`
let containerLogs = ''

try {
  const mcpPort = await reservePort()
  const mcpUrl = new URL(`http://127.0.0.1:${mcpPort}/mcp`)

  let oauthBase = new URL('http://127.0.0.1')
  const expectedBasic = `Basic ${Buffer.from(`${encodeURIComponent(oauthClientId)}:${encodeURIComponent(oauthClientSecret)}`).toString('base64')}`
  const oauthServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', oauthBase)
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      json(response, 200, {
        issuer: oauthBase.href.replace(/\/$/u, ''),
        authorization_endpoint: new URL('/authorize', oauthBase).href,
        token_endpoint: new URL('/token', oauthBase).href,
        introspection_endpoint: new URL('/introspect', oauthBase).href,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      })
      return
    }
    if (request.method === 'POST' && url.pathname === '/introspect') {
      const chunks = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const token = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('token')
      if (request.headers.authorization !== expectedBasic) {
        json(response, 401, { error: 'invalid_client' })
        return
      }
      json(response, 200, {
        active: token === accessToken,
        client_id: 'official-mcp-container-e2e',
        sub: 'operator-e2e',
        tenant: 'acme-e2e',
        scope: 'beam:read',
        aud: mcpUrl.href,
        exp: Math.floor(Date.now() / 1_000) + 300,
      })
      return
    }
    json(response, 404, { error: 'not_found' })
  })
  oauthBase = await listen(oauthServer)
  servers.push(oauthServer)

  let directoryBase = new URL('http://127.0.0.1')
  const directoryServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', directoryBase)
    if (request.method === 'GET' && url.pathname === '/stats') {
      json(response, 200, { agents: 2, verifiedAgents: 2, intentsProcessed: 0, version: 'container-e2e' })
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith('/agents/')) {
      const beamId = decodeURIComponent(url.pathname.slice('/agents/'.length))
      if (beamId === ownBeamId || beamId === targetBeamId) json(response, 200, directoryAgent(beamId))
      else json(response, 404, { error: 'not_found' })
      return
    }
    json(response, 404, { error: 'not_found' })
  })
  directoryBase = await listen(directoryServer)
  servers.push(directoryServer)

  const secrets = {
    beam_public_key: identity.publicKeyBase64,
    beam_private_key: identity.privateKeyBase64,
    beam_api_key: 'beam_container_e2e_api_key',
    oauth_client_secret: oauthClientSecret,
  }
  for (const [name, value] of Object.entries(secrets)) {
    await writeFile(join(secretDirectory, name), `${value}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  await prepareSecretMountsForRuntime(secretDirectory)

  const dockerArgs = [
    'run', '--rm', '--name', containerName,
    '--network', 'host',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '-e', 'BEAM_MCP_TRANSPORT=http',
    '-e', 'BEAM_MCP_HTTP_HOST=0.0.0.0',
    '-e', `BEAM_MCP_HTTP_PORT=${mcpPort}`,
    '-e', `BEAM_MCP_PUBLIC_URL=${mcpUrl.href}`,
    '-e', `BEAM_MCP_OAUTH_ISSUER=${oauthBase.href.replace(/\/$/u, '')}`,
    '-e', `BEAM_MCP_OAUTH_METADATA_URL=${new URL('/.well-known/oauth-authorization-server', oauthBase).href}`,
    '-e', `BEAM_MCP_OAUTH_INTROSPECTION_URL=${new URL('/introspect', oauthBase).href}`,
    '-e', `BEAM_MCP_OAUTH_CLIENT_ID=${oauthClientId}`,
    '-e', 'BEAM_MCP_OAUTH_CLIENT_SECRET_FILE=/run/secrets/oauth_client_secret',
    '-e', `BEAM_ID=${identity.beamId}`,
    '-e', 'BEAM_PUBLIC_KEY_BASE64_FILE=/run/secrets/beam_public_key',
    '-e', 'BEAM_PRIVATE_KEY_BASE64_FILE=/run/secrets/beam_private_key',
    '-e', 'BEAM_API_KEY_FILE=/run/secrets/beam_api_key',
    '-e', `BEAM_DIRECTORY_URL=${directoryBase.href.replace(/\/$/u, '')}`,
    '-e', 'BEAM_MCP_DANGEROUSLY_ALLOW_INSECURE_OAUTH=true',
    '-e', 'BEAM_MCP_ENABLE_SEND=false',
    '-e', 'BEAM_MCP_MIN_VERIFICATION_TIER=business',
    ...Object.keys(secrets).flatMap((name) => ['--mount', `type=bind,src=${join(secretDirectory, name)},dst=/run/secrets/${name},readonly`]),
    'beam-mcp:local',
  ]
  dockerChild = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [dockerChild.stdout, dockerChild.stderr]) {
    stream.on('data', (chunk) => {
      containerLogs = `${containerLogs}${chunk.toString('utf8')}`.slice(-64 * 1024)
    })
  }

  await waitForHealth(
    new URL('/health', mcpUrl),
    dockerChild,
    () => containerLogs,
    [accessToken, ...Object.values(secrets)],
  )
  const inspection = JSON.parse((await execFile('docker', ['inspect', containerName, '--format', '{{json .Config.Env}}'])).stdout)
  const serializedInspection = JSON.stringify(inspection)
  for (const secret of Object.values(secrets)) assert.equal(serializedInspection.includes(secret), false)
  assert.ok(inspection.some((entry) => entry === 'BEAM_MCP_ENABLE_SEND=false'))

  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    authProvider: { token: async () => accessToken },
  })
  const client = new Client({ name: 'beam-container-e2e', version: '1.0.0' })
  await client.connect(transport)
  connected = { client, transport }

  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['beam_prepare_handoff', 'beam_status'])
  const status = await client.callTool({ name: 'beam_status', arguments: { target: targetBeamId } })
  assert.equal(status.isError, undefined)
  const target = status.structuredContent.target
  assert.equal(target.assurance.tier, 'business')
  assert.equal(target.assurance.scope, 'local')
  assert.equal(containerLogs.includes(accessToken), false)
  for (const secret of Object.values(secrets)) assert.equal(containerLogs.includes(secret), false)

  process.stdout.write(`${JSON.stringify({
    ok: true,
    image: 'beam-mcp:local',
    runtimeUid: 1000,
    secretDelivery: 'mounted-files',
    tools: tools.tools.map((tool) => tool.name).sort(),
    targetAssuranceTier: target.assurance.tier,
    sendAdvertised: tools.tools.some((tool) => tool.name === 'beam_send'),
  })}\n`)
} finally {
  if (connected) {
    await connected.transport.terminateSession().catch(() => undefined)
    await connected.client.close().catch(() => undefined)
  }
  if (dockerChild) await stopContainer(dockerChild, containerName)
  for (const server of servers.reverse()) await closeServer(server).catch(() => undefined)
  await rm(secretDirectory, { recursive: true, force: true })
}
