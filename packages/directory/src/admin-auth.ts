import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { Context } from 'hono'
import { getDirectoryRole, hasWorkspaceSessionAccess } from './db.js'
import { getLocalDirectoryUrl } from './federation.js'
import type { AdminAuthScope, AdminMagicLinkRow, AdminSessionRow, DirectoryRoleRow } from './types.js'

export type AdminRole = DirectoryRoleRow['role']

type AdminSessionClaims = {
  typ: 'beam-admin'
  sid: string
  email: string
  role: AdminRole
  scope: AdminAuthScope
  exp: number
}

export type AdminSession = {
  id: string
  email: string
  role: AdminRole
  scope: AdminAuthScope
  expiresAt: string
  authType: 'cookie' | 'bearer'
}

const ADMIN_MAGIC_LINK_TTL_MS = 15 * 60 * 1000
const ADMIN_SESSION_TTL_MS = Math.max(
  15 * 60 * 1000,
  (Number.parseInt(process.env['BEAM_ADMIN_SESSION_TTL_HOURS'] ?? '168', 10) || 168) * 60 * 60 * 1000,
)
export const ADMIN_SESSION_COOKIE = 'beam_admin_session'

const ROLE_ORDER: Record<AdminRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
}

function getJwtSecret(): string {
  const secret = process.env['JWT_SECRET']
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required')
  }

  return secret
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function hashMagicLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function parseEmailList(value: string | undefined): Set<string> {
  if (!value) {
    return new Set()
  }

  return new Set(
    value
      .split(',')
      .map((entry) => normalizeEmail(entry))
      .filter(Boolean),
  )
}

function createSessionJwt(claims: AdminSessionClaims): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', getJwtSecret())
    .update(`${header}.${payload}`)
    .digest('base64url')

  return `${header}.${payload}.${signature}`
}

function verifySessionJwt(token: string): AdminSessionClaims | null {
  try {
    const [header, payload, signature] = token.split('.')
    if (!header || !payload || !signature) {
      return null
    }

    const expectedSignature = createHmac('sha256', getJwtSecret())
      .update(`${header}.${payload}`)
      .digest('base64url')

    const signatureBuffer = Buffer.from(signature)
    const expectedSignatureBuffer = Buffer.from(expectedSignature)
    if (signatureBuffer.length !== expectedSignatureBuffer.length || !timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) {
      return null
    }

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<AdminSessionClaims>
    if (claims.typ !== 'beam-admin' || !claims.sid || !claims.email || !claims.role || !claims.exp) {
      return null
    }

    if (claims.exp <= Date.now()) {
      return null
    }

    if (!(claims.role in ROLE_ORDER)) {
      return null
    }

    const scope = claims.scope ?? 'platform'
    if (scope !== 'platform' && scope !== 'workspace') {
      return null
    }

    return { ...claims, scope } as AdminSessionClaims
  } catch {
    return null
  }
}

function parseCookieHeader(cookieHeader: string | null | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {}
  }

  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, part) => {
      const index = part.indexOf('=')
      if (index <= 0) {
        return cookies
      }

      const key = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim()
      cookies[key] = value
      return cookies
    }, {})
}

function getRequestOrigin(c: Context): string {
  return c.req.header('origin') ?? c.req.header('referer') ?? c.req.url
}

function shouldUseCrossSiteCookie(c: Context): boolean {
  const origin = getRequestOrigin(c)
  return origin.startsWith('https://') && !origin.includes('localhost') && !origin.includes('127.0.0.1')
}

function getDashboardUrl(): string {
  return (process.env['BEAM_DASHBOARD_URL'] ?? process.env['APP_URL'] ?? 'https://dashboard.beam.directory').replace(/\/$/, '')
}

function normalizeReturnTo(value: string | null | undefined): string | null {
  const candidate = value?.trim()
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return null
  }

  try {
    const parsed = new URL(candidate, 'https://dashboard.beam.directory')
    if (parsed.origin !== 'https://dashboard.beam.directory' || parsed.pathname !== '/workspace-invite') {
      return null
    }
    const token = parsed.searchParams.get('token')?.trim()
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return null
    }
    return `/workspace-invite?token=${encodeURIComponent(token)}`
  } catch {
    return null
  }
}

