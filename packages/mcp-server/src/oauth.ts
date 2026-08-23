import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server'

type FetchLike = typeof fetch

async function readBoundedJson(response: Response, maxBytes = 65_536): Promise<Record<string, unknown>> {
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('OAuth response exceeded the maximum size')
  }
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OAuth response must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function parseHttpsEndpoint(value: unknown, name: string, issuer: URL): URL {
  if (typeof value !== 'string') throw new Error(`OAuth metadata is missing ${name}`)
  const endpoint = new URL(value)
  const localInsecure = issuer.protocol === 'http:' && (issuer.hostname === 'localhost' || issuer.hostname === '127.0.0.1' || issuer.hostname === '[::1]')
  if (endpoint.protocol !== 'https:' && !(localInsecure && endpoint.protocol === 'http:')) {
    throw new Error(`OAuth metadata ${name} must use HTTPS`)
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error(`OAuth metadata ${name} must not contain credentials or a fragment`)
  }
  return endpoint
}

export async function loadOAuthAuthorizationServerMetadata(
  input: { issuer: URL; metadataUrl: URL; introspectionUrl: URL },
  fetcher: FetchLike = fetch,
): Promise<OAuthMetadata> {
  const response = await fetcher(input.metadataUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`OAuth metadata request failed with ${response.status}`)
  const metadata = await readBoundedJson(response)
  if (metadata['issuer'] !== input.issuer.href.replace(/\/$/, '')) {
    throw new Error('OAuth metadata issuer does not match BEAM_MCP_OAUTH_ISSUER')
  }

  parseHttpsEndpoint(metadata['authorization_endpoint'], 'authorization_endpoint', input.issuer)
  parseHttpsEndpoint(metadata['token_endpoint'], 'token_endpoint', input.issuer)
  const introspectionEndpoint = parseHttpsEndpoint(metadata['introspection_endpoint'], 'introspection_endpoint', input.issuer)
  if (introspectionEndpoint.href !== input.introspectionUrl.href) {
    throw new Error('OAuth metadata introspection_endpoint does not match BEAM_MCP_OAUTH_INTROSPECTION_URL')
  }
  const responseTypes = Array.isArray(metadata['response_types_supported']) ? metadata['response_types_supported'] : []
  if (!responseTypes.includes('code')) throw new Error('OAuth authorization server must support the authorization code flow')
  const pkceMethods = Array.isArray(metadata['code_challenge_methods_supported']) ? metadata['code_challenge_methods_supported'] : []
  if (!pkceMethods.includes('S256')) throw new Error('OAuth authorization server must advertise PKCE S256 support')

  return metadata as OAuthMetadata
}

function stringArray(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/).map((item) => item.trim()).filter(Boolean)
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

function boundedStringClaim(value: unknown, maxLength = 255): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined
}

function normalizeResource(value: string): string {
  const url = new URL(value)
  url.hash = ''
  return url.href.replace(/\/$/, '')
}

export class IntrospectionTokenVerifier implements OAuthTokenVerifier {
  readonly #introspectionUrl: URL
  readonly #clientId: string
  readonly #clientSecret: string
  readonly #resource: URL
  readonly #fetcher: FetchLike

  constructor(input: {
    introspectionUrl: URL
    clientId: string
    clientSecret: string
    resource: URL
    fetcher?: FetchLike
  }) {
    this.#introspectionUrl = input.introspectionUrl
    this.#clientId = input.clientId
    this.#clientSecret = input.clientSecret
    this.#resource = input.resource
    this.#fetcher = input.fetcher ?? fetch
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!token || token.length > 8_192 || /[\r\n]/.test(token)) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is malformed')
    }

    let payload: Record<string, unknown>
    try {
      const credentials = Buffer.from(`${encodeURIComponent(this.#clientId)}:${encodeURIComponent(this.#clientSecret)}`).toString('base64')
      const response = await this.#fetcher(this.#introspectionUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) {
        throw new Error(`Token introspection failed with ${response.status}`)
      }
      payload = await readBoundedJson(response)
    } catch (error) {
      if (OAuthError.isInstance(error)) throw error
      throw new OAuthError(OAuthErrorCode.ServerError, 'Authorization server could not validate the access token')
    }

    const expiresAt = typeof payload['exp'] === 'number' ? Math.trunc(payload['exp']) : null
    const clientId = boundedStringClaim(payload['client_id'])
    const scopes = stringArray(payload['scope'])
    const audiences = [...stringArray(payload['aud']), ...stringArray(payload['resource'])]
    const expectedResource = normalizeResource(this.#resource.href)

    if (
      payload['active'] !== true
      || !expiresAt
      || expiresAt <= Math.floor(Date.now() / 1_000)
      || !clientId
      || scopes.length > 64
      || scopes.some((scope) => scope.length === 0 || scope.length > 128)
      || !audiences.some((audience) => {
        try { return normalizeResource(audience) === expectedResource } catch { return false }
      })
    ) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token is inactive, expired, or was issued for a different resource')
    }

    return {
      token,
      clientId,
      scopes,
      expiresAt,
      resource: new URL(expectedResource),
      extra: {
        subject: boundedStringClaim(payload['sub']),
        tenant: boundedStringClaim(payload['tenant']),
      },
    }
  }
}
