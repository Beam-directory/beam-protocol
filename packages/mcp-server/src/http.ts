import { createServer, type Server as HttpServer } from 'node:http'
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  oauthMetadataResponse,
  originValidationResponse,
  requireBearerAuth,
  type McpHttpHandler,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { BeamIdString, VerificationTier } from 'beam-protocol-sdk'
import { createBeamClient, loadBeamMcpConfig } from './config.js'
import { loadBeamMcpHttpConfig, type BeamMcpHttpConfig } from './http-config.js'
import { createBeamNetworkGateway, type BeamNetworkGateway } from './network-client.js'
import { IntrospectionTokenVerifier, loadOAuthAuthorizationServerMetadata } from './oauth.js'
import { createBeamMcpServer, type BeamMcpAuditEvent } from './server.js'
import type { BeamGateway } from './tools.js'

const MAX_MCP_REQUEST_BYTES = 1024 * 1024
const HTTP_REQUEST_TIMEOUT_MS = 30_000
const HTTP_HEADERS_TIMEOUT_MS = 15_000
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000
const HTTP_MAX_HEADERS = 100
const HTTP_MAX_REQUESTS_PER_SOCKET = 1_000

export type BeamMcpRemoteAuditRecord = {
  timestamp: string
  component: 'beam-mcp-http'
  event: 'mcp_tool_call'
  principal: {
    clientId: string
    subject?: string
    tenant?: string
  }
  tool: BeamMcpAuditEvent['tool']
  outcome: BeamMcpAuditEvent['outcome']
  target?: string
  intent?: string
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  headers.set('referrer-policy', 'no-referrer')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('x-frame-options', 'DENY')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function boundedAuditClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 255) : undefined
}

function createAuditRecord(
  authInfo: { clientId?: string; extra?: Record<string, unknown> } | undefined,
  event: BeamMcpAuditEvent,
): BeamMcpRemoteAuditRecord {
  return {
    timestamp: new Date().toISOString(),
    component: 'beam-mcp-http',
    event: 'mcp_tool_call',
    principal: {
      clientId: boundedAuditClaim(authInfo?.clientId) ?? 'unknown',
      subject: boundedAuditClaim(authInfo?.extra?.['subject']),
      tenant: boundedAuditClaim(authInfo?.extra?.['tenant']),
    },
    tool: event.tool,
    outcome: event.outcome,
    ...(event.target ? { target: event.target } : {}),
    ...(event.intent ? { intent: event.intent } : {}),
  }
}

function writeAuditEvent(record: BeamMcpRemoteAuditRecord): void {
  process.stderr.write(`${JSON.stringify(record)}\n`)
}

export function hardenBeamMcpHttpServer(server: HttpServer): void {
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS
  server.maxHeadersCount = HTTP_MAX_HEADERS
  server.maxRequestsPerSocket = HTTP_MAX_REQUESTS_PER_SOCKET
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
}

async function boundedRequest(request: Request): Promise<Request | Response> {
  if (request.method !== 'POST') return request
  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (Number.isFinite(declared) && declared > MAX_MCP_REQUEST_BYTES) {
    return jsonResponse(413, { error: 'MCP request exceeds 1 MiB', errorCode: 'REQUEST_TOO_LARGE' })
  }
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_MCP_REQUEST_BYTES) {
    return jsonResponse(413, { error: 'MCP request exceeds 1 MiB', errorCode: 'REQUEST_TOO_LARGE' })
  }
  return new Request(request, { body: bytes })
}

