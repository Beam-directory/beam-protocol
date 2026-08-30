import { requiredSecret } from './secret-file.js'

export type BeamMcpHttpConfig = {
  host: string
  port: number
  publicUrl: URL
  allowedHostnames: string[]
  allowedOriginHostnames: string[]
  enableNetwork: boolean
  enableSend: boolean
  oauth: {
    issuer: URL
    metadataUrl: URL
    introspectionUrl: URL
    clientId: string
    clientSecret: string
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required for HTTP transport`)
  return value
}

function parseUrl(value: string, name: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute URL`)
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${name} must not contain credentials or a fragment`)
  }
  return url
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function assertSecureUrl(url: URL, name: string, allowInsecure: boolean): void {
  if (url.protocol === 'https:') return
  if (allowInsecure && url.protocol === 'http:' && isLoopback(url.hostname)) return
  throw new Error(`${name} must use HTTPS (loopback HTTP requires BEAM_MCP_DANGEROUSLY_ALLOW_INSECURE_OAUTH=true)`)
}

function parseHostnameList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry) => !entry.includes('/') && !entry.includes(':'))
}

function parseBooleanFlag(value: string | undefined, name: string, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`${name} must be true or false`)
}

export function loadBeamMcpHttpConfig(env: NodeJS.ProcessEnv = process.env): BeamMcpHttpConfig {
  const allowInsecure = env['BEAM_MCP_DANGEROUSLY_ALLOW_INSECURE_OAUTH']?.trim().toLowerCase() === 'true'
  const publicUrl = parseUrl(required(env, 'BEAM_MCP_PUBLIC_URL'), 'BEAM_MCP_PUBLIC_URL')
  const issuer = parseUrl(required(env, 'BEAM_MCP_OAUTH_ISSUER'), 'BEAM_MCP_OAUTH_ISSUER')
  const metadataUrl = parseUrl(required(env, 'BEAM_MCP_OAUTH_METADATA_URL'), 'BEAM_MCP_OAUTH_METADATA_URL')
  const introspectionUrl = parseUrl(required(env, 'BEAM_MCP_OAUTH_INTROSPECTION_URL'), 'BEAM_MCP_OAUTH_INTROSPECTION_URL')

  assertSecureUrl(publicUrl, 'BEAM_MCP_PUBLIC_URL', allowInsecure)
  assertSecureUrl(issuer, 'BEAM_MCP_OAUTH_ISSUER', allowInsecure)
  assertSecureUrl(metadataUrl, 'BEAM_MCP_OAUTH_METADATA_URL', allowInsecure)
  assertSecureUrl(introspectionUrl, 'BEAM_MCP_OAUTH_INTROSPECTION_URL', allowInsecure)

  if (publicUrl.search || publicUrl.pathname === '/' || publicUrl.pathname.endsWith('/')) {
    throw new Error('BEAM_MCP_PUBLIC_URL must include the exact MCP path without a query or trailing slash (for example https://mcp.example.com/mcp)')
  }
  if (issuer.search) throw new Error('BEAM_MCP_OAUTH_ISSUER must not contain a query')

  const parsedPort = Number.parseInt(env['BEAM_MCP_HTTP_PORT'] ?? '3333', 10)
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
    throw new Error('BEAM_MCP_HTTP_PORT must be an integer between 1 and 65535')
  }

  const publicHostname = publicUrl.hostname.toLowerCase()
  const allowedHostnames = [...new Set([publicHostname, ...parseHostnameList(env['BEAM_MCP_ALLOWED_HOSTS'])])]
  const allowedOriginHostnames = [...new Set([publicHostname, ...parseHostnameList(env['BEAM_MCP_ALLOWED_ORIGIN_HOSTS'])])]

  return {
    host: env['BEAM_MCP_HTTP_HOST']?.trim() || '127.0.0.1',
    port: parsedPort,
    publicUrl,
    allowedHostnames,
    allowedOriginHostnames,
    enableNetwork: parseBooleanFlag(env['BEAM_MCP_ENABLE_NETWORK'], 'BEAM_MCP_ENABLE_NETWORK', false),
    enableSend: parseBooleanFlag(env['BEAM_MCP_ENABLE_SEND'], 'BEAM_MCP_ENABLE_SEND', false),
    oauth: {
      issuer,
      metadataUrl,
      introspectionUrl,
      clientId: required(env, 'BEAM_MCP_OAUTH_CLIENT_ID'),
      clientSecret: requiredSecret(env, 'BEAM_MCP_OAUTH_CLIENT_SECRET'),
    },
  }
}
