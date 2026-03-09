import { Hono } from 'hono'
import { issueBusinessVC, issueDomainVC, issueEmailVC, verifyCredential, type VerifiableCredential } from '../credentials.js'

export function credentialsRouter(): Hono {
  const router = new Hono()

  router.post('/email', async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    const beamId = String(body?.['beamId'] ?? '').trim()
    const email = String(body?.['email'] ?? '').trim()

    if (!beamId || !email) {
      return c.json({ error: 'beamId and email are required', errorCode: 'INVALID_REQUEST' }, 400)
    }

    return c.json(issueEmailVC(beamId, email), 201)
  })

  router.post('/domain', async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    const beamId = String(body?.['beamId'] ?? '').trim()
    const domain = String(body?.['domain'] ?? '').trim()

    if (!beamId || !domain) {
      return c.json({ error: 'beamId and domain are required', errorCode: 'INVALID_REQUEST' }, 400)
    }

    return c.json(issueDomainVC(beamId, domain), 201)
  })

  router.post('/business', async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null
    const beamId = String(body?.['beamId'] ?? '').trim()
    const businessInfo = body?.['businessInfo']

    if (!beamId || !businessInfo || typeof businessInfo !== 'object' || Array.isArray(businessInfo)) {
      return c.json({ error: 'beamId and businessInfo are required', errorCode: 'INVALID_REQUEST' }, 400)
    }

    return c.json(issueBusinessVC(beamId, businessInfo as Record<string, unknown>), 201)
  })

  router.post('/verify', async (c) => {
    const body = await c.req.json().catch(() => null) as { vc?: VerifiableCredential } | null
    if (!body?.vc) {
      return c.json({ error: 'vc is required', errorCode: 'INVALID_REQUEST' }, 400)
    }

    return c.json({ valid: verifyCredential(body.vc) })
  })

  return router
}
