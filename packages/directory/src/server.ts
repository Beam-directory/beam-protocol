import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import type { Server as HttpServer } from 'node:http'
import type { Database } from 'better-sqlite3'
import { agentsRouter } from './routes/agents.js'
import { createWebSocketServer, getConnectedCount, getConnectedBeamIds, relayIntentFromHttp, RelayError } from './websocket.js'
import { createAcl, deleteAcl, listAclsForBeam, seedAclsFromCatalog } from './acl.js'
import type { AgentRow, IntentFrame } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const catalogPath = resolve(__dirname, '../../../intents/catalog.yaml')
const BEAM_DIRECTORY_ORIGIN = 'https://beam.directory'

type WaitlistSignupInput = {
  email: string
  source: string | null
  company: string | null
  agentCount: number | null
}

type WaitlistRow = {
  id: number
  email: string
  source: string | null
  company: string | null
  agent_count: number | null
  created_at: string
}

function serializeAgent(row: AgentRow, connectedSet: Set<string>): object {
  return {
    ...row,
    capabilities: JSON.parse(row.capabilities) as string[],
    verified: row.verified === 1,
    connected: connectedSet.has(row.beam_id),
  }
}

function loadIntentCatalog(): unknown {
  const raw = readFileSync(catalogPath, 'utf8')
  return JSON.parse(raw)
}