export function createBeamMcpHttpHandler(options: {
  config: BeamMcpHttpConfig
  oauthMetadata: OAuthMetadata
  verifier: OAuthTokenVerifier
  gateway: BeamGateway
  networkGateway?: BeamNetworkGateway
  ownBeamId: BeamIdString
  allowedIntents: ReadonlySet<string>
  requireVerifiedTarget: boolean
  minimumVerificationTier: VerificationTier
  minimumTrustScore: number
  auditSink?: (record: BeamMcpRemoteAuditRecord) => void
}): McpHttpHandler {
  const requiredScopes = options.config.enableSend ? ['beam:read', 'beam:send'] : ['beam:read']
  const metadataOptions = {
    oauthMetadata: options.oauthMetadata,
    resourceServerUrl: options.config.publicUrl,
    serviceDocumentationUrl: new URL('https://docs.beam.directory/guide/trust-assurance'),
    scopesSupported: requiredScopes,
    resourceName: 'Beam trusted agent handoffs',
    dangerouslyAllowInsecureIssuerUrl: options.config.oauth.issuer.protocol === 'http:',
  }
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(options.config.publicUrl)
  const requireAuth = requireBearerAuth({
    verifier: options.verifier,
    requiredScopes,
    resourceMetadataUrl,
  })
  const mcp = createMcpHandler((context) => createBeamMcpServer({
    gateway: options.gateway,
    networkGateway: options.config.enableNetwork ? options.networkGateway : undefined,
    ownBeamId: options.ownBeamId,
    allowedIntents: options.allowedIntents,
    requireVerifiedTarget: options.requireVerifiedTarget,
    minimumVerificationTier: options.minimumVerificationTier,
    minimumTrustScore: options.minimumTrustScore,
    authorizationScopes: new Set(context.authInfo?.scopes ?? []),
    enableSend: options.config.enableSend,
    audit: (event) => {
      const record = createAuditRecord(context.authInfo, event)
      if (options.auditSink) options.auditSink(record)
      else writeAuditEvent(record)
    },
  }), {
    responseMode: 'auto',
    onerror: (error) => {
      process.stderr.write(`[beam-mcp-http] protocol error: ${error.message}\n`)
    },
  })

  return {
    bus: mcp.bus,
    notify: mcp.notify,
    close: () => mcp.close(),
    fetch: async (request) => withSecurityHeaders(await (async () => {
      const hostRejected = hostHeaderValidationResponse(request, options.config.allowedHostnames)
      if (hostRejected) return hostRejected
      const originRejected = originValidationResponse(request, options.config.allowedOriginHostnames)
      if (originRejected) return originRejected

      const metadata = oauthMetadataResponse(request, metadataOptions)
      if (metadata) return metadata

      const url = new URL(request.url)
      if (url.pathname === '/health' && request.method === 'GET') {
        return jsonResponse(200, { status: 'ok', transport: 'streamable-http', oauth: true })
      }
      if (url.pathname !== options.config.publicUrl.pathname) {
        return jsonResponse(404, { error: 'Not found', errorCode: 'NOT_FOUND' })
      }

      const auth = await requireAuth(request)
      if (auth instanceof Response) return auth
      const bounded = await boundedRequest(request)
      if (bounded instanceof Response) return bounded
      return mcp.fetch(bounded, { authInfo: auth })
    })()),
  }
}

export async function startBeamMcpHttpServer(): Promise<{ server: HttpServer; close: () => Promise<void> }> {
  const beamConfig = loadBeamMcpConfig()
  const httpConfig = loadBeamMcpHttpConfig()
  const oauthMetadata = await loadOAuthAuthorizationServerMetadata({
    issuer: httpConfig.oauth.issuer,
    metadataUrl: httpConfig.oauth.metadataUrl,
    introspectionUrl: httpConfig.oauth.introspectionUrl,
  })
  const client = createBeamClient(beamConfig)
  const handler = createBeamMcpHttpHandler({
    config: httpConfig,
    oauthMetadata,
    verifier: new IntrospectionTokenVerifier({
      introspectionUrl: httpConfig.oauth.introspectionUrl,
      clientId: httpConfig.oauth.clientId,
      clientSecret: httpConfig.oauth.clientSecret,
      resource: httpConfig.publicUrl,
    }),
    gateway: {
      getStats: () => client.getStats(),
      lookup: (beamId) => client.directory.lookup(beamId),
      send: (to, intent, payload, timeoutMs) => client.send(to, intent, payload, timeoutMs),
    },
    networkGateway: httpConfig.enableNetwork ? createBeamNetworkGateway(beamConfig) : undefined,
    ownBeamId: beamConfig.beamId,
    allowedIntents: beamConfig.allowedIntents,
    requireVerifiedTarget: beamConfig.requireVerifiedTarget,
    minimumVerificationTier: beamConfig.minimumVerificationTier,
    minimumTrustScore: beamConfig.minimumTrustScore,
  })
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => process.stderr.write(`[beam-mcp-http] adapter error: ${error.message}\n`),
  })
  const server = createServer((request, response) => {
    void nodeHandler(request, response)
  })
  hardenBeamMcpHttpServer(server)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(httpConfig.port, httpConfig.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  process.stderr.write(`[beam-mcp-http] listening at ${httpConfig.publicUrl.href}\n`)

  return {
    server,
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
