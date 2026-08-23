import { createHash, randomBytes } from 'node:crypto'

const TICKET_PREFIX = 'bwt_'
const TICKET_TTL_MS = 30_000
const MAX_ACTIVE_TICKETS_PER_AGENT = 5

type TicketRecord = {
  beamId: string
  expiresAtMs: number
}

const tickets = new Map<string, TicketRecord>()
const ticketHashesByAgent = new Map<string, Set<string>>()

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex')
}

function deleteTicket(ticketHash: string, record: TicketRecord): void {
  tickets.delete(ticketHash)
  const agentTickets = ticketHashesByAgent.get(record.beamId)
  agentTickets?.delete(ticketHash)
  if (agentTickets?.size === 0) {
    ticketHashesByAgent.delete(record.beamId)
  }
}

function pruneExpiredTickets(nowMs = Date.now()): void {
  for (const [ticketHash, record] of tickets) {
    if (record.expiresAtMs <= nowMs) {
      deleteTicket(ticketHash, record)
    }
  }
}

export function issueWebSocketTicket(
  beamId: string,
  nowMs = Date.now(),
): { ticket: string; expiresAt: string; expiresInSeconds: number } {
  pruneExpiredTickets(nowMs)
  const active = ticketHashesByAgent.get(beamId) ?? new Set<string>()
  if (active.size >= MAX_ACTIVE_TICKETS_PER_AGENT) {
    throw new Error('Too many active WebSocket tickets for this agent')
  }

  const ticket = `${TICKET_PREFIX}${randomBytes(32).toString('base64url')}`
  const ticketHash = hashTicket(ticket)
  const expiresAtMs = nowMs + TICKET_TTL_MS
  tickets.set(ticketHash, { beamId, expiresAtMs })
  active.add(ticketHash)
  ticketHashesByAgent.set(beamId, active)

  return {
    ticket,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresInSeconds: Math.floor(TICKET_TTL_MS / 1_000),
  }
}

export function consumeWebSocketTicket(
  ticket: string | null | undefined,
  beamId: string,
  nowMs = Date.now(),
): boolean {
  if (!ticket?.startsWith(TICKET_PREFIX)) {
    return false
  }

  pruneExpiredTickets(nowMs)
  const ticketHash = hashTicket(ticket)
  const record = tickets.get(ticketHash)
  if (!record || record.beamId !== beamId || record.expiresAtMs <= nowMs) {
    return false
  }

  deleteTicket(ticketHash, record)
  return true
}

export function resetWebSocketTickets(): void {
  tickets.clear()
  ticketHashesByAgent.clear()
}