export function createApp(db: Database): Hono {
  const app = new Hono()
  seedAclsFromCatalog(db)

  app.use('*', cors({
    origin: (origin) => origin === BEAM_DIRECTORY_ORIGIN ? origin : '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
  }))

  // List all agents with connection status (before sub-router to avoid conflict)
  app.get('/directory/agents', (c) => {
    try {
      const rows = db.prepare('SELECT * FROM agents ORDER BY beam_id ASC').all() as AgentRow[]
      const connected = new Set(getConnectedBeamIds())
      return c.json({
        agents: rows.map((row) => serializeAgent(row, connected)),
        total: rows.length,
      })
    } catch (err) {
      console.error('List agents error:', err)
      return c.json({ error: 'Failed to list agents', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.route('/agents', agentsRouter(db))

  app.post('/acl', async (c) => {
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
    const targetBeamId = String(raw.targetBeamId ?? '')
    const intentType = String(raw.intentType ?? '')
    const allowedFrom = String(raw.allowedFrom ?? '')

    if (!targetBeamId || !intentType || !allowedFrom) {
      return c.json({ error: 'targetBeamId, intentType and allowedFrom are required', errorCode: 'INVALID_ACL' }, 400)
    }

    try {
      const acl = createAcl(db, { targetBeamId, intentType, allowedFrom })
      return c.json(acl, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create ACL entry'
      return c.json({ error: message, errorCode: 'ACL_ERROR' }, 400)
    }
  })

  app.get('/acl/:beamId', (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    try {
      const rows = listAclsForBeam(db, beamId)
      return c.json({ acl: rows, total: rows.length })
    } catch (err) {
      console.error('List ACL error:', err)
      return c.json({ error: 'Failed to list ACL entries', errorCode: 'ACL_ERROR' }, 500)
    }
  })

  app.delete('/acl/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid ACL id', errorCode: 'INVALID_ACL_ID' }, 400)
    }

    try {
      const removed = deleteAcl(db, id)
      if (!removed) {
        return c.json({ error: `ACL id ${id} not found`, errorCode: 'NOT_FOUND' }, 404)
      }
      return c.json({ ok: true, id })
    } catch (err) {
      console.error('Delete ACL error:', err)
      return c.json({ error: 'Failed to delete ACL entry', errorCode: 'ACL_ERROR' }, 500)
    }
  })

  app.post('/waitlist', async (c) => {
    c.header('Access-Control-Allow-Origin', BEAM_DIRECTORY_ORIGIN)

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
    const email = String(raw.email ?? '').trim().toLowerCase()
    const source = typeof raw.source === 'string' && raw.source.trim().length > 0
      ? raw.source.trim()
      : null
    const company = typeof raw.company === 'string' && raw.company.trim().length > 0
      ? raw.company.trim()
      : null

    let agentCount: number | null = null
    if (raw.agentCount !== undefined && raw.agentCount !== null && raw.agentCount !== '') {
      const parsedAgentCount = Number(raw.agentCount)
      if (!Number.isInteger(parsedAgentCount) || parsedAgentCount < 0) {
        return c.json({ error: 'agentCount must be a non-negative integer', errorCode: 'INVALID_AGENT_COUNT' }, 400)
      }
      agentCount = parsedAgentCount
    }

    if (!email || !email.includes('@')) {
      return c.json({ error: 'A valid email is required', errorCode: 'INVALID_EMAIL' }, 400)
    }

    const signup: WaitlistSignupInput = {
      email,
      source,
      company,
      agentCount,
    }

    const createdAt = new Date().toISOString()

    try {
      const result = db.prepare(`
        INSERT INTO waitlist (email, source, company, agent_count, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(signup.email, signup.source, signup.company, signup.agentCount, createdAt)

      console.log(
        `[waitlist] new signup email=${signup.email} source=${signup.source ?? '-'} company=${signup.company ?? '-'} agentCount=${signup.agentCount ?? '-'} createdAt=${createdAt}`
      )

      return c.json({
        id: Number(result.lastInsertRowid),
        email: signup.email,
        source: signup.source,
        company: signup.company,
        agentCount: signup.agentCount,
        createdAt,
      }, 201)
    } catch (err) {
      console.error('Waitlist signup error:', err)
      return c.json({ error: 'Failed to save waitlist signup', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/waitlist', (c) => {
    const adminKey = process.env['BEAM_ADMIN_KEY']
    if (!adminKey) {
      console.error('BEAM_ADMIN_KEY is not configured')
      return c.json({ error: 'Admin access unavailable', errorCode: 'ADMIN_NOT_CONFIGURED' }, 503)
    }

    const providedKey = c.req.header('X-Admin-Key')
    if (providedKey !== adminKey) {
      return c.json({ error: 'Unauthorized', errorCode: 'UNAUTHORIZED' }, 401)
    }

    try {
      const rows = db.prepare(`
        SELECT id, email, source, company, agent_count, created_at
        FROM waitlist
        ORDER BY created_at DESC, id DESC
      `).all() as WaitlistRow[]

      return c.json({
        signups: rows.map((row) => ({
          id: row.id,
          email: row.email,
          source: row.source,
          company: row.company,
          agentCount: row.agent_count,
          createdAt: row.created_at,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('List waitlist error:', err)
      return c.json({ error: 'Failed to list waitlist signups', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.post('/intents/send', async (c) => {
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
    const payloadCandidate = (
      raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
    )
      ? raw.payload
      : (
        raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
      )
        ? raw.params
        : undefined

    const frame: IntentFrame = {
      v: '1',
      from: String(raw.from ?? ''),
      to: String(raw.to ?? ''),
      intent: String(raw.intent ?? ''),
      payload: payloadCandidate ? payloadCandidate as Record<string, unknown> : {},
      signature: typeof raw.signature === 'string' ? raw.signature : undefined,
      nonce: typeof raw.nonce === 'string' && raw.nonce.length > 0 ? raw.nonce : randomUUID(),
      timestamp: typeof raw.timestamp === 'string' && raw.timestamp.length > 0 ? raw.timestamp : new Date().toISOString(),
    }

    try {
      const result = await relayIntentFromHttp(db, frame, 60_000)
      return c.json(result)
    } catch (err) {
      if (err instanceof RelayError) {
        if (err.code === 'OFFLINE') {
          return c.json({ error: 'agent_offline', errorCode: 'OFFLINE' }, 503)
        }
        if (err.code === 'TIMEOUT') {
          return c.json({ error: err.message, errorCode: 'TIMEOUT' }, 504)
        }
        if (err.code === 'BAD_REQUEST') {
          return c.json({ error: err.message, errorCode: 'INVALID_INTENT' }, 400)
        }
        if (err.code === 'FORBIDDEN') {
          return c.json({ error: err.message, errorCode: 'FORBIDDEN' }, 403)
        }
        if (err.code === 'RATE_LIMITED') {
          return c.json({ error: err.message, errorCode: 'RATE_LIMITED' }, 429)
        }
        return c.json({ error: err.message, errorCode: err.code }, 502)
      }

      console.error('HTTP intent relay error:', err)
      return c.json({ error: 'Failed to relay intent', errorCode: 'RELAY_FAILED' }, 500)
    }
  })

  app.get('/intents/catalog', (c) => {
    try {
      return c.json(loadIntentCatalog())
    } catch (err) {
      console.error('Catalog load error:', err)
      return c.json({ error: 'Catalog unavailable', errorCode: 'CATALOG_UNAVAILABLE' }, 500)
    }
  })

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      protocol: 'beam/1',
      connectedAgents: getConnectedCount(),
      timestamp: new Date().toISOString(),
    })
  })

  app.notFound((c) => c.json({ error: 'Not found', errorCode: 'NOT_FOUND' }, 404))

  app.onError((err, c) => {
    console.error('Unhandled server error:', err)
    return c.json({ error: 'Internal server error', errorCode: 'INTERNAL_ERROR' }, 500)
  })

  return app
}

export function startServer(db: Database, port = 3000): HttpServer {
  const app = createApp(db)
  const wss = createWebSocketServer(db)

  const server = serve(
    { fetch: app.fetch, port },
    (info) => {
      console.log(`Beam Directory Server running on http://localhost:${info.port}`)
      console.log(`WebSocket endpoint: ws://localhost:${info.port}/ws`)
    }
  ) as unknown as HttpServer

  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  return server
}
