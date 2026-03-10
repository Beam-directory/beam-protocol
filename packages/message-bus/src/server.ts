#!/usr/bin/env node
/**
 * Beam Message Bus — Standalone CLI Server
 * 
 * Usage: npx @beam-protocol/message-bus [options]
 *   --port <number>       Server port (default: 8420)
 *   --directory <url>     Beam Directory URL (default: http://localhost:3100)
 *   --db <path>           SQLite database path (default: ./beam-bus.sqlite)
 *   --identity <path>     Beam identity JSON file
 *   --rate-limit <number> Max messages per minute per sender (default: 10)
 */

import { createBus } from './index.js'

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2)
  const opts: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--') && i + 1 < args.length) {
      opts[arg.slice(2)] = args[++i]
    }
  }
  return opts
}

const args = parseArgs()

const bus = createBus({
  port: args.port ? parseInt(args.port) : 8420,
  directoryUrl: args.directory ?? 'http://localhost:3100',
  dbPath: args.db ?? './beam-bus.sqlite',
  identityPath: args.identity,
  rateLimit: args['rate-limit'] ? parseInt(args['rate-limit']) : 10,
})

bus.start().catch(err => {
  console.error('[beam-bus] Failed to start:', err)
  process.exit(1)
})

process.on('SIGINT', () => { bus.stop(); process.exit(0) })
process.on('SIGTERM', () => { bus.stop(); process.exit(0) })
