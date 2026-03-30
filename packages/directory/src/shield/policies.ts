export interface ShieldConfig {
  mode: 'whitelist' | 'open' | 'closed'
  allowlist: string[]
  blocklist: string[]
  minTrust: number
  rateLimit: number
}

export interface PublicEndpointShieldPolicy {
  trustedIps: string[]
  trustedBeamIds: string[]
  registrationPerMinute: number
  searchPerMinute: number
  browsePerMinute: number
  lookupPerMinute: number
  didResolutionPerMinute: number
  intentSendPerIpPerMinute: number
  intentSendPerSenderPerMinute: number
  adminAuthPerMinute: number
  keyMutationPerMinute: number
}

export const DEFAULT_SHIELD_CONFIG: ShieldConfig = {
  mode: 'open',
  allowlist: [],
  blocklist: [],
  minTrust: 0.3,
  rateLimit: 20,
}

export const DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY: PublicEndpointShieldPolicy = {
  trustedIps: [],
  trustedBeamIds: [],
  registrationPerMinute: 10,
  searchPerMinute: 30,
  browsePerMinute: 30,
  lookupPerMinute: 120,
  didResolutionPerMinute: 120,
  intentSendPerIpPerMinute: 30,
  intentSendPerSenderPerMinute: Number.parseInt(process.env['BEAM_RATE_LIMIT_PER_MIN'] ?? '20', 10) || 20,
  adminAuthPerMinute: 6,
  keyMutationPerMinute: 10,
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )]
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}

export function matchesBeamPattern(beamId: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === beamId) {
      return true
    }

    if (pattern.startsWith('*@')) {
      return beamId.endsWith(pattern.slice(1))
    }

    if (pattern.startsWith('*.')) {
      return beamId.includes(pattern.slice(1))
    }

    return false
  })
}

export function parseShieldConfig(raw: string | null | undefined): ShieldConfig {
  if (!raw) {
    return { ...DEFAULT_SHIELD_CONFIG }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ShieldConfig>
    return {
      mode: parsed.mode === 'whitelist' || parsed.mode === 'closed' ? parsed.mode : 'open',
      allowlist: sanitizeStringList(parsed.allowlist),
      blocklist: sanitizeStringList(parsed.blocklist),
      minTrust: clamp(parsed.minTrust, 0, 1, DEFAULT_SHIELD_CONFIG.minTrust),
      rateLimit: clamp(parsed.rateLimit, 1, 1_000, DEFAULT_SHIELD_CONFIG.rateLimit),
    }
  } catch {
    return { ...DEFAULT_SHIELD_CONFIG }
  }
}

export function parsePublicEndpointShieldPolicy(raw: string | null | undefined): PublicEndpointShieldPolicy {
  if (!raw) {
    return { ...DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PublicEndpointShieldPolicy>
    return {
      trustedIps: sanitizeStringList(parsed.trustedIps),
      trustedBeamIds: sanitizeStringList(parsed.trustedBeamIds),
      registrationPerMinute: clamp(parsed.registrationPerMinute, 1, 10_000, DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY.registrationPerMinute),
      searchPerMinute: clamp(parsed.searchPerMinute, 1, 10_000, DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY.searchPerMinute),
      browsePerMinute: clamp(parsed.browsePerMinute, 1, 10_000, DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY.browsePerMinute),
      lookupPerMinute: clamp(parsed.lookupPerMinute, 1, 10_000, DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY.lookupPerMinute),
      didResolutionPerMinute: clamp(parsed.didResolutionPerMinute, 1, 10_000, DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY.didResolutionPerMinute),
      intentSendPerIpPerMinute: clamp(parsed.intentSendPerIpPerMinute, 1, 10_000, DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY.intentSendPerIpPerMinute),
      intentSendPerSenderPerMinute: clamp(parsed.intentSendPerSenderPerMinute, 1, 10_000, DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY.intentSendPerSenderPerMinute),
      adminAuthPerMinute: clamp(parsed.adminAuthPerMinute, 1, 10_000, DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY.adminAuthPerMinute),
      keyMutationPerMinute: clamp(parsed.keyMutationPerMinute, 1, 10_000, DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY.keyMutationPerMinute),
    }
  } catch {
    return { ...DEFAULT_PUBLIC_ENDPOINT_SHIELD_POLICY }
  }
}
