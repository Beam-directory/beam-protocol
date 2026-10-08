#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import process from 'node:process'

const EXPECTED_REDIRECT = 'https://grok.com/connectors-oauth-exchange-code/'
const EXPECTED_ORIGIN = 'https://grok.com'

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`[finalize-keycloak-grok-client] ${message}`)
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
const enableSendScope = process.argv.includes('--enable-send-scope')
const baseUrl = safeBaseUrl(valueAfter('--base-url') ?? 'https://identity.beam.directory')
const realm = (valueAfter('--realm') ?? 'beam-mcp-pilot').trim()
const adminUsername = (valueAfter('--admin-username') ?? 'beam-bootstrap').trim()
const adminPasswordFile = valueAfter('--admin-password-file')
const clientUuid = valueAfter('--client-uuid')?.trim()
const optionalScopes = ['beam:read', ...(enableSendScope ? ['beam:send'] : [])]
const clientName = enableSendScope ? 'Grok / Beam send pilot' : 'Grok / Beam read-only pilot'

if (!/^[a-z0-9-]{1,63}$/.test(realm)) fail('--realm is invalid')
if (!/^[a-zA-Z0-9._-]{1,64}$/.test(adminUsername)) fail('--admin-username is invalid')
if (!clientUuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientUuid)) {
  fail('--client-uuid must pin one exact Keycloak client UUID')
}

const plan = {
  apply,
  baseUrl,
  realm,
  clientUuid,
  expectedRedirect: EXPECTED_REDIRECT,
  expectedOrigin: EXPECTED_ORIGIN,
  pkceMethod: 'S256',
  defaultScopes: ['beam-mcp-audience'],
  optionalScopes,
  clientName,
  sendScopeAssigned: enableSendScope,
  registrationAccessTokenAction: 'rotate and discard',
}

if (!apply) {
  console.log(JSON.stringify(plan, null, 2))
  process.exit(0)
}

const adminPassword = readSecret(adminPasswordFile, 'Keycloak admin password')

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
  if (!expected.includes(response.status)) throw new Error(`${method} ${path} returned HTTP ${response.status}`)
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
const clientPath = `${realmPath}/clients/${encodeURIComponent(clientUuid)}`
const client = await request(clientPath, { token: adminToken })

if (!['Grok', 'Grok / Beam read-only pilot', 'Grok / Beam send pilot'].includes(client.name)) {
  fail('client name is not the expected Grok client')
}
if (client.publicClient !== true) fail('Grok client is not public')
if (client.redirectUris?.length !== 1 || client.redirectUris[0] !== EXPECTED_REDIRECT) fail('Grok redirect URI is not exact')
if (client.webOrigins?.length !== 1 || client.webOrigins[0] !== EXPECTED_ORIGIN) fail('Grok web origin is not exact')
if (client.directAccessGrantsEnabled || client.implicitFlowEnabled || client.serviceAccountsEnabled) {
  fail('Grok client has an unexpected grant or service-account flow')
}
if (!client.standardFlowEnabled) fail('Grok client does not have authorization-code flow enabled')

await request(clientPath, {
  method: 'PUT',
  token: adminToken,
  expected: [204],
  body: {
    ...client,
    name: clientName,
    enabled: true,
    consentRequired: true,
    fullScopeAllowed: false,
    publicClient: true,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: [EXPECTED_REDIRECT],
    webOrigins: [EXPECTED_ORIGIN],
    attributes: {
      ...client.attributes,
      'pkce.code.challenge.method': 'S256',
    },
  },
})

const allScopes = await request(`${realmPath}/client-scopes`, { token: adminToken })
const audienceScope = allScopes.find((scope) => scope.name === 'beam-mcp-audience')
const readScope = allScopes.find((scope) => scope.name === 'beam:read')
const sendScope = allScopes.find((scope) => scope.name === 'beam:send')
if (!audienceScope?.id || !readScope?.id) fail('required Beam client scopes are missing')
if (enableSendScope && !sendScope?.id) fail('beam:send client scope does not exist')
const retainedOptionalScopeIds = new Set([readScope.id, ...(enableSendScope ? [sendScope.id] : [])])