function getConfiguredRoleForEmail(email: string): AdminRole | null {
  const normalizedEmail = normalizeEmail(email)
  if (parseEmailList(process.env['BEAM_ADMIN_EMAILS']).has(normalizedEmail)) {
    return 'admin'
  }

  if (parseEmailList(process.env['BEAM_OPERATOR_EMAILS']).has(normalizedEmail)) {
    return 'operator'
  }

  if (parseEmailList(process.env['BEAM_VIEWER_EMAILS']).has(normalizedEmail)) {
    return 'viewer'
  }

  return null
}

export function resolveAdminRole(db: Database, email: string): AdminRole | null {
  const normalizedEmail = normalizeEmail(email)
  const databaseRole = getDirectoryRole(db, normalizedEmail, getLocalDirectoryUrl())?.role
  return databaseRole ?? getConfiguredRoleForEmail(normalizedEmail)
}

export function isAdminRoleConfigured(db: Database): boolean {
  const configured = (
    parseEmailList(process.env['BEAM_ADMIN_EMAILS']).size +
    parseEmailList(process.env['BEAM_OPERATOR_EMAILS']).size +
    parseEmailList(process.env['BEAM_VIEWER_EMAILS']).size
  ) > 0

  if (configured) {
    return true
  }

  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM directory_roles
    WHERE directory_url = ?
  `).get(getLocalDirectoryUrl()) as { count: number } | undefined

  return (row?.count ?? 0) > 0
}

export function roleSatisfies(actual: AdminRole, required: AdminRole): boolean {
  return ROLE_ORDER[actual] >= ROLE_ORDER[required]
}

export function issueAdminMagicLink(db: Database, email: string, returnTo?: string | null): {
  email: string
  role: AdminRole
  scope: AdminAuthScope
  token: string
  url: string
  expiresAt: string
} | null {
  const normalizedEmail = normalizeEmail(email)
  const platformRole = resolveAdminRole(db, normalizedEmail)
  const scope: AdminAuthScope = platformRole ? 'platform' : 'workspace'
  const role: AdminRole | null = platformRole ?? (hasWorkspaceSessionAccess(db, normalizedEmail) ? 'viewer' : null)
  if (!role) {
    return null
  }

  const token = randomBytes(32).toString('hex')
  const tokenHash = hashMagicLinkToken(token)
  const expiresAt = new Date(Date.now() + ADMIN_MAGIC_LINK_TTL_MS).toISOString()
  const createdAt = new Date().toISOString()

  const safeReturnTo = normalizeReturnTo(returnTo)
  db.prepare(`
    INSERT INTO admin_magic_links (token, email, role, auth_scope, return_to, created_at, expires_at, used)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(tokenHash, normalizedEmail, role, scope, safeReturnTo, createdAt, expiresAt)

  db.prepare(`
    DELETE FROM admin_magic_links
    WHERE expires_at <= ? OR used = 1
  `).run(createdAt)

  const url = `${getDashboardUrl()}/auth/callback?token=${token}`

  return {
    email: normalizedEmail,
    role,
    scope,
    token,
    url,
    expiresAt,
  }
}

function consumeMagicLink(db: Database, token: string): { email: string; role: AdminRole; scope: AdminAuthScope; returnTo: string | null } | null {
  const tokenHash = hashMagicLinkToken(token)
  const row = db.prepare(`
    SELECT *
    FROM admin_magic_links
    WHERE token IN (?, ?) AND used = 0 AND expires_at > ?
  `).get(tokenHash, token, new Date().toISOString()) as AdminMagicLinkRow | undefined

  if (!row) {
    return null
  }

  db.prepare('UPDATE admin_magic_links SET used = 1 WHERE token = ?').run(row.token)
  return {
    email: row.email,
    role: row.role,
    scope: row.auth_scope,
    returnTo: row.return_to,
  }
}

export function createAdminSession(
  db: Database,
  input: { email: string; role: AdminRole; scope?: AdminAuthScope },
): { token: string; session: AdminSession } {
  const id = randomUUID()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS).toISOString()
  const timestamp = now.toISOString()

  const scope = input.scope ?? 'platform'
  db.prepare(`
    INSERT INTO admin_sessions (id, email, role, auth_scope, created_at, last_seen_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(id, normalizeEmail(input.email), input.role, scope, timestamp, timestamp, expiresAt)

  const token = createSessionJwt({
    typ: 'beam-admin',
    sid: id,
    email: normalizeEmail(input.email),
    role: input.role,
    scope,
    exp: Date.parse(expiresAt),
  })

  return {
    token,
    session: {
      id,
      email: normalizeEmail(input.email),
      role: input.role,
      scope,
      expiresAt,
      authType: 'bearer',
    },
  }
}

export function createAdminSessionFromMagicLink(
  db: Database,
  token: string,
): { token: string; session: AdminSession; returnTo: string | null } | null {
  const link = consumeMagicLink(db, token)
  if (!link) {
    return null
  }

  const effectiveRole = link.scope === 'platform'
    ? resolveAdminRole(db, link.email)
    : (hasWorkspaceSessionAccess(db, link.email) ? 'viewer' : null)
  if (!effectiveRole) return null

  const session = createAdminSession(db, {
    email: link.email,
    role: effectiveRole,
    scope: link.scope,
  })
  return { ...session, returnTo: link.returnTo }
}

export function revokeAdminSession(db: Database, sessionId: string): void {
  db.prepare(`
    UPDATE admin_sessions
    SET revoked_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(new Date().toISOString(), sessionId)
}

