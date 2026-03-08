export type VerificationTier = 'basic' | 'verified' | 'business' | 'enterprise'

export interface DirectoryAgent {
  beamId: string
  org: string
  displayName: string
  capabilities: string[]
  publicKey: string
  email: string | null
  emailVerified: boolean
  verificationTier: VerificationTier
  description: string | null
  logoUrl: string | null
  trustScore: number
  verified: boolean
  createdAt: string
  lastSeen: string
}

export interface AgentIntentStats {
  received: number
  responded: number
  avg_response_time_ms: number | null
}

export interface DirectoryAgentDetail extends DirectoryAgent {
  intentStats: AgentIntentStats
}

export interface AgentSearchResponse {
  agents: DirectoryAgent[]
  total: number
}

export interface DirectoryStats {
  total_agents: number
  verified_agents: number
  intents_processed: number
  avg_response_time_ms: number | null
}

export interface DirectoryHealth {
  status: string
  protocol: string
  connectedAgents: number
  timestamp: string
}

export interface RecentIntent {
  nonce: string
  from: string
  to: string
  intentType: string
  timestamp: string
  completedAt: string | null
  roundTripLatencyMs: number | null
  status: string
  errorCode: string | null
}

export interface RecentIntentsResponse {
  intents: RecentIntent[]
  total: number
}

export interface RegisterAgentInput {
  display_name: string
  email: string
  capabilities: string[]
  description?: string
  logo_url?: string
  public_key: string
}

export interface OrgRegistrationInput {
  name: string
  displayName?: string
  domain?: string
}

export interface OrgVerificationInfo {
  txtName: string
  txtValue: string
}

export interface DirectoryOrg {
  name: string
  displayName: string
  domain: string | null
  beamDomain: string
  verified: boolean
  createdAt: string
  verifiedAt: string | null
  verification: OrgVerificationInfo | null
}

export interface OrgRegistrationResponse extends DirectoryOrg {
  apiKey: string
}

export interface OrgAgentCreateInput {
  agentName: string
  displayName?: string
  capabilities?: string[]
}

export interface OrgAgentResponse {
  beamId: string
  agentName: string
  displayName: string
  org: string
  capabilities: string[]
  publicKey: string
  privateKey?: string
  trustScore: number
  verified: boolean
  createdAt: string
  updatedAt: string
  lastSeen: string
}

export interface OrgDetailsResponse {
  org: DirectoryOrg
  agents: OrgAgentResponse[]
  total: number
}

export interface IntentCatalogItem {
  type: string
  description?: string
  payloadSchema?: Record<string, unknown>
}

export interface IntentCatalogResponse {
  intents: IntentCatalogItem[]
}

export interface SendIntentInput {
  v: '1'
  intent: string
  from: string
  to: string
  payload: Record<string, unknown>
  nonce: string
  timestamp: string
  signature: string
}

export interface SendIntentResponse {
  success: boolean
  payload?: Record<string, unknown>
  error?: string
  errorCode?: string
  nonce: string
  timestamp: string
  latency?: number
  signature?: string
}

export interface WaitlistSignupInput {
  email: string
  source?: string
  company?: string
  agentCount?: number
}

export interface WaitlistSignupResponse {
  ok: boolean
  email: string
  createdAt: string
}

export interface WaitlistEntry {
  email: string
  source: string | null
  company: string | null
  agentCount: number | null
  createdAt: string
}

export interface WaitlistListResponse {
  waitlist: WaitlistEntry[]
  total: number
}

export interface IntentFeedMessage {
  type: 'feed_connected' | 'intent_feed'
  entry?: RecentIntent
}

const DEFAULT_DIRECTORY_URL = 'http://localhost:3100'

export const DIRECTORY_URL = (import.meta.env.VITE_DIRECTORY_URL || DEFAULT_DIRECTORY_URL).replace(/\/$/, '')
export const DIRECTORY_WS_URL = DIRECTORY_URL.replace(/^http/, 'ws')

class ApiError extends Error {
  status: number
  errorCode?: string

  constructor(message: string, status: number, errorCode?: string) {
    super(message)
    this.status = status
    this.errorCode = errorCode
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${DIRECTORY_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    let payload: { error?: string; errorCode?: string } | null = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    throw new ApiError(payload?.error ?? `Request failed with ${response.status}`, response.status, payload?.errorCode)
  }

  return response.json() as Promise<T>
}

function withApiKey(apiKey?: string): HeadersInit | undefined {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
}

export const directoryApi = {
  getHealth: () => request<DirectoryHealth>('/health'),
  getRootStats: () => request<{ agents: number; intentsProcessed: number; uptime: number; waitlistSize: number; version: string }>('/stats'),
  getAgentStats: () => request<DirectoryStats>('/agents/stats'),
  searchAgents: (params?: {
    q?: string
    capabilities?: string[]
    verificationTier?: VerificationTier
    org?: string
    minTrustScore?: number
    limit?: number
  }) => {
    const query = new URLSearchParams()
    if (params?.q) query.set('q', params.q)
    if (params?.capabilities?.length) query.set('capabilities', params.capabilities.join(','))
    if (params?.verificationTier) query.set('verificationTier', params.verificationTier)
    if (params?.org) query.set('org', params.org)
    if (typeof params?.minTrustScore === 'number') query.set('minTrustScore', String(params.minTrustScore))
    if (typeof params?.limit === 'number') query.set('limit', String(params.limit))
    return request<AgentSearchResponse>(`/agents/search${query.toString() ? `?${query.toString()}` : ''}`)
  },
  getAgent: (beamId: string) => request<DirectoryAgentDetail>(`/agents/${encodeURIComponent(beamId)}`),
  heartbeat: (beamId: string) => request<DirectoryAgent>(`/agents/${encodeURIComponent(beamId)}/heartbeat`, { method: 'POST' }),
  registerAgent: (input: RegisterAgentInput) => request<DirectoryAgent>('/agents/register', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  getRecentIntents: (limit = 50) => request<RecentIntentsResponse>(`/intents/recent?limit=${limit}`),
  getIntentCatalog: () => request<IntentCatalogResponse>('/intents/catalog'),
  sendIntent: (input: SendIntentInput) => request<SendIntentResponse>('/intents/send', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  signupWaitlist: (input: WaitlistSignupInput) => request<WaitlistSignupResponse>('/waitlist', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  listWaitlist: () => request<WaitlistListResponse>('/waitlist'),
  createOrg: (input: OrgRegistrationInput) => request<OrgRegistrationResponse>('/orgs', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  getOrg: (name: string, apiKey: string) => request<OrgDetailsResponse>(`/orgs/${encodeURIComponent(name)}`, {
    headers: withApiKey(apiKey),
  }),
  createOrgAgent: (name: string, apiKey: string, input: OrgAgentCreateInput) => request<OrgAgentResponse>(`/orgs/${encodeURIComponent(name)}/agents`, {
    method: 'POST',
    headers: withApiKey(apiKey),
    body: JSON.stringify(input),
  }),
}

export function connectIntentFeed(options: {
  onMessage: (message: IntentFeedMessage) => void
  onOpen?: () => void
  onClose?: () => void
  onError?: () => void
}): WebSocket {
  const socket = new WebSocket(`${DIRECTORY_WS_URL}/ws?feed=intents`)

  socket.addEventListener('open', () => options.onOpen?.())
  socket.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(event.data) as IntentFeedMessage
      options.onMessage(parsed)
    } catch {
      options.onError?.()
    }
  })
  socket.addEventListener('close', () => options.onClose?.())
  socket.addEventListener('error', () => options.onError?.())

  return socket
}

export { ApiError }
