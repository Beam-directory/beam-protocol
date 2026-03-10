import type {
  AgentProfile,
  AgentRecord,
  AgentRegistration,
  AgentSearchQuery,
  BeamIdString,
  BrowseFilters,
  BrowseResult,
  DirectoryConfig,
  DirectoryStats,
  DomainVerification,
  KeyRotationResult,
  Delegation,
  Report,
  VerificationTier,
} from './types.js'

function getString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  return undefined
}

function getNumber(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

function getBoolean(raw: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'boolean') {
      return value
    }
  }
  return undefined
}

function getStringArray(raw: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = raw[key]
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string')
    }
  }
  return []
}

function normalizeAgent(raw: Record<string, unknown>): AgentRecord {
  return {
    beamId: (raw.beamId ?? raw.beam_id) as AgentRecord['beamId'],
    did: (raw.did ?? '') as string,
    displayName: (raw.displayName ?? raw.display_name ?? '') as string,
    capabilities: (raw.capabilities ?? []) as string[],
    apiKey: (raw.apiKey ?? raw.api_key ?? undefined) as string | undefined,
    publicKey: (raw.publicKey ?? raw.public_key ?? '') as string,
    org: (raw.org ?? '') as string,
    trustScore: (raw.trustScore ?? raw.trust_score ?? 0) as number,
    verified: (raw.verified ?? false) as boolean,
    createdAt: (raw.createdAt ?? raw.created_at ?? '') as string,
    lastSeen: (raw.lastSeen ?? raw.last_seen ?? '') as string,
  }
}

function normalizeProfile(raw: Record<string, unknown>): AgentProfile {
  return {
    ...normalizeAgent(raw),
    description: getString(raw, 'description'),
    logoUrl: getString(raw, 'logoUrl', 'logo_url'),
    website: getString(raw, 'website'),
    verificationTier: getString(raw, 'verificationTier', 'verification_tier') as VerificationTier | undefined,
    verificationStatus: getString(raw, 'verificationStatus', 'verification_status') as AgentProfile['verificationStatus'],
    domain: getString(raw, 'domain'),
    intentsHandled: getNumber(raw, 'intentsHandled', 'intents_handled'),
  }
}

function normalizeStats(raw: Record<string, unknown>): DirectoryStats {
  return {
    totalAgents: getNumber(raw, 'totalAgents', 'total_agents', 'agents') ?? 0,
    verifiedAgents: getNumber(raw, 'verifiedAgents', 'verified_agents') ?? 0,
    intentsProcessed: getNumber(raw, 'intentsProcessed', 'totalIntents', 'total_intents') ?? 0,
    consumerAgents: getNumber(raw, 'consumerAgents', 'consumer_agents'),
    uptime: getNumber(raw, 'uptime', 'uptimeSeconds', 'uptime_seconds'),
    waitlistSize: getNumber(raw, 'waitlistSize', 'waitlist_size'),
    version: getString(raw, 'version'),
  }
}

function normalizeVerification(raw: Record<string, unknown>, fallbackDomain?: string): DomainVerification {
  return {
    domain: getString(raw, 'domain') ?? fallbackDomain ?? '',
    verified: getBoolean(raw, 'verified') ?? false,
    status: getString(raw, 'status'),
    tier: getString(raw, 'tier', 'verificationTier', 'verification_tier') as VerificationTier | undefined,
    txtName: getString(raw, 'txtName', 'txt_name'),
    txtValue: getString(raw, 'txtValue', 'txt_value', 'expected'),
    expected: getString(raw, 'expected'),
    records: getStringArray(raw, 'records'),
    checkedAt: getString(raw, 'checkedAt', 'checked_at'),
  }
}

function normalizeRotation(raw: Record<string, unknown>, beamId: BeamIdString, publicKey: string): KeyRotationResult {
  return {
    beamId: (getString(raw, 'beamId', 'beam_id') as BeamIdString | undefined) ?? beamId,
    publicKey: getString(raw, 'publicKey', 'public_key') ?? publicKey,
    rotatedAt: getString(raw, 'rotatedAt', 'rotated_at'),
    previousKey: getString(raw, 'previousKey', 'previous_key'),
  }
}

function normalizeDelegation(raw: Record<string, unknown>): Delegation {
  return {
    id: getString(raw, 'id'),
    sourceBeamId: (getString(raw, 'sourceBeamId', 'source_beam_id') ?? '') as BeamIdString,
    targetBeamId: (getString(raw, 'targetBeamId', 'target_beam_id') ?? '') as BeamIdString,
    scope: getString(raw, 'scope') ?? '',
    expiresAt: getString(raw, 'expiresAt', 'expires_at'),
    createdAt: getString(raw, 'createdAt', 'created_at'),
    status: getString(raw, 'status'),
  }
}

function normalizeReport(raw: Record<string, unknown>): Report {
  return {
    id: getString(raw, 'id'),
    reporterBeamId: (getString(raw, 'reporterBeamId', 'reporter_beam_id') ?? '') as BeamIdString,
    targetBeamId: (getString(raw, 'targetBeamId', 'target_beam_id') ?? '') as BeamIdString,
    reason: getString(raw, 'reason') ?? '',
    createdAt: getString(raw, 'createdAt', 'created_at'),
    status: getString(raw, 'status'),
  }
}

export class BeamDirectoryError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message)
    this.name = 'BeamDirectoryError'
  }
}

