import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { findAgentByHandle, getAgent, getDIDDocument } from '../db.js'
import { configureDIDResolver, generateDirectoryDIDDocument, resolveDIDWithFallbacks } from '../did.js'

export function didRouter(db: Database): Hono {
  configureDIDResolver({
    getStoredDocument: (did) => getDIDDocument(db, did),
    getAgentByBeamId: (beamId) => getAgent(db, beamId),
    findAgentByHandle: (handle) => findAgentByHandle(db, handle),
  })

  const router = new Hono()

  router.get('/did/:didString', (c) => {
    const didString = decodeURIComponent(c.req.param('didString'))
    return resolveDIDWithFallbacks(didString).then((document) => {
      if (!document) {
        return c.json({ error: `DID ${didString} not found`, errorCode: 'NOT_FOUND' }, 404)
      }

      return new Response(JSON.stringify(document), {
        status: 200,
        headers: {
          'Content-Type': 'application/did+json',
          'Cache-Control': 'public, max-age=300',
        },
      })
    })
  })

  router.get('/.well-known/did.json', (c) => {
    return new Response(JSON.stringify(generateDirectoryDIDDocument()), {
      status: 200,
      headers: {
        'Content-Type': 'application/did+json',
        'Cache-Control': 'public, max-age=300',
      },
    })
  })

  return router
}
