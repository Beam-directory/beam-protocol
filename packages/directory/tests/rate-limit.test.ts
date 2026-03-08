import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadRateLimitModule() {
  vi.resetModules()
  return import('../src/rate-limit.js')
}

describe('rate-limit', () => {
  afterEach(() => {
    delete process.env.BEAM_RATE_LIMIT_PER_MIN
    vi.useRealTimers()
  })

  it('uses the configured per-minute rate limit and falls back for invalid values', async () => {
    process.env.BEAM_RATE_LIMIT_PER_MIN = '15'
    let rateLimit = await loadRateLimitModule()
    expect(rateLimit.getRateLimitPerMinute()).toBe(15)

    process.env.BEAM_RATE_LIMIT_PER_MIN = '0'
    rateLimit = await loadRateLimitModule()
    expect(rateLimit.getRateLimitPerMinute()).toBe(60)
  })

  it('allows requests up to the limit and rejects the next one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-08T10:00:00.000Z'))
    const rateLimit = await loadRateLimitModule()

    expect(rateLimit.checkAgentRateLimit('alice@acme.beam.directory', 2)).toBe(true)
    expect(rateLimit.checkAgentRateLimit('alice@acme.beam.directory', 2)).toBe(true)
    expect(rateLimit.checkAgentRateLimit('alice@acme.beam.directory', 2)).toBe(false)
  })

  it('resets the request window after one minute expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-08T10:00:00.000Z'))
    const rateLimit = await loadRateLimitModule()

    expect(rateLimit.checkAgentRateLimit('bob@acme.beam.directory', 1)).toBe(true)
    expect(rateLimit.checkAgentRateLimit('bob@acme.beam.directory', 1)).toBe(false)

    vi.setSystemTime(new Date('2026-03-08T10:01:00.001Z'))
    expect(rateLimit.checkAgentRateLimit('bob@acme.beam.directory', 1)).toBe(true)
  })

  it('pruneRateLimitState() removes expired counters', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-08T10:00:00.000Z'))
    const rateLimit = await loadRateLimitModule()

    expect(rateLimit.checkAgentRateLimit('clara@acme.beam.directory', 1)).toBe(true)
    expect(rateLimit.checkAgentRateLimit('clara@acme.beam.directory', 1)).toBe(false)

    vi.setSystemTime(new Date('2026-03-08T10:01:05.000Z'))
    rateLimit.pruneRateLimitState()

    vi.setSystemTime(new Date('2026-03-08T10:00:30.000Z'))
    expect(rateLimit.checkAgentRateLimit('clara@acme.beam.directory', 1)).toBe(true)
  })
})
