import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { agentApiKeyMatches, getSuppliedApiKey } from '../api-key.js'
import { getAgent, logAuditEvent } from '../db.js'
import { issueWebSocketTicket } from '../websocket-ticket.js'

export function webSocketTicketRouter(db: Database): Hono {
  const router = new Hono()

  router.post('/:beamId/ws-ticket', (c) => {
    const beamId = c.req.param('beamId')
    const agent = getAgent(db, beamId)
    if (!agentApiKeyMatches(agent, getSuppliedApiKey(c.req.raw))) {
      c.header('Cache-Control', 'no-store')
      return c.json({ error: 'Valid agent API key required', errorCode: 'UNAUTHORIZED' }, 401)
    }

    try {
      const ticket = issueWebSocketTicket(beamId)
      logAuditEvent(db, {
        action: 'agent.websocket_ticket.issued',
        actor: beamId,
        target: beamId,
        details: {
          expiresAt: ticket.expiresAt,
          singleUse: true,
        },
      })
      c.header('Cache-Control', 'no-store')
      return c.json({
        beamId,
        ticket: ticket.ticket,
        expiresAt: ticket.expiresAt,
        expiresInSeconds: ticket.expiresInSeconds,
      })
    } catch (error) {
      c.header('Cache-Control', 'no-store')
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to issue WebSocket ticket',
        errorCode: 'WS_TICKET_LIMIT',
      }, 429)
    }
  })

  return router
}