const defaultScopes = await request(`${clientPath}/default-client-scopes`, { token: adminToken })
for (const scope of defaultScopes) {
  if (scope.id === audienceScope.id) continue
  await request(`${clientPath}/default-client-scopes/${encodeURIComponent(scope.id)}`, {
    method: 'DELETE', token: adminToken, expected: [204],
  })
}
if (!defaultScopes.some((scope) => scope.id === audienceScope.id)) {
  await request(`${clientPath}/default-client-scopes/${encodeURIComponent(audienceScope.id)}`, {
    method: 'PUT', token: adminToken, expected: [204],
  })
}

const assignedOptionalScopes = await request(`${clientPath}/optional-client-scopes`, { token: adminToken })
for (const scope of assignedOptionalScopes) {
  if (retainedOptionalScopeIds.has(scope.id)) continue
  await request(`${clientPath}/optional-client-scopes/${encodeURIComponent(scope.id)}`, {
    method: 'DELETE', token: adminToken, expected: [204],
  })
}
for (const scopeId of retainedOptionalScopeIds) {
  if (assignedOptionalScopes.some((scope) => scope.id === scopeId)) continue
  await request(`${clientPath}/optional-client-scopes/${encodeURIComponent(scopeId)}`, {
    method: 'PUT', token: adminToken, expected: [204],
  })
}

// Rotating creates a new registration access token and invalidates the token
// returned to the dynamic registrant. The replacement is deliberately ignored.
await request(`${clientPath}/registration-access-token`, {
  method: 'POST', token: adminToken,
})

const [verifiedClient, verifiedDefaultScopes, verifiedOptionalScopes] = await Promise.all([
  request(clientPath, { token: adminToken }),
  request(`${clientPath}/default-client-scopes`, { token: adminToken }),
  request(`${clientPath}/optional-client-scopes`, { token: adminToken }),
])
const result = {
  ok: verifiedClient.enabled === true && verifiedClient.attributes?.['pkce.code.challenge.method'] === 'S256',
  clientId: verifiedClient.clientId,
  name: verifiedClient.name,
  enabled: verifiedClient.enabled,
  publicClient: verifiedClient.publicClient,
  pkceMethod: verifiedClient.attributes?.['pkce.code.challenge.method'],
  redirectUris: verifiedClient.redirectUris,
  webOrigins: verifiedClient.webOrigins,
  consentRequired: verifiedClient.consentRequired,
  fullScopeAllowed: verifiedClient.fullScopeAllowed,
  defaultScopes: verifiedDefaultScopes.map((scope) => scope.name),
  optionalScopes: verifiedOptionalScopes.map((scope) => scope.name),
  registrationAccessTokenRotatedAndDiscarded: true,
  sendScopeAssigned: [...verifiedDefaultScopes, ...verifiedOptionalScopes].some((scope) => scope.name === 'beam:send'),
}
if (!result.ok) fail('final client verification failed')
if (JSON.stringify(result.defaultScopes) !== JSON.stringify(['beam-mcp-audience'])) fail('default scopes are not minimal')
if (result.defaultScopes.includes('beam:send')) fail('beam:send must stay optional')
const verifiedOptionalScopeNames = [...result.optionalScopes].sort()
if (JSON.stringify(verifiedOptionalScopeNames) !== JSON.stringify([...optionalScopes].sort())) {
  fail(enableSendScope ? 'optional scopes are not the approved send profile' : 'optional scopes are not read-only')
}
if (result.sendScopeAssigned !== enableSendScope) fail('send scope assignment does not match the requested profile')

console.log(JSON.stringify(result, null, 2))
