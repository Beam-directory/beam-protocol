#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import process from 'node:process'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  throw new Error(message)
}

function safeHttpsUrl(raw, name) {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail(`${name} must be an HTTPS URL without credentials, query, or fragment`)
  }
  return url.href.replace(/\/$/, '')
}

function readSecret(file, name) {
  if (!file) fail(`${name} file is required`)
  const value = readFileSync(file, 'utf8').trim()
  if (!value) fail(`${name} file is empty`)
  return value
}

function base64url(buffer) {
  return buffer.toString('base64url')
}

function stringArray(value) {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string')
  return []
}

function safeTokenSummary(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return {
      issuer: payload.iss,
      audience: stringArray(payload.aud),
      authorizedParty: payload.azp,
      scope: stringArray(payload.scope),
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      type: payload.typ,
    }
  } catch {
    return { format: 'opaque-or-invalid-jwt' }
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    const oauthError = await response.json().catch(() => null)
    const safeDetail = oauthError && typeof oauthError === 'object'
      ? { error: oauthError.error, error_description: oauthError.error_description }
      : null
    throw new Error(`${options.method ?? 'GET'} ${new URL(url).pathname} returned HTTP ${response.status}${safeDetail ? ` ${JSON.stringify(safeDetail)}` : ''}`)
  }
  return response.json()
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
  if (!address || typeof address === 'string') fail('callback server did not expose a TCP port')
  return address.port
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()))
}

const issuer = safeHttpsUrl(valueAfter('--issuer') ?? 'https://identity.beam.directory/realms/beam-mcp-pilot', '--issuer')
const identityConnectBase = safeHttpsUrl(valueAfter('--identity-connect-base') ?? 'https://identity.beam.directory', '--identity-connect-base')
const publicMcpUrl = safeHttpsUrl(valueAfter('--mcp-url') ?? 'https://mcp.beam.directory/mcp', '--mcp-url')
const mcpConnectUrl = safeHttpsUrl(valueAfter('--mcp-connect-url') ?? publicMcpUrl, '--mcp-connect-url')
const browserHostMap = valueAfter('--browser-host-map')
const clientId = valueAfter('--client-id') ?? 'beam-grok-pilot'
const username = valueAfter('--username') ?? 'pilot-operator'
const expectedTools = (valueAfter('--expected-tools') ?? 'beam_prepare_handoff,beam_status')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .sort()
const requestedScopes = (valueAfter('--scopes') ?? 'openid beam:read')
  .split(/[\s,]+/)
  .map((entry) => entry.trim())
  .filter(Boolean)
const password = readSecret(valueAfter('--password-file'), 'pilot user password')
const introspectionSecret = readSecret(valueAfter('--introspection-secret-file'), 'introspection client secret')
const outputFile = valueAfter('--output')
const realmPath = '/realms/beam-mcp-pilot'

if (issuer !== 'https://identity.beam.directory/realms/beam-mcp-pilot') fail('issuer is not the pinned pilot issuer')
if (publicMcpUrl !== 'https://mcp.beam.directory/mcp') fail('MCP resource is not the pinned public URL')
if (!/^[a-zA-Z0-9._-]{1,128}$/.test(clientId) || !/^[a-zA-Z0-9._-]{1,128}$/.test(username)) fail('client or user name is invalid')

const verifier = base64url(randomBytes(48))
const challenge = base64url(createHash('sha256').update(verifier).digest())
const state = base64url(randomBytes(24))

let callbackResolve
let callbackReject
const callbackPromise = new Promise((resolve, reject) => {
  callbackResolve = resolve
  callbackReject = reject
})
const callbackServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const returnedState = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  response.writeHead(code && returnedState === state ? 200 : 400, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(code ? 'Beam OAuth pilot authorization completed. This window can be closed.' : 'Authorization failed.')
  if (error) callbackReject(new Error(`authorization server returned ${error}`))
  else if (returnedState !== state) callbackReject(new Error('authorization callback state did not match'))
  else if (!code) callbackReject(new Error('authorization callback did not include a code'))
  else callbackResolve(code)
})

