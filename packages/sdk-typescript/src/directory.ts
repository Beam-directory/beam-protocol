import type {
  AgentRecord,
  AgentRegistration,
  AgentSearchQuery,
  BeamIdString,
  DirectoryConfig
} from './types.js'

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
      ...(config.apiKey && { Authorization: `Bearer ${config.apiKey}` })
    }
  }

  async register(registration: AgentRegistration): Promise<AgentRecord> {
    const res = await fetch(`${this.baseUrl}/agents/register`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(registration)
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
      throw new BeamDirectoryError(`Registration failed: ${body.error}`, res.status)
    }
    return res.json() as Promise<AgentRecord>
  }

  async lookup(beamId: BeamIdString): Promise<AgentRecord | null> {
    const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(beamId)}`, {
      headers: this.headers
    })
    if (res.status === 404) return null
    if (!res.ok) throw new BeamDirectoryError(`Lookup failed: ${res.statusText}`, res.status)
    return res.json() as Promise<AgentRecord>
  }

  async search(query: AgentSearchQuery): Promise<AgentRecord[]> {
    const params = new URLSearchParams()
    if (query.org) params.set('org', query.org)
    if (query.capabilities?.length) params.set('capabilities', query.capabilities.join(','))
    if (query.minTrustScore !== undefined) params.set('minTrustScore', String(query.minTrustScore))
    if (query.limit !== undefined) params.set('limit', String(query.limit))

    const res = await fetch(`${this.baseUrl}/agents/search?${params}`, { headers: this.headers })
    if (!res.ok) throw new BeamDirectoryError(`Search failed: ${res.statusText}`, res.status)
    return res.json() as Promise<AgentRecord[]>
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
