import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const CONFIRMATION_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_CONFIRMATIONS = 256
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

type PendingConfirmation = {
  digest: string
  expiresAt: number
}

const pending = new Map<string, PendingConfirmation>()

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

function pruneConfirmations(now: number): void {
  for (const [token, record] of pending) {
    if (record.expiresAt <= now) pending.delete(token)
  }
}

export function resetConfirmationsForTests(): void {
  pending.clear()
}

export function issueConfirmation(subject: unknown, now = Date.now()): {
  confirmationToken: string
  confirmationDigest: string
  confirmationExpiresAt: string
} {
  pruneConfirmations(now)
  if (pending.size >= MAX_PENDING_CONFIRMATIONS) {
    throw new Error('Too many pending confirmations. Send or discard a prepared action first.')
  }
  const confirmationToken = randomBytes(32).toString('base64url')
  const confirmationDigest = canonicalDigest(subject)
  const expiresAt = now + CONFIRMATION_TTL_MS
  pending.set(confirmationToken, { digest: confirmationDigest, expiresAt })
  return {
    confirmationToken,
    confirmationDigest,
    confirmationExpiresAt: new Date(expiresAt).toISOString(),
  }
}

export function consumeConfirmation(token: string, subject: unknown, now = Date.now()): void {
  pruneConfirmations(now)
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('External delivery blocked: confirmation token is invalid')
  }
  const record = pending.get(token)
  if (!record) {
    throw new Error('External delivery blocked: prepare this exact action again and use its server-issued confirmation token')
  }
  const digest = canonicalDigest(subject)
  const left = Buffer.from(record.digest)
  const right = Buffer.from(digest)
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error('External delivery blocked: confirmation token does not match this exact action')
  }
  pending.delete(token)
}
