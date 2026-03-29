import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { clearAdminSessionCookie, createAdminSessionFromMagicLink, buildAdminSessionCookie, getAdminSessionFromRequest, getAdminSessionTtlSeconds, issueAdminMagicLink, isAdminRoleConfigured, revokeAdminSession } from '../admin-auth.js'
import { logAuditEvent } from '../db.js'
import { isEmailDeliveryConfigured, sendAdminMagicLinkEmail } from '../email.js'

function isLocalDevRequest(request: Request): boolean {
  const origin = request.headers.get('origin') ?? request.url
  return origin.includes('localhost') || origin.includes('127.0.0.1')
}

export function adminAuthRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/config', (c) => {
    return c.json({
      configured: isAdminRoleConfigured(db),
      emailDelivery: isEmailDeliveryConfigured(),
      localDevMagicLinks: isLocalDevRequest(c.req.raw),
      sessionTtlSeconds: getAdminSessionTtlSeconds(),
    })
  })

  router.post('/magic-link', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { email?: string }
    const email = body.email?.trim().toLowerCase()

    if (!email || !email.includes('@')) {
      return c.json({ error: 'Valid email required', errorCode: 'INVALID_EMAIL' }, 400)
    }

    const link = issueAdminMagicLink(db, email)
    if (!link) {
      return c.json({ error: 'This email is not authorized for admin access', errorCode: 'UNAUTHORIZED' }, 403)
    }

    if (isEmailDeliveryConfigured()) {
      try {
        await sendAdminMagicLinkEmail({
          email: link.email,
          url: link.url,
          role: link.role,
        })
      } catch (error) {
        console.error('Admin magic link delivery failed:', error)
        return c.json({ error: 'Failed to send admin magic link', errorCode: 'EMAIL_DELIVERY_FAILED' }, 502)
      }
    } else if (!isLocalDevRequest(c.req.raw)) {
      return c.json({ error: 'Admin email delivery is not configured', errorCode: 'EMAIL_NOT_CONFIGURED' }, 503)
    }

    logAuditEvent(db, {
      action: 'admin.auth.challenge.issued',
      actor: link.email,
      target: link.role,
      details: {
        origin: c.req.header('origin') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      },
    })

    return c.json({
      ok: true,
      email: link.email,
      role: link.role,
      expiresAt: link.expiresAt,
      dev: !isEmailDeliveryConfigured() && isLocalDevRequest(c.req.raw),
      url: !isEmailDeliveryConfigured() && isLocalDevRequest(c.req.raw) ? link.url : undefined,
      token: !isEmailDeliveryConfigured() && isLocalDevRequest(c.req.raw) ? link.token : undefined,
    })
  })

  router.post('/verify', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { token?: string }
    const token = body.token?.trim()

    if (!token) {
      return c.json({ error: 'Token required', errorCode: 'MISSING_TOKEN' }, 400)
    }

    const result = createAdminSessionFromMagicLink(db, token)
    if (!result) {
      return c.json({ error: 'Invalid or expired token', errorCode: 'INVALID_TOKEN' }, 401)
    }

    logAuditEvent(db, {
      action: 'admin.auth.login',
      actor: result.session.email,
      target: result.session.role,
      details: {
        origin: c.req.header('origin') ?? null,
        authType: 'magic-link',
      },
    })

    c.header('Cache-Control', 'no-store')
    c.header('Set-Cookie', buildAdminSessionCookie(c, result.token, getAdminSessionTtlSeconds()))
    return c.json({
      ok: true,
      token: result.token,
      email: result.session.email,
      role: result.session.role,
      expiresAt: result.session.expiresAt,
    })
  })

  router.get('/session', (c) => {
    const session = getAdminSessionFromRequest(db, c.req.raw)
    if (!session) {
      return c.json({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }, 401)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      email: session.email,
      role: session.role,
      expiresAt: session.expiresAt,
    })
  })

  router.post('/logout', (c) => {
    const session = getAdminSessionFromRequest(db, c.req.raw)
    if (session) {
      revokeAdminSession(db, session.id)
      logAuditEvent(db, {
        action: 'admin.auth.logout',
        actor: session.email,
        target: session.role,
        details: {
          origin: c.req.header('origin') ?? null,
        },
      })
    }

    c.header('Cache-Control', 'no-store')
    c.header('Set-Cookie', clearAdminSessionCookie(c))
    return c.json({ ok: true })
  })

  return router
}
