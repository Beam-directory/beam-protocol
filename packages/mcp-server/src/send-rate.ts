const SEND_WINDOW_MS = 60 * 60 * 1000

const sendsByIdentity = new Map<string, number[]>()

export function resetSendRateLimitForTests(): void {
  sendsByIdentity.clear()
}

function recentSends(identity: string, now: number): number[] {
  const windowStart = now - SEND_WINDOW_MS
  return (sendsByIdentity.get(identity) ?? []).filter((timestamp) => timestamp > windowStart)
}

export function assertSendCapacity(identity: string, limit: number, now = Date.now()): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Send rate limit is not configured')
  }
  if (recentSends(identity, now).length >= limit) {
    throw new Error(`Send rate limit exceeded: ${limit} external sends per hour`)
  }
}

export function recordSend(identity: string, now = Date.now()): void {
  const recent = recentSends(identity, now)
  recent.push(now)
  sendsByIdentity.set(identity, recent)
}
