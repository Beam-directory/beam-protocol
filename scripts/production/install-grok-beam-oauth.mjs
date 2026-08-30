#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const ISSUER = 'https://identity.beam.directory/realms/beam-mcp-pilot'
const IDENTITY_BASE = 'https://identity.beam.directory'
const MCP_URL = 'https://mcp.beam.directory/mcp'
const CLIENT_ID = 'beam-grok-pilot'
const SERVER_NAME = 'beam'
const CALLBACK_PORT = 35419
const REQUESTED_SCOPES = ['beam:read', 'beam:send', 'offline_access']

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  throw new Error(message)
}

function readSecret(file, name) {
  if (!file) fail(`${name} file is required`)
  const value = readFileSync(file, 'utf8').trim()
  if (!value) fail(`${name} file is empty`)
  return value
}

function stringArray(value) {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string')
  return []
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    const oauthError = await response.json().catch(() => null)
    const safeDetail = oauthError && typeof oauthError === 'object'
      ? { error: oauthError.error, error_description: oauthError.error_description }
      : null
    const path = new URL(url).pathname
    throw new Error(`${options.method ?? 'GET'} ${path} returned HTTP ${response.status}${safeDetail ? ` ${JSON.stringify(safeDetail)}` : ''}`)
  }
  return response.json()
}

function readCredentialStore(file) {
  if (!existsSync(file)) return {}
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Grok credential store must be a regular non-symlink file')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Grok credential store is not a JSON object')
  return parsed
}

function writeOwnerOnlyAtomic(file, value) {
  const tempFile = join(dirname(file), `.mcp_credentials.json.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  let fd
  try {
    fd = openSync(tempFile, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    chmodSync(tempFile, 0o600)
    renameSync(tempFile, file)
    chmodSync(file, 0o600)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(tempFile)) unlinkSync(tempFile)
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()))
}

const username = valueAfter('--username') ?? 'pilot-operator'
const password = readSecret(valueAfter('--password-file'), 'pilot user password')
const introspectionSecret = readSecret(valueAfter('--introspection-secret-file'), 'introspection client secret')
const credentialFile = valueAfter('--credential-file') ?? join(homedir(), '.grok', 'mcp_credentials.json')

if (!/^[a-zA-Z0-9._-]{1,128}$/.test(username)) fail('pilot username is invalid')
if (credentialFile !== join(homedir(), '.grok', 'mcp_credentials.json')) {
  fail('credential file is not the pinned Grok credential store')
}

const verifier = randomBytes(48).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const state = randomBytes(24).toString('base64url')
const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}/callback`

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
  response.end(code ? 'Beam OAuth authorization completed. This window can be closed.' : 'Authorization failed.')
  if (error) callbackReject(new Error(`authorization server returned ${error}`))
  else if (returnedState !== state) callbackReject(new Error('authorization callback state did not match'))
  else if (!code) callbackReject(new Error('authorization callback did not include a code'))
  else callbackResolve(code)
})

let browser
try {
  await listen(callbackServer)
  const authorizationUrl = new URL(`${ISSUER}/protocol/openid-connect/auth`)
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: REQUESTED_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: MCP_URL,
  }).toString()

  browser = await chromium.launch({ headless: true })
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('authorization callback timed out')), 30_000)),
  ])
  const tokenResponse = await requestJson(`${IDENTITY_BASE}/realms/beam-mcp-pilot/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource: MCP_URL,
    }),
  })
  if (typeof tokenResponse.access_token !== 'string' || !tokenResponse.access_token) fail('token response did not contain an access token')
  if (typeof tokenResponse.refresh_token !== 'string' || !tokenResponse.refresh_token) fail('token response did not contain a refresh token')

  const introspection = await requestJson(`${IDENTITY_BASE}/realms/beam-mcp-pilot/protocol/openid-connect/token/introspect`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(MCP_URL)}:${encodeURIComponent(introspectionSecret)}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ token: tokenResponse.access_token, token_type_hint: 'access_token' }),
  })
  const audiences = stringArray(introspection.aud)
  const grantedScopes = stringArray(introspection.scope)
  if (introspection.active !== true) fail('introspection did not report an active token')
  if (!audiences.includes(MCP_URL)) fail('access token is not audience-bound to the exact Beam MCP URL')
  for (const scope of REQUESTED_SCOPES) {
    if (!grantedScopes.includes(scope)) fail(`access token does not include ${scope}`)
  }

  const store = readCredentialStore(credentialFile)
  store[`${SERVER_NAME}:${MCP_URL}`] = {
    client_id: CLIENT_ID,
    token_response: tokenResponse,
    granted_scopes: grantedScopes,
    token_received_at: Math.floor(Date.now() / 1000),
  }
  writeOwnerOnlyAtomic(credentialFile, store)

  console.log(JSON.stringify({
    ok: true,
    credentialInstalled: true,
    server: SERVER_NAME,
    resource: MCP_URL,
    clientId: CLIENT_ID,
    redirectUri,
    pkceMethod: 'S256',
    scope: grantedScopes.filter((scope) => scope.startsWith('beam:') || scope === 'offline_access').sort(),
    refreshTokenStored: true,
    tokenExpiresIn: tokenResponse.expires_in,
    messageSent: false,
  }, null, 2))
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await closeServer(callbackServer)
}
