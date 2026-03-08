import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import type { OrganizationRow } from '../types.js'
import { getOrganization, listOrganizations, registerOrganization } from '../db.js'

function serializeOrganization(row: OrganizationRow): object {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    verified: row.verified === 1,
    createdAt: row.created_at,
    contactEmail: row.contact_email,
  }
}

export function orgsRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/register', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : ''
    const displayName = typeof raw['displayName'] === 'string' ? raw['displayName'].trim() : ''
    const contactEmail = typeof raw['contactEmail'] === 'string' ? raw['contactEmail'].trim() : null

    if (!name) {
      return c.json({ error: 'name must be a non-empty string', errorCode: 'INVALID_NAME' }, 400)
    }
    if (!displayName) {
      return c.json({ error: 'displayName must be a non-empty string', errorCode: 'INVALID_DISPLAY_NAME' }, 400)
    }

    try {
      const organization = registerOrganization(db, { name, displayName, contactEmail })
      return c.json(serializeOrganization(organization), 201)
    } catch (err) {
      console.error('Organization registration error:', err)
      return c.json({ error: 'Failed to register organization', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/', (c) => {
    try {
      const organizations = listOrganizations(db)
      return c.json({ organizations: organizations.map(serializeOrganization), total: organizations.length })
    } catch (err) {
      console.error('Organization list error:', err)
      return c.json({ error: 'Failed to list organizations', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/:orgName', (c) => {
    const orgName = c.req.param('orgName').trim()
    if (!orgName) {
      return c.json({ error: 'orgName is required', errorCode: 'INVALID_ORG' }, 400)
    }

    try {
      const organization = getOrganization(db, orgName)
      if (!organization) {
        return c.json({ error: `Organization ${orgName} not found`, errorCode: 'NOT_FOUND' }, 404)
      }
      return c.json(serializeOrganization(organization))
    } catch (err) {
      console.error('Organization lookup error:', err)
      return c.json({ error: 'Failed to retrieve organization', errorCode: 'DB_ERROR' }, 500)
    }
  })

  return router
}
