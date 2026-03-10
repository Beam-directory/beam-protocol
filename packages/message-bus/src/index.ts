/**
 * @beam-protocol/message-bus
 * 
 * Persistent message bus for agent-to-agent communication via Beam Protocol.
 * 
 * @example
 * ```typescript
 * import { createBus } from '@beam-protocol/message-bus'
 * 
 * const bus = createBus({
 *   dbPath: './beam-bus.sqlite',
 *   directoryUrl: 'http://localhost:3100',
 *   port: 8420,
 * })
 * 
 * await bus.start()
 * ```
 */

export { initDatabase, type BeamMessage, type BusStats } from './db.js'
export { createBusRouter, type RouterOptions } from './router.js'
export { startRetryWorker, stopRetryWorker, type WorkerOptions } from './worker.js'
export { loadIdentities, deliverToDirectory, type DeliveryResult } from './delivery.js'

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { initDatabase } from './db.js'
import { createBusRouter } from './router.js'
import { startRetryWorker } from './worker.js'
import { loadIdentities } from './delivery.js'

export interface BusOptions {
  /** SQLite database path (default: ./beam-bus.sqlite) */
  dbPath?: string
  /** Beam Directory URL (default: http://localhost:3100) */
  directoryUrl?: string
  /** Path to Beam identity JSON file */
  identityPath?: string
  /** Retry worker interval in ms (default: 30000) */
  retryIntervalMs?: number
  /** Max messages per minute per sender (default: 10) */
  rateLimit?: number
  /** Server port (default: 8420) */
  port?: number
}

export interface Bus {
  start(): Promise<void>
  stop(): void
}

/**
 * Create a standalone Beam Message Bus server.
 */
export function createBus(options: BusOptions = {}): Bus {
  const {
    dbPath = './beam-bus.sqlite',
    directoryUrl = 'http://localhost:3100',
    identityPath,
    retryIntervalMs = 30_000,
    rateLimit = 10,
    port = 8420,
  } = options

  let retryTimer: NodeJS.Timeout | null = null
  let server: ReturnType<typeof serve> | null = null

  return {
    async start() {
      const db = initDatabase(dbPath)

      if (identityPath) {
        loadIdentities(identityPath)
      }

      const busRouter = createBusRouter({ db, directoryUrl, rateLimit })

      const app = new Hono()
      app.route('/v1/beam', busRouter)
      app.get('/health', (c) => c.json({ status: 'ok', service: 'beam-message-bus' }))

      retryTimer = startRetryWorker({ db, directoryUrl, intervalMs: retryIntervalMs })

      server = serve({ fetch: app.fetch, port })
      console.log(`[beam-bus] 📡 Beam Message Bus running on http://localhost:${port}`)
    },

    stop() {
      if (retryTimer) {
        clearInterval(retryTimer)
        retryTimer = null
      }
      if (server) {
        server.close()
        server = null
      }
      console.log('[beam-bus] Stopped')
    },
  }
}