let browser
let transport
let client
try {
  const callbackPort = await listen(callbackServer)
  const redirectUri = `http://127.0.0.1:${callbackPort}/callback`
  const authorizationUrl = new URL(`${issuer}/protocol/openid-connect/auth`)
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: requestedScopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: publicMcpUrl,
  }).toString()

  const browserArgs = browserHostMap ? [`--host-resolver-rules=MAP ${browserHostMap}`] : []
  browser = await chromium.launch({ headless: true, args: browserArgs })
  const page = await browser.newPage()
  await page.goto(authorizationUrl.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  await page.locator('#kc-login').click()

  const consentButton = page.locator('button[name="accept"], input[name="accept"]')
  if (await consentButton.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
    await consentButton.first().click()
  }

  const code = await Promise.race([
    callbackPromise,
    new Promise((_, reject) => setTimeout(async () => {
      const currentPath = new URL(page.url()).pathname
      const title = await page.title().catch(() => 'unavailable')
      const controls = await page.locator('button, input[type="submit"]').evaluateAll((elements) => elements.map((element) => ({
        id: element.id || null,
        name: element.getAttribute('name'),
        text: (element.textContent || element.getAttribute('value') || '').trim().slice(0, 80),
      }))).catch(() => [])
      const headings = await page.locator('h1, h2, h3').allTextContents().catch(() => [])
      const fields = await page.locator('input:not([type="hidden"])').evaluateAll((elements) => elements.map((element) => ({
        name: element.getAttribute('name'),
        type: element.getAttribute('type') || 'text',
        required: element.required,
      }))).catch(() => [])
      reject(new Error(`authorization callback timed out on ${currentPath}; title=${JSON.stringify(title)}; headings=${JSON.stringify(headings)}; controls=${JSON.stringify(controls)}; fields=${JSON.stringify(fields)}`))
    }, 30_000)),
  ])

  const tokenEndpoint = `${identityConnectBase}${realmPath}/protocol/openid-connect/token`
  const tokenResponse = await requestJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource: publicMcpUrl,
    }),
  })
  const accessToken = tokenResponse.access_token
  if (typeof accessToken !== 'string' || !accessToken) fail('token response did not contain an access token')

  const introspectionEndpoint = `${identityConnectBase}${realmPath}/protocol/openid-connect/token/introspect`
  const introspection = await requestJson(introspectionEndpoint, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(publicMcpUrl)}:${encodeURIComponent(introspectionSecret)}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' }),
  })
  const audiences = stringArray(introspection.aud)
  const scopes = stringArray(introspection.scope)
  if (introspection.active !== true) {
    fail(`introspection did not report an active token; token=${JSON.stringify(safeTokenSummary(accessToken))}; responseFields=${JSON.stringify(Object.keys(introspection).sort())}`)
  }
  if (!audiences.includes(publicMcpUrl)) fail('access token is not audience-bound to the exact MCP URL')
  if (!scopes.includes('beam:read')) fail('access token does not include beam:read')
  if (requestedScopes.includes('beam:send') && !scopes.includes('beam:send')) fail('access token does not include requested beam:send')
  if (!requestedScopes.includes('beam:send') && scopes.includes('beam:send')) fail('access token unexpectedly includes beam:send')

  const connectUrl = new URL(mcpConnectUrl)
  const requestHeaders = connectUrl.hostname === new URL(publicMcpUrl).hostname
    ? undefined
    : { host: new URL(publicMcpUrl).hostname }
  transport = new StreamableHTTPClientTransport(connectUrl, {
    authProvider: { token: async () => accessToken },
    requestInit: requestHeaders ? { headers: requestHeaders } : undefined,
  })
  client = new Client({ name: 'beam-hosted-oauth-pkce-smoke', version: '1.0.0' })
  await client.connect(transport)
  const tools = await client.listTools()
  const toolNames = tools.tools.map((tool) => tool.name).sort()
  if (toolNames.join(',') !== expectedTools.join(',')) {
    fail(`remote MCP tool surface did not match the expected read-only tools: ${JSON.stringify({ expected: expectedTools, actual: toolNames })}`)
  }
  const statusResult = await client.callTool({ name: 'beam_status', arguments: {} })
  if (statusResult.isError === true) fail('beam_status returned an MCP error')

  const result = {
    ok: true,
    testedAt: new Date().toISOString(),
    issuer,
    mcpUrl: publicMcpUrl,
    authorizationCodeFlow: true,
    pkceMethod: 'S256',
    exactAudience: true,
    scope: scopes.filter((scope) => scope.startsWith('beam:')).sort(),
    tokenActive: true,
    tools: toolNames,
    beamSendAdvertised: toolNames.includes('beam_send'),
    statusCallSucceeded: true,
    messageSent: false,
  }
  if (outputFile) writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (transport) await transport.terminateSession().catch(() => undefined)
  if (client) await client.close().catch(() => undefined)
  if (browser) await browser.close().catch(() => undefined)
  await closeServer(callbackServer)
}
