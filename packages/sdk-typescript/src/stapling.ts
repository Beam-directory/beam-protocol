import {
  DIRECTORY_SIGNING_PUBLIC_KEY,
  parseStapledAssertion,
  type StapledTrustEnvelope,
} from './trust-assertion.js'
import { checkStapledAssertion } from './verify-agent.js'

export const DEFAULT_ASSERTION_TTL_MS = 24 * 60 * 60 * 1000
const MIN_REFRESH_BEFORE_MS = 60_000
const MIN_USABLE_REMAINING_MS = 30_000
const FAILURE_BACKOFF_MS = 60_000
const FETCH_TIMEOUT_MS = 5_000

export interface TrustStaplerOptions {
  beamId: string
  directoryUrl: string
  /** Agent API key. With it, the directory may issue a longer-lived assertion for this agent. */
  apiKey?: () => string | undefined
  /** The key this agent signs frames with. An assertion bound to another key is not stapled. */
  agentPublicKey?: () => string | undefined
  /** Requested assertion lifetime. The directory caps it; the shorter of the two wins. */
  ttlMs?: number
  /** Refresh this long before expiry. Default: a fifth of the lifetime, at least one minute. */
  refreshBeforeMs?: number
  pinnedPublicKey?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

interface CachedAssertion {
  assertion: Record<string, unknown>
  issuedAtMs: number
  expiresAtMs: number
}

/**
 * Keeps this agent's own signed trust assertion ready to staple to outgoing
 * messages. One directory request per lifetime; never throws and never blocks
 * sending — when no valid assertion is at hand the message goes out unstapled
 * and receivers fall back to their own policy.
 */
export class TrustAssertionStapler {
  private readonly _options: TrustStaplerOptions
  private _cached: CachedAssertion | null = null
  private _inflight: Promise<void> | null = null
  private _backoffUntil = 0

  constructor(options: TrustStaplerOptions) {
    this._options = options
  }

  private _now(): number {
    return this._options.now?.() ?? Date.now()
  }

  private _refreshBefore(cached: CachedAssertion): number {
    if (this._options.refreshBeforeMs !== undefined) return this._options.refreshBeforeMs
    const lifetime = Math.max(0, cached.expiresAtMs - cached.issuedAtMs)
    return Math.min(Math.max(MIN_REFRESH_BEFORE_MS, lifetime / 5), lifetime / 2)
  }

  private _usable(cached: CachedAssertion | null, now: number): cached is CachedAssertion {
    return Boolean(cached && cached.expiresAtMs - now > MIN_USABLE_REMAINING_MS)
  }

  /** Assertion to staple now, or null. Refreshes in the background when expiry is near. */
  async current(): Promise<Record<string, unknown> | null> {
    const now = this._now()
    const cached = this._cached
    if (this._usable(cached, now)) {
      if (cached.expiresAtMs - now <= this._refreshBefore(cached)) void this._refresh()
      return cached.assertion
    }
    await this._refresh()
    const fresh = this._cached
    return this._usable(fresh, this._now()) ? fresh.assertion : null
  }

  async envelope(): Promise<StapledTrustEnvelope | null> {
    const assertion = await this.current()
    return assertion ? { v: 1, assertion } : null
  }

  /** Drop the cached assertion, for example after a key rotation. */
  invalidate(): void {
    this._cached = null
    this._backoffUntil = 0
  }

  private _refresh(): Promise<void> {
    if (this._inflight) return this._inflight
    if (this._now() < this._backoffUntil) return Promise.resolve()
    this._inflight = this._fetch()
      .then((next) => {
        if (next) this._cached = next
        else this._backoffUntil = this._now() + FAILURE_BACKOFF_MS
      })
      .catch(() => {
        this._backoffUntil = this._now() + FAILURE_BACKOFF_MS
      })
      .finally(() => {
        this._inflight = null
      })
    return this._inflight
  }

  private async _fetch(): Promise<CachedAssertion | null> {
    const ttlMs = this._options.ttlMs ?? DEFAULT_ASSERTION_TTL_MS
    const base = this._options.directoryUrl.replace(/\/$/, '')
    const url = `${base}/agents/${encodeURIComponent(this._options.beamId)}/trust-assertion?ttl=${Math.max(60, Math.floor(ttlMs / 1000))}`
    const headers: Record<string, string> = { accept: 'application/json' }
    const apiKey = this._options.apiKey?.()
    if (apiKey) headers['x-api-key'] = apiKey
    const fetchImpl = this._options.fetchImpl ?? fetch
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.status !== 200) return null
    const assertion = parseStapledAssertion(await response.text())
    if (!assertion) return null

    const now = this._now()
    const check = checkStapledAssertion(this._options.beamId, assertion, {
      pinnedPublicKey: this._options.pinnedPublicKey ?? DIRECTORY_SIGNING_PUBLIC_KEY,
      now: new Date(now),
    })
    if (!check.claimsAuthenticated || check.expired || !check.expiresAt) return null
    const ownKey = this._options.agentPublicKey?.()
    const agentKey = typeof assertion['agentKey'] === 'string' ? assertion['agentKey'] : null
    if (agentKey && ownKey && agentKey !== ownKey) return null

    const directoryExpiry = Date.parse(check.expiresAt)
    const issuedAtMs = check.issuedAt ? Date.parse(check.issuedAt) : now
    return {
      assertion,
      issuedAtMs,
      expiresAtMs: Math.min(directoryExpiry, issuedAtMs + ttlMs),
    }
  }
}
