#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createBeamClient, loadBeamMcpConfig } from './config.js'
import { createBeamNetworkGateway } from './network-client.js'
import { createBeamMcpServer } from './server.js'
import { startBeamMcpHttpServer } from './http.js'

async function main(): Promise<void> {
  const transport = (process.env['BEAM_MCP_TRANSPORT'] ?? 'stdio').trim().toLowerCase()
  if (transport === 'http') {
    const http = await startBeamMcpHttpServer()
    let shuttingDown = false
    const shutdown = () => {
      if (shuttingDown) return
      shuttingDown = true
      void http.close()
        .then(() => { process.exitCode = 0 })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Remote MCP shutdown failed'
          process.stderr.write(`[beam-mcp-http] ${message}\n`)
          process.exitCode = 1
        })
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    return
  }
  if (transport !== 'stdio') {
    throw new Error('BEAM_MCP_TRANSPORT must be stdio or http')
  }

  const config = loadBeamMcpConfig()
  const client = createBeamClient(config)
  const server = createBeamMcpServer({
    gateway: {
      getStats: () => client.getStats(),
      lookup: (beamId) => client.directory.lookup(beamId),
      send: (to, intent, payload, timeoutMs) => client.send(to, intent, payload, timeoutMs),
    },
    networkGateway: createBeamNetworkGateway(config),
    ownBeamId: config.beamId,
    allowedIntents: config.allowedIntents,
    requireVerifiedTarget: config.requireVerifiedTarget,
    minimumVerificationTier: config.minimumVerificationTier,
    minimumTrustScore: config.minimumTrustScore,
  })
  await server.connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Beam MCP server failed to start'
  process.stderr.write(`[beam-mcp] ${message}\n`)
  process.exitCode = 1
})
