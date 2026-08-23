#!/usr/bin/env node

import { isIP } from 'node:net'
import { readFileSync } from 'node:fs'
import process from 'node:process'

const POLICY_TYPE = 'org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy'
const REQUIRED_RESOURCE = 'https://mcp.beam.directory/mcp'

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function valuesAfter(flag) {
  return process.argv.flatMap((value, index) => value === flag ? [process.argv[index + 1]] : []).filter(Boolean)
}

function fail(message) {
  console.error(`[configure-keycloak-grok-dcr-window] ${message}`)
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
const mode = (valueAfter('--mode') ?? 'closed').trim()
const baseUrl = safeBaseUrl(valueAfter('--base-url') ?? 'https://identity.beam.directory')
const realm = (valueAfter('--realm') ?? 'beam-mcp-pilot').trim()
const adminUsername = (valueAfter('--admin-username') ?? 'beam-bootstrap').trim()
const adminPasswordFile = valueAfter('--admin-password-file')
const trustedHosts = valuesAfter('--trusted-host').map((value) => value.trim())
const trustedDomains = valuesAfter('--trusted-domain').map((value) => value.trim())
const activateNewClient = process.argv.includes('--activate-new-client')

if (!['open', 'closed'].includes(mode)) fail('--mode must be open or closed')
if (!/^[a-z0-9-]{1,63}$/.test(realm)) fail('--realm is invalid')
if (!/^[a-zA-Z0-9._-]{1,64}$/.test(adminUsername)) fail('--admin-username is invalid')
if (mode === 'open' && (trustedHosts.length + trustedDomains.length === 0 || trustedHosts.length > 8 || trustedHosts.some((host) => isIP(host) !== 4))) {
  fail('open mode requires one to eight exact IPv4 --trusted-host values or the pinned Grok egress domain')
}
if (trustedDomains.some((domain) => !['*.bc.googleusercontent.com', 'grok.com'].includes(domain))) {
  fail('--trusted-domain is pinned to *.bc.googleusercontent.com or grok.com')
}
if (mode === 'closed' && (trustedHosts.length > 0 || trustedDomains.length > 0)) {
  fail('--trusted-host and --trusted-domain are only valid in open mode')
}
if (mode === 'closed' && activateNewClient) fail('--activate-new-client is only valid in open mode')
if (activateNewClient && !trustedDomains.includes('*.bc.googleusercontent.com')) {
  fail('--activate-new-client requires the pinned Google Cloud egress domain')
}
if (activateNewClient && !trustedDomains.includes('grok.com')) {
  fail('--activate-new-client requires the pinned Grok callback domain')
}

const plan = {
  apply,
  mode,
  baseUrl,
  realm,
  trustedHosts: mode === 'open' ? trustedHosts : [],
  trustedDomains: mode === 'open' ? trustedDomains : [],
  anonymousRegistration: mode === 'open' ? 'restricted to configured egress matches' : 'blocked',
  clientUriMatching: mode === 'open' && !activateNewClient ? 'temporarily disabled for the restricted staging window' : 'enabled',
  newlyRegisteredClientsEnabled: mode === 'open' ? activateNewClient : null,
  allowedCustomScopes: ['beam:read', 'beam-mcp-audience'],
  sendScopeAllowed: false,
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
const realmRepresentation = await request(realmPath, { token: adminToken })
const components = await request(
  `${realmPath}/components?parent=${encodeURIComponent(realmRepresentation.id)}&type=${encodeURIComponent(POLICY_TYPE)}`,
  { token: adminToken },
)
const clients = await request(`${realmPath}/clients?max=500`, { token: adminToken })
const clientScopes = await request(`${realmPath}/client-scopes`, { token: adminToken })
const realmOptionalScopes = await request(`${realmPath}/default-optional-client-scopes`, { token: adminToken })
const realmDefaultScopes = await request(`${realmPath}/default-default-client-scopes`, { token: adminToken })

function policy(providerId, subType = 'anonymous') {
  const matches = components.filter((component) => component.providerId === providerId && component.subType === subType)
  if (matches.length !== 1) fail(`expected exactly one ${subType} ${providerId} policy, found ${matches.length}`)
  return matches[0]
}

async function updatePolicy(component, config) {
  await request(`${realmPath}/components/${encodeURIComponent(component.id)}`, {
    method: 'PUT',
    token: adminToken,
    body: { ...component, config },
    expected: [204],
  })
}

async function ensureTemporaryDisabledPolicy() {
  const policies = components.filter((component) => component.providerId === 'client-disabled' && component.subType === 'anonymous')
  const foreignPolicies = policies.filter((component) => component.name !== 'Beam Grok DCR temporary client disable')
  if (foreignPolicies.length > 0) fail('an unrelated anonymous client-disabled policy already exists')
  if (policies.length === 1) return policies[0]
  await request(`${realmPath}/components`, {
    method: 'POST',
    token: adminToken,
    body: {
      name: 'Beam Grok DCR temporary client disable',
      providerId: 'client-disabled',
      providerType: POLICY_TYPE,
      parentId: realmRepresentation.id,
      subType: 'anonymous',
      config: {},
    },
    expected: [201],
  })
  return null
}

async function removeTemporaryDisabledPolicy() {
  const policies = components.filter(
    (component) => component.providerId === 'client-disabled'
      && component.subType === 'anonymous'
      && component.name === 'Beam Grok DCR temporary client disable',
  )
  for (const component of policies) {
    await request(`${realmPath}/components/${encodeURIComponent(component.id)}`, {
      method: 'DELETE', token: adminToken, expected: [204],
    })
  }
}

const readScope = clientScopes.find((scope) => scope.name === 'beam:read')
const audienceScope = clientScopes.find((scope) => scope.name === 'beam-mcp-audience')
if (!readScope?.id || !audienceScope?.id) fail('required Beam client scopes do not exist')

if (!realmOptionalScopes.some((scope) => scope.id === readScope.id)) {
  await request(`${realmPath}/default-optional-client-scopes/${encodeURIComponent(readScope.id)}`, {
    method: 'PUT', token: adminToken, expected: [204],
  })
}
for (const scope of realmOptionalScopes) {
  if (scope.id === readScope.id) continue
  await request(`${realmPath}/default-optional-client-scopes/${encodeURIComponent(scope.id)}`, {
    method: 'DELETE', token: adminToken, expected: [204],
  })
}
for (const scope of realmDefaultScopes) {
  if (scope.id === audienceScope.id) continue
  await request(`${realmPath}/default-default-client-scopes/${encodeURIComponent(scope.id)}`, {
    method: 'DELETE', token: adminToken, expected: [204],
  })
}
if (!realmDefaultScopes.some((scope) => scope.id === audienceScope.id)) {
  await request(`${realmPath}/default-default-client-scopes/${encodeURIComponent(audienceScope.id)}`, {
    method: 'PUT', token: adminToken, expected: [204],
  })
}

const trustedHostsPolicy = policy('trusted-hosts')
const maxClientsPolicy = policy('max-clients')
const allowedScopesPolicy = policy('allowed-client-templates')

if (mode === 'open' && !activateNewClient) await ensureTemporaryDisabledPolicy()
else await removeTemporaryDisabledPolicy()

await updatePolicy(trustedHostsPolicy, mode === 'open'
  ? {
      'trusted-hosts': [...trustedHosts, ...trustedDomains],
      'host-sending-registration-request-must-match': ['true'],
      'client-uris-must-match': [activateNewClient ? 'true' : 'false'],
    }
  : {
      'trusted-hosts': [],
      'host-sending-registration-request-must-match': ['true'],
      'client-uris-must-match': ['true'],
    })

await updatePolicy(maxClientsPolicy, {
  'max-clients': [mode === 'open' ? String(clients.length + 1) : '200'],
})

await updatePolicy(allowedScopesPolicy, {
  'allowed-client-scopes': ['beam:read', 'beam-mcp-audience'],
  'allow-default-scopes': ['true'],
})

const refreshedComponents = await request(
  `${realmPath}/components?parent=${encodeURIComponent(realmRepresentation.id)}&type=${encodeURIComponent(POLICY_TYPE)}`,
  { token: adminToken },
)
const refreshedTrustedHosts = refreshedComponents.find(
  (component) => component.providerId === 'trusted-hosts' && component.subType === 'anonymous',
)
const refreshedMaxClients = refreshedComponents.find(
  (component) => component.providerId === 'max-clients' && component.subType === 'anonymous',
)
const expectedHosts = mode === 'open' ? [...trustedHosts, ...trustedDomains].sort() : []
const actualHosts = refreshedTrustedHosts?.config?.['trusted-hosts'] ?? []
if (JSON.stringify([...actualHosts].sort()) !== JSON.stringify(expectedHosts)) fail('trusted-host policy verification failed')
if (refreshedTrustedHosts?.config?.['host-sending-registration-request-must-match']?.[0] !== 'true') {
  fail('source host verification is not enabled')
}
const expectedUriMatch = mode === 'closed' || activateNewClient ? 'true' : 'false'
if (refreshedTrustedHosts?.config?.['client-uris-must-match']?.[0] !== expectedUriMatch) {
  fail('client URI policy verification failed')
}
const expectedMaxClients = mode === 'open' ? String(clients.length + 1) : '200'
if (refreshedMaxClients?.config?.['max-clients']?.[0] !== expectedMaxClients) {
  fail('max-client policy verification failed')
}
const temporaryDisabledPolicies = refreshedComponents.filter(
  (component) => component.providerId === 'client-disabled'
    && component.subType === 'anonymous'
    && component.name === 'Beam Grok DCR temporary client disable',
)
if (mode === 'open' && !activateNewClient && temporaryDisabledPolicies.length !== 1) fail('temporary client-disabled policy is not active')
if ((mode === 'closed' || activateNewClient) && temporaryDisabledPolicies.length !== 0) fail('temporary client-disabled policy was not removed')

console.log(JSON.stringify({
  ok: true,
  ...plan,
  apply: true,
  existingClientCount: clients.length,
  maxClients: Number(expectedMaxClients),
  policyStateVerified: true,
  requiredResource: REQUIRED_RESOURCE,
}, null, 2))