function getAdminTokenFromRequest(request: Request): { token: string; authType: 'cookie' | 'bearer' } | null {
  const authorization = request.headers.get('authorization') ?? ''
  if (authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim()
    if (token) {
      return { token, authType: 'bearer' }
    }
  }

  const cookies = parseCookieHeader(request.headers.get('cookie'))
  const cookieToken = cookies[ADMIN_SESSION_COOKIE]
  if (cookieToken) {
    return { token: cookieToken, authType: 'cookie' }
  }

  return null
}

export function getAdminSessionFromRequest(db: Database, request: Request): AdminSession | null {
  const token = getAdminTokenFromRequest(request)
  if (!token) {
    return null
  }

  const claims = verifySessionJwt(token.token)
  if (!claims) {
    return null
  }

  const sessionRow = db.prepare(`
    SELECT *
    FROM admin_sessions
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(claims.sid, new Date().toISOString()) as AdminSessionRow | undefined

  if (!sessionRow) {
    return null
  }

  const effectiveRole = claims.scope === 'platform'
    ? resolveAdminRole(db, claims.email)
    : (hasWorkspaceSessionAccess(db, claims.email) ? 'viewer' : null)
  if (
    !effectiveRole
    || effectiveRole !== claims.role
    || sessionRow.email !== claims.email
    || sessionRow.role !== claims.role
    || sessionRow.auth_scope !== claims.scope
  ) {
    revokeAdminSession(db, claims.sid)
    return null
  }

  db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), claims.sid)

  return {
    id: sessionRow.id,
    email: sessionRow.email,
    role: sessionRow.role,
    scope: sessionRow.auth_scope,
    expiresAt: sessionRow.expires_at,
    authType: token.authType,
  }
}

export function requireAdminRole(
  db: Database,
  request: Request,
  requiredRole: AdminRole,
): { ok: true; session: AdminSession } | Response {
  const session = getAdminSessionFromRequest(db, request)
  if (!session) {
    if (!isAdminRoleConfigured(db)) {
      return new Response(JSON.stringify({ error: 'Admin access is not configured', errorCode: 'ADMIN_UNAVAILABLE' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (!roleSatisfies(session.role, requiredRole)) {
    return new Response(JSON.stringify({ error: 'Forbidden', errorCode: 'FORBIDDEN' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (session.scope !== 'platform') {
    return new Response(JSON.stringify({ error: 'Platform role required', errorCode: 'PLATFORM_ROLE_REQUIRED' }), {
      status: 403,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  return { ok: true, session }
}

export function requireAdminSession(
  db: Database,
  request: Request,
): { ok: true; session: AdminSession } | Response {
  const session = getAdminSessionFromRequest(db, request)
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  return { ok: true, session }
}

export function buildAdminSessionCookie(c: Context, token: string, maxAgeSeconds: number): string {
  const cookieParts = [
    `${ADMIN_SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSeconds}`,
    shouldUseCrossSiteCookie(c) ? 'SameSite=None' : 'SameSite=Lax',
  ]

  if (shouldUseCrossSiteCookie(c)) {
    cookieParts.push('Secure')
  }

  return cookieParts.join('; ')
}

export function clearAdminSessionCookie(c: Context): string {
  const cookieParts = [
    `${ADMIN_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    shouldUseCrossSiteCookie(c) ? 'SameSite=None' : 'SameSite=Lax',
  ]

  if (shouldUseCrossSiteCookie(c)) {
    cookieParts.push('Secure')
  }

  return cookieParts.join('; ')
}

export function getAdminSessionTtlSeconds(): number {
  return Math.floor(ADMIN_SESSION_TTL_MS / 1000)
}
