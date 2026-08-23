#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import process from 'node:process'

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`[configure-keycloak-mcp-pilot] ${message}`)
  process.exit(1)
}

function readSecret(file, name) {
  if (!file) fail(`${name} file is required`)
  const value = readFileSync(file, 'utf8').trim()
  if (!value) fail(`${name} file is empty`)
  return value
}

function safeBaseUrl(raw) {
  const url = new URL(raw)
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    fail('--base-url must use HTTPS outside loopback')
  }
  if (url.username || url.password || url.search || url.hash) fail('--base-url must not contain credentials')
  return url.href.replace(/\/$/, '')
}

const apply = process.argv.includes('--apply')
const baseUrl = safeBaseUrl(valueAfter('--base-url') ?? 'https://identity.beam.directory')
const realm = (valueAfter('--realm') ?? 'beam-mcp-pilot').trim()
const adminUsername = (valueAfter('--admin-username') ?? 'beam-bootstrap').trim()
const adminPasswordFile = valueAfter('--admin-password-file')
const mcpClientSecretFile = valueAfter('--mcp-client-secret-file')
const pilotUserPasswordFile = valueAfter('--pilot-user-password-file')
const pilotUsername = (valueAfter('--pilot-username') ?? 'pilot-operator').trim()
const mcpResource = valueAfter('--mcp-resource') ?? 'https://mcp.beam.directory/mcp'

if (!/^[a-z0-9-]{1,63}$/.test(realm)) fail('--realm is invalid')
if (!/^[a-zA-Z0-9._-]{1,64}$/.test(adminUsername)) fail('--admin-username is invalid')
if (!/^[a-zA-Z0-9._-]{1,64}$/.test(pilotUsername)) fail('--pilot-username is invalid')
if (mcpResource !== 'https://mcp.beam.directory/mcp') fail('the pilot MCP resource is pinned to https://mcp.beam.directory/mcp')

const plan = {
  apply,
  baseUrl,
  realm,
  pilotUsername,
  mcpResource,
  readOnlyScope: 'beam:read',
  sendScopeCreated: false,
  confidentialClients: ['beam-mcp-resource-server'],
  publicClients: ['beam-grok-pilot'],
  tokenLifespanSeconds: 300,
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2))
  process.exit(0)
}

const adminPassword = readSecret(adminPasswordFile, 'Keycloak admin password')
const mcpClientSecret = readSecret(mcpClientSecretFile, 'MCP introspection client secret')
const pilotUserPassword = readSecret(pilotUserPasswordFile, 'pilot user password')