export class BeamDirectory {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(config: DirectoryConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey && { 'x-api-key': config.apiKey })
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.headers,
        ...(init?.headers ?? {}),
      },
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
      throw new BeamDirectoryError(body.error ?? res.statusText, res.status)
    }

    if (res.status === 204) {
      return undefined as T
    }

    return res.json() as Promise<T>
  }

  async register(registration: AgentRegistration): Promise<AgentRecord> {
    const body = await this.request<Record<string, unknown>>('/agents/register', {
      method: 'POST',
      body: JSON.stringify(registration)
    })
    return normalizeAgent(body)
  }

  async lookup(beamId: BeamIdString): Promise<AgentRecord | null> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(beamId)}`, {
      headers: this.headers
    })
    if (res.status === 404) return null
    if (!res.ok) throw new BeamDirectoryError(`Lookup failed: ${res.statusText}`, res.status)
    const body = await res.json() as Record<string, unknown>
    return normalizeAgent(body)
  }

  async search(query: AgentSearchQuery): Promise<AgentRecord[]> {
    const params = new URLSearchParams()
    if (query.org) params.set('org', query.org)
    if (query.capabilities?.length) params.set('capabilities', query.capabilities.join(','))
    if (query.minTrustScore !== undefined) params.set('minTrustScore', String(query.minTrustScore))
    if (query.limit !== undefined) params.set('limit', String(query.limit))

    const body = await this.request<{ agents?: Record<string, unknown>[] } | Record<string, unknown>[]>(`/agents/search?${params.toString()}`)
    const raw = Array.isArray(body) ? body : (body.agents ?? [])
    return raw.map(normalizeAgent)
  }

  async browse(page = 1, filters: BrowseFilters = {}): Promise<BrowseResult> {
    const params = new URLSearchParams({ page: String(page) })
    if (filters.capability) params.set('capability', filters.capability)
    if (filters.tier) params.set('tier', filters.tier)
    if (filters.verified_only) params.set('verified_only', String(filters.verified_only))

    try {
      const body = await this.request<Record<string, unknown>>(`/agents/browse?${params.toString()}`)
      const agentsRaw = Array.isArray(body['agents'])
        ? body['agents'].filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        : []
      return {
        page: getNumber(body, 'page') ?? page,
        pageSize: getNumber(body, 'pageSize', 'page_size') ?? agentsRaw.length,
        total: getNumber(body, 'total') ?? agentsRaw.length,
        agents: agentsRaw.map(normalizeProfile),
      }
    } catch (error) {
      if (!(error instanceof BeamDirectoryError) || error.statusCode !== 404) {
        throw error
      }

      const search = await this.search({
        capabilities: filters.capability ? [filters.capability] : undefined,
        limit: 20,
      })

      const filtered = search.filter((agent) => {
        if (filters.verified_only && !agent.verified) return false
        return true
      })

      return {
        page,
        pageSize: filtered.length,
        total: filtered.length,
        agents: filtered.map((agent) => ({
          ...agent,
          verificationTier: agent.verified ? 'verified' : 'basic',
        })),
      }
    }
  }

  async getStats(): Promise<DirectoryStats> {
    const body = await this.request<Record<string, unknown>>('/stats')
    return normalizeStats(body)
  }

  async updateProfile(beamId: BeamIdString, fields: { description?: string; logo_url?: string; website?: string }): Promise<AgentProfile> {
    const body = await this.request<Record<string, unknown>>(`/agents/${encodeURIComponent(beamId)}/profile`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    })
    return normalizeProfile(body)
  }

  async verifyDomain(beamId: BeamIdString, domain: string): Promise<DomainVerification> {
    const body = await this.request<Record<string, unknown>>(`/agents/${encodeURIComponent(beamId)}/verify/domain`, {
      method: 'POST',
      body: JSON.stringify({ domain }),
    })
    return normalizeVerification(body, domain)
  }

  async checkDomainVerification(beamId: BeamIdString): Promise<DomainVerification> {
    const body = await this.request<Record<string, unknown>>(`/agents/${encodeURIComponent(beamId)}/verify/domain`)
    return normalizeVerification(body)
  }

  async rotateKeys(beamId: BeamIdString, publicKey: string, rotationProof?: string): Promise<KeyRotationResult> {
    const body = await this.request<Record<string, unknown>>(`/agents/${encodeURIComponent(beamId)}/keys/rotate`, {
      method: 'POST',
      body: JSON.stringify({
        new_public_key: publicKey,
        ...(rotationProof ? { rotation_proof: rotationProof } : {}),
      }),
    })
    return normalizeRotation(body, beamId, publicKey)
  }

  async delegate(sourceBeamId: BeamIdString, targetBeamId: BeamIdString, scope: string, expiresIn?: number): Promise<Delegation> {
    const body = await this.request<Record<string, unknown>>('/delegations', {
      method: 'POST',
      body: JSON.stringify({ sourceBeamId, targetBeamId, scope, expiresIn }),
    })
    return normalizeDelegation(body)
  }

  async report(reporterBeamId: BeamIdString, targetBeamId: BeamIdString, reason: string): Promise<Report> {
    const body = await this.request<Record<string, unknown>>('/reports', {
      method: 'POST',
      body: JSON.stringify({ reporterBeamId, targetBeamId, reason }),
    })
    return normalizeReport(body)
  }

  async heartbeat(beamId: BeamIdString): Promise<void> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(beamId)}/heartbeat`, {
      method: 'POST',
      headers: this.headers
    })
    if (!res.ok && res.status !== 404) {
      throw new BeamDirectoryError(`Heartbeat failed: ${res.statusText}`, res.status)
    }
  }
}
