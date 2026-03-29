const RETRY_BACKOFF_SECONDS = [30, 60, 120, 240, 480] as const

const NON_RETRYABLE_ERROR_CODES = new Set([
  'BAD_REQUEST',
  'FORBIDDEN',
  'INVALID_INTENT',
  'NONCE_REUSE_CONFLICT',
  'UNAUTHORIZED',
  'UNKNOWN_SENDER',
])

function hashSeed(input: string): number {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0
  }

  return Math.abs(hash)
}

export function computeRetryDelaySeconds(retryCount: number, seed: string): number {
  const safeRetryCount = Math.max(1, Math.trunc(retryCount) || 1)
  const baseDelay = RETRY_BACKOFF_SECONDS[Math.min(safeRetryCount - 1, RETRY_BACKOFF_SECONDS.length - 1)]
  const hash = hashSeed(`${seed}:${safeRetryCount}`)
  const jitterPercent = (hash % 31) - 15
  const jitterMultiplier = 1 + (jitterPercent / 100)

  return Math.max(5, Math.round(baseDelay * jitterMultiplier))
}

export function computeRetryAt(retryCount: number, seed: string, nowSeconds = Date.now() / 1000): number {
  return nowSeconds + computeRetryDelaySeconds(retryCount, seed)
}

export function isRetryableDirectoryError(errorCode?: string, status?: number): boolean {
  if (errorCode && NON_RETRYABLE_ERROR_CODES.has(errorCode)) {
    return false
  }

  if (status && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) {
    return false
  }

  return true
}