async function request(path, { method = 'GET', token, body, form, expected = [200] } = {}) {
  const headers = { accept: 'application/json' }
  let payload
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  } else if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    payload = new URLSearchParams(form)
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(15_000),
  })
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} returned HTTP ${response.status}`)
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return null
  return response.json()
}

const tokenResponse = await request('/realms/master/protocol/openid-connect/token', {
  method: 'POST',
  form: {
    grant_type: 'password',
    client_id: 'admin-cli',
    username: adminUsername,
    password: adminPassword,
  },
})
const adminToken = tokenResponse?.access_token
if (typeof adminToken !== 'string' || !adminToken) fail('Keycloak did not issue an admin token')

const realmPath = `/admin/realms/${encodeURIComponent(realm)}`
const existingRealmResponse = await fetch(`${baseUrl}${realmPath}`, {
  headers: { authorization: `Bearer ${adminToken}`, accept: 'application/json' },
  signal: AbortSignal.timeout(15_000),
})
if (existingRealmResponse.status === 404) {
  await request('/admin/realms', {
    method: 'POST',
    token: adminToken,
    expected: [201],
    body: {
      realm,
      displayName: 'Beam read-only MCP pilot',
      enabled: true,
      sslRequired: 'external',
      registrationAllowed: false,
      resetPasswordAllowed: false,
      rememberMe: false,
      loginWithEmailAllowed: false,
      duplicateEmailsAllowed: false,
      accessTokenLifespan: 300,
      ssoSessionIdleTimeout: 900,
      ssoSessionMaxLifespan: 28_800,
      revokeRefreshToken: true,
      refreshTokenMaxReuse: 0,
      bruteForceProtected: true,
      permanentLockout: false,
      failureFactor: 5,
      waitIncrementSeconds: 60,
      minimumQuickLoginWaitSeconds: 60,
      maxFailureWaitSeconds: 900,
      maxDeltaTimeSeconds: 43_200,
      eventsEnabled: true,
      eventsExpiration: 86_400,
      adminEventsEnabled: true,
      adminEventsDetailsEnabled: true,
    },
  })
} else if (!existingRealmResponse.ok) {
  throw new Error(`GET ${realmPath} returned HTTP ${existingRealmResponse.status}`)
}

async function ensureClientScope(representation) {
  const scopes = await request(`${realmPath}/client-scopes`, { token: adminToken })
  const existing = scopes.find((scope) => scope.name === representation.name)
  if (existing) {
    await request(`${realmPath}/client-scopes/${encodeURIComponent(existing.id)}`, {
      method: 'PUT', token: adminToken, body: { ...existing, ...representation }, expected: [204],
    })
    return existing.id
  }
  await request(`${realmPath}/client-scopes`, {
    method: 'POST', token: adminToken, body: representation, expected: [201],
  })
  const refreshed = await request(`${realmPath}/client-scopes`, { token: adminToken })
  const created = refreshed.find((scope) => scope.name === representation.name)
  if (!created?.id) throw new Error(`client scope ${representation.name} was not created`)
  return created.id
}

const readScopeId = await ensureClientScope({
  name: 'beam:read',
  description: 'Read Beam status and prepare a policy preview without delivery',
  protocol: 'openid-connect',
  attributes: {
    'display.on.consent.screen': 'true',
    'include.in.token.scope': 'true',
    'consent.screen.text': 'Read Beam trust metadata and prepare handoff previews',
  },
})

const audienceScopeId = await ensureClientScope({
  name: 'beam-mcp-audience',
  description: 'Bind access tokens to the exact Beam MCP resource and its introspection client',
  protocol: 'openid-connect',
  attributes: {
    'display.on.consent.screen': 'false',
    'include.in.token.scope': 'false',
  },
  protocolMappers: [
    {
      name: 'beam-mcp-resource-audience',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      consentRequired: false,
      config: {
        'included.custom.audience': mcpResource,
        'access.token.claim': 'true',
        'introspection.token.claim': 'true',
        'id.token.claim': 'false',
        'lightweight.claim': 'false',
      },
    },
    {
      name: 'beam-mcp-introspection-client-audience',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      consentRequired: false,
      config: {
        'included.client.audience': 'beam-mcp-resource-server',
        'access.token.claim': 'true',
        'introspection.token.claim': 'true',
        'id.token.claim': 'false',
        'lightweight.claim': 'false',
      },
    },
  ],
})

for (const scopeId of [readScopeId, audienceScopeId]) {
  await request(`${realmPath}/default-default-client-scopes/${encodeURIComponent(scopeId)}`, {
    method: 'PUT', token: adminToken, expected: [204],
  })
}

async function ensureClient(representation) {
  const clients = await request(`${realmPath}/clients?clientId=${encodeURIComponent(representation.clientId)}`, { token: adminToken })
  const existing = clients.find((client) => client.clientId === representation.clientId)
  if (existing) {
    await request(`${realmPath}/clients/${encodeURIComponent(existing.id)}`, {
      method: 'PUT', token: adminToken, body: { ...existing, ...representation }, expected: [204],
    })
    return existing.id
  }
  await request(`${realmPath}/clients`, {
    method: 'POST', token: adminToken, body: representation, expected: [201],
  })
  const refreshed = await request(`${realmPath}/clients?clientId=${encodeURIComponent(representation.clientId)}`, { token: adminToken })
  const created = refreshed.find((client) => client.clientId === representation.clientId)
  if (!created?.id) throw new Error(`client ${representation.clientId} was not created`)
  return created.id
}

await ensureClient({
  clientId: 'beam-mcp-resource-server',
  name: 'Beam MCP resource server introspection',
  enabled: true,
  protocol: 'openid-connect',
  publicClient: false,
  clientAuthenticatorType: 'client-secret',
  secret: mcpClientSecret,
  standardFlowEnabled: false,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  fullScopeAllowed: false,
})

await ensureClient({
  clientId: 'beam-grok-pilot',
  name: 'Beam Grok read-only pilot',
  enabled: true,
  protocol: 'openid-connect',
  publicClient: true,
  standardFlowEnabled: true,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  fullScopeAllowed: false,
  redirectUris: ['http://127.0.0.1:*', 'http://localhost:*'],
  webOrigins: ['+'],
  defaultClientScopes: ['beam:read', 'beam-mcp-audience'],
  attributes: {
    'pkce.code.challenge.method': 'S256',
    'post.logout.redirect.uris': '+',
  },
})

const users = await request(`${realmPath}/users?username=${encodeURIComponent(pilotUsername)}&exact=true`, { token: adminToken })
let userId = users.find((user) => user.username === pilotUsername)?.id
if (!userId) {
  await request(`${realmPath}/users`, {
    method: 'POST', token: adminToken, expected: [201], body: {
      username: pilotUsername,
      enabled: true,
      emailVerified: false,
      attributes: { tenant: ['beam-pilot'] },
      requiredActions: [],
    },
  })
  const refreshedUsers = await request(`${realmPath}/users?username=${encodeURIComponent(pilotUsername)}&exact=true`, { token: adminToken })
  userId = refreshedUsers.find((user) => user.username === pilotUsername)?.id
}
if (!userId) throw new Error(`pilot user ${pilotUsername} was not created`)
await request(`${realmPath}/users/${encodeURIComponent(userId)}/reset-password`, {
  method: 'PUT', token: adminToken, expected: [204], body: {
    type: 'password', value: pilotUserPassword, temporary: false,
  },
})

const metadata = await request(`/realms/${encodeURIComponent(realm)}/.well-known/openid-configuration`)
if (metadata.issuer !== `${baseUrl}/realms/${realm}`) throw new Error('issuer metadata does not match the configured realm')
if (!metadata.response_types_supported?.includes('code')) throw new Error('authorization code flow is not advertised')
if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('PKCE S256 is not advertised')
if (metadata.introspection_endpoint !== `${baseUrl}/realms/${realm}/protocol/openid-connect/token/introspect`) {
  throw new Error('introspection endpoint is not the expected public URL')
}

console.log(JSON.stringify({ ok: true, ...plan, apply: true, metadataVerified: true }, null, 2))
