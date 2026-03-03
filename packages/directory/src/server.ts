import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import type { Server as HttpServer } from 'node:http'
import type { Database } from 'better-sqlite3'
import { agentsRouter } from './routes/agents.js'
import { createWebSocketServer, getConnectedCount } from './websocket.js'

export function createApp(db: Database): Hono {
  const app = new Hono()

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }))

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  app.route('/agents', agentsRouter(db))

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      protocol: 'beam/1',
      connectedAgents: getConnectedCount(),
      timestamp: new Date().toISOString(),
    })
  })

  // ---------------------------------------------------------------------------
  // Error handlers
  // ---------------------------------------------------------------------------

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

  // Upgrade HTTP connections to WebSocket for /ws paths
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
