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
import type { AgentRow, IntentFrame } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const catalogPath = resolve(__dirname, '../../../intents/catalog.yaml')

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

  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
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
    const frame: IntentFrame = {
      v: '1',
      from: String(raw.from ?? ''),
      to: String(raw.to ?? ''),
      intent: String(raw.intent ?? ''),
      params: (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params))
        ? raw.params as Record<string, unknown>
        : {},
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
