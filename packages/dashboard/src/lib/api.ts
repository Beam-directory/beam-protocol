export type VerificationTier = 'basic' | 'verified' | 'business' | 'enterprise'
export type AlertSeverity = 'info' | 'warning' | 'critical'
export type ExportDataset = 'intents' | 'audit' | 'errors' | 'federation' | 'alerts'
export type ExportFormat = 'json' | 'csv' | 'ndjson'
export type IntentLifecycleStatus = 'received' | 'validated' | 'queued' | 'dispatched' | 'delivered' | 'acked' | 'failed' | 'dead_letter'
export type AlertMetricUnit = 'ratio' | 'ms' | 'count'
export type AlertLinkSurface = 'trace' | 'intents' | 'audit' | 'errors' | 'federation' | 'alerts'
export type BetaRequestStatus = 'new' | 'reviewing' | 'contacted' | 'scheduled' | 'active' | 'closed'
export type BetaRequestAttention = 'unowned' | 'stale'
export type BetaRequestExportFormat = 'json' | 'csv'
export type OperatorNotificationStatus = 'new' | 'acknowledged' | 'acted'
export type OperatorNotificationSource = 'beta_request' | 'critical_alert'

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
  uptimeSeconds?: number
  version?: string
  gitSha?: string | null
  deployedAt?: string
  release?: DirectoryReleaseInfo
}

export interface DirectoryReleaseInfo {
  version: string
  gitSha: string | null
  gitShaShort: string | null
  deployedAt: string
}

export interface RootStatsResponse {
  agents: number
  intentsProcessed: number
  uptime: number
  waitlistSize: number
  version: string
  gitSha?: string | null
  deployedAt?: string
  release?: DirectoryReleaseInfo
}

export interface BusHealth {
  status: string
  service: string
}

export interface BusStats {
  total: number
  queued: number
  received: number
  dispatched: number
  delivered: number
  acked: number
  failed: number
  dead_letter: number
  by_agent: Record<string, { sent: number; received: number }>
  last_24h: number
}

export interface DeadLetterMessage {
  id: string
  nonce: string
  sender: string
  recipient: string
  intent: string
  payload: Record<string, unknown>
  status: IntentLifecycleStatus
  priority: number
  retry_count: number
  max_retries: number
  next_retry_at: number | null
  created_at: number
  delivered_at: number | null
  acked_at: number | null
  failed_at: number | null
  error: string | null
  response: Record<string, unknown> | null
  trace_id: string | null
  metadata: Record<string, unknown> | null
}

export interface DeadLetterResponse {
  messages: DeadLetterMessage[]
  count: number
}

export interface RequeueDeadLetterResponse {
  message_id: string
  nonce: string
  status: IntentLifecycleStatus
  requeued: boolean
  retry_count?: number
  next_retry_at?: number
  error?: string
  error_code?: string
}

export interface RecentIntent {
  nonce: string
  from: string
  to: string
  intentType: string
  timestamp: string
  completedAt: string | null
  roundTripLatencyMs: number | null
  status: IntentLifecycleStatus
  errorCode: string | null
}

export interface RecentIntentsResponse {
  intents: RecentIntent[]
  total: number
}

export interface IntentTraceStage {
  id: number
  nonce: string
  from: string
  to: string
  intentType: string
  stage: IntentLifecycleStatus
  status: IntentLifecycleStatus
  timestamp: string
  details: Record<string, unknown> | null
}

export interface AuditEntry {
  id: number
  action: string
  actor: string
  target: string
  timestamp: string
  details: Record<string, unknown> | null
}

export interface ShieldAuditEntry {
  id: number
  nonce: string | null
  timestamp: string | null
  senderBeamId: string | null
  senderTrust: number | null
  intentType: string | null
  payloadHash: string | null
  decision: string | null
  riskScore: number | null
  responseSize: number | null
  anomalyFlags: string[]
  createdAt: string
}

export interface AlertItem {
  id: string
  severity: AlertSeverity
  title: string
  scope: 'network' | 'agent' | 'federation' | 'shield'
  message: string
  metric: string
  value: number
  threshold: number
  valueUnit: AlertMetricUnit
  startedAt: string
  thresholdExplanation: string
  severityReason: string
  links: AlertLink[]
  sampleTraces: AlertTraceSample[]
  notificationId?: number | null
  notificationStatus?: OperatorNotificationStatus | null
}

export interface AlertLink {
  label: string
  href: string
  surface: AlertLinkSurface
}

export interface AlertTraceSample {
  nonce: string
  from: string
  to: string
  intentType: string
  requestedAt: string
  status: IntentLifecycleStatus
  errorCode: string | null
}

export interface OverviewTimelinePoint {
  bucketStart: string
  total: number
  success: number
  error: number
  inFlight: number
  p95LatencyMs: number | null
}

export interface ObservabilityOverview {
  windowHours: number
  summary: {
    totalAgents: number
    liveAgents: number
    staleAgents: number
    federatedAgents: number
    federationPeers: number
    totalIntents: number
    successCount: number
    errorCount: number
    inFlightCount: number
    avgLatencyMs: number | null
    p95LatencyMs: number | null
    successRate: number
    inFlightOlderThan15m: number
  }
  timeline: OverviewTimelinePoint[]
  topIntents: Array<{
    intentType: string
    total: number
    errors: number
    avgLatencyMs: number | null
  }>
  topErrors: Array<{
    errorCode: string
    count: number
    lastSeenAt: string
  }>
  alerts: AlertItem[]
}

export interface IntentTraceResponse {
  intent: RecentIntent
  stages: IntentTraceStage[]
  audit: AuditEntry[]
  shield: ShieldAuditEntry[]
}

export interface AuditResponse {
  entries: AuditEntry[]
  total: number
}

export interface AgentHealthResponse {
  beamId: string
  windowHours: number
  summary: {
    beamId: string
    displayName: string
    trustScore: number
    verificationTier: VerificationTier
    lastSeen: string
    sentCount: number
    receivedCount: number
    completedCount: number
    successRate: number
    errorRate: number
    avgLatencyMs: number | null
    p95LatencyMs: number | null
    uniqueCounterparties: number
  }
  timeline: Array<{
    bucketStart: string
    sent: number
    received: number
    success: number
    error: number
    p95LatencyMs: number | null
  }>
  counterparties: Array<{
    beamId: string
    outbound: number
    inbound: number
    errors: number
  }>
  intents: Array<{
    intentType: string
    total: number
    errors: number
    avgLatencyMs: number | null
  }>
  errors: Array<{
    errorCode: string
    count: number
    lastSeenAt: string
  }>
  usage: {
    period: string
    intentCount: number
    encryptedCount: number
    directCount: number
    relayedCount: number
  }
  shield: {
    total: number
    passed: number
    held: number
    rejected: number
    highRiskCount: number
  }
}

export interface FederationHealthResponse {
  summary: {
    peerCount: number
    activePeers: number
    stalePeers: number
    cachedAgents: number
    trustAssertions: number
    avgPeerTrust: number
  }
  peers: Array<{
    id: number
    directoryUrl: string
    trustLevel: number
    status: string
    createdAt: string
    lastSeen: string | null
    syncedAt: string | null
    cachedAgents: number
    lastCachedAt: string | null
    trustAssertions: number
    avgEffectiveTrust: number | null
    lastAssertedAt: string | null
    stale: boolean
  }>
  agents: Array<{
    beamId: string
    directoryUrl: string
    cachedAt: string
    ttl: number
    effectiveTrust: number | null
  }>
}

export interface ErrorAnalyticsResponse {
  windowHours: number
  summary: {
    totalErrors: number
    distinctErrorCodes: number
    timeoutCount: number
    offlineCount: number
    deliveryFailedCount: number
  }
  timeline: Array<{
    bucketStart: string
    total: number
  }>
  codes: Array<{
    errorCode: string
    count: number
    lastSeenAt: string
    avgLatencyMs: number | null
    affectedSenders: number
    affectedRecipients: number
  }>
  routes: Array<{
    route: string
    count: number
  }>
}

export interface AlertsResponse {
  windowHours: number
  generatedAt: string
  alerts: AlertItem[]
  retention: {
    defaultDays: number
    minimumDays: number
    confirmPhrasePrefix: string
    datasets: string[]
    details: ObservabilityDatasetInfo[]
  }
  exports: ExportCatalogEntry[]
}

export interface RetentionResponse {
  defaultDays: number
  minimumDays: number
  confirmPhrasePrefix: string
  datasets: string[]
  details: ObservabilityDatasetInfo[]
}

export interface PruneResponse {
  dataset: string
  olderThanDays: number
  deleted: number
  intents?: number
  traces?: number
}

export interface PrunePreviewResponse {
  dataset: string
  olderThanDays: number
  wouldDelete: number
  intents?: number
  traces?: number
}

export interface ObservabilityDatasetInfo {
  name: string
  description: string
  cascadesTo?: string[]
}

export interface ExportCatalogEntry {
  dataset: string
  formats: string[]
  description: string
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
  workflowType?: string
  workflowSummary?: string
}

export interface WaitlistSignupResponse {
  ok: boolean
  status: 'registered' | 'already_registered'
  request: BetaRequest
  nextStep: string
}

export interface BetaRequest {
  id: number
  email: string
  source: string | null
  company: string | null
  agentCount: number | null
  workflowType: string | null
  workflowSummary: string | null
  requestStatus: BetaRequestStatus
  stage: BetaRequestStatus
  owner: string | null
  operatorNotes: string | null
  nextAction: string | null
  lastContactAt: string | null
  stale: boolean
  staleReason: string | null
  attentionFlags: BetaRequestAttention[]
  notificationId: number | null
  notificationStatus: OperatorNotificationStatus | null
  createdAt: string
  updatedAt: string
}

export type WaitlistEntry = BetaRequest

export interface WaitlistListResponse {
  waitlist: BetaRequest[]
  signups?: BetaRequest[]
  requests?: BetaRequest[]
  total: number
  summary?: BetaRequestSummary
}

export interface BetaRequestSummary {
  total: number
  active: number
  unowned: number
  stale: number
  needsAttention: number
  byStatus: Record<BetaRequestStatus, number>
}

export interface BetaRequestListResponse {
  requests: BetaRequest[]
  total: number
  summary: BetaRequestSummary
}

export interface BetaRequestDetailResponse {
  request: BetaRequest
}

export interface BetaRequestUpdateInput {
  status?: BetaRequestStatus
  owner?: string | null
  operatorNotes?: string | null
  nextAction?: string | null
  lastContactAt?: string | null
}

export interface BetaRequestUpdateResponse {
  ok: boolean
  request: BetaRequest
}

export interface OperatorNotification {
  id: number
  sourceType: OperatorNotificationSource
  sourceKey: string
  betaRequestId: number | null
  alertId: string | null
  severity: AlertSeverity
  title: string
  message: string
  href: string | null
  status: OperatorNotificationStatus
  createdAt: string
  updatedAt: string
  acknowledgedAt: string | null
  actedAt: string | null
  actor: string | null
  details: Record<string, unknown> | null
}

export interface OperatorNotificationSummary {
  total: number
  byStatus: Record<OperatorNotificationStatus, number>
  bySource: Record<OperatorNotificationSource, number>
}

export interface OperatorNotificationListResponse {
  notifications: OperatorNotification[]
  total: number
  summary: OperatorNotificationSummary
}

export interface OperatorNotificationUpdateResponse {
  ok: boolean
  notification: OperatorNotification
}

export interface IntentFeedMessage {
  type: 'feed_connected' | 'intent_feed'
  entry?: RecentIntent
}

export interface ExportDownload {
  blob: Blob
  filename: string
}

export type AdminRole = 'admin' | 'operator' | 'viewer'

export interface AdminSessionInfo {
  email: string
  role: AdminRole
  expiresAt: string
  token?: string
}

export interface AdminAuthConfig {
  configured: boolean
  emailDelivery: boolean
  localDevMagicLinks: boolean
  sessionTtlSeconds: number
}

export interface AdminMagicLinkResponse {
  ok: boolean
  email: string
  role: AdminRole
  expiresAt: string
  dev: boolean
  url?: string
  token?: string
}

const DEFAULT_DIRECTORY_URL = 'https://api.beam.directory'
const ADMIN_SESSION_STORAGE = 'beam-dashboard-admin-session-token'
const DEFAULT_BUS_URL = (import.meta.env.VITE_BEAM_BUS_URL || 'http://localhost:8420').replace(/\/$/, '')
const BUS_URL_STORAGE = 'beam-dashboard-bus-url'
const BUS_API_KEY_STORAGE = 'beam-dashboard-bus-api-key'

export const DIRECTORY_URL = (import.meta.env.VITE_API_URL || DEFAULT_DIRECTORY_URL).replace(/\/$/, '')
export const DIRECTORY_WS_URL = DIRECTORY_URL.replace(/^http/, 'ws')
export const BUS_DEFAULT_URL = DEFAULT_BUS_URL

export class ApiError extends Error {
  status: number
  errorCode?: string

  constructor(message: string, status: number, errorCode?: string) {
    super(message)
    this.status = status
    this.errorCode = errorCode
  }
}

export function getStoredAdminSessionToken(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(ADMIN_SESSION_STORAGE) ?? ''
}

export function setStoredAdminSessionToken(value: string): void {
  if (typeof window === 'undefined') {
    return
  }

  const trimmed = value.trim()
  if (trimmed) {
    window.localStorage.setItem(ADMIN_SESSION_STORAGE, trimmed)
  } else {
    window.localStorage.removeItem(ADMIN_SESSION_STORAGE)
  }
}

export function clearStoredAdminSessionToken(): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(ADMIN_SESSION_STORAGE)
}

export function hasStoredAdminSessionToken(): boolean {
  return getStoredAdminSessionToken().length > 0
}

export function getStoredBusUrl(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(BUS_URL_STORAGE) ?? ''
}

export function setStoredBusUrl(value: string): void {
  if (typeof window === 'undefined') {
    return
  }

  const trimmed = value.trim().replace(/\/$/, '')
  if (trimmed) {
    window.localStorage.setItem(BUS_URL_STORAGE, trimmed)
  } else {
    window.localStorage.removeItem(BUS_URL_STORAGE)
  }
}

export function getBusBaseUrl(): string {
  return getStoredBusUrl() || DEFAULT_BUS_URL
}

export function getStoredBusApiKey(): string {
  if (typeof window === 'undefined') {
    return ''
  }

  return window.localStorage.getItem(BUS_API_KEY_STORAGE) ?? ''
}

export function setStoredBusApiKey(value: string): void {
  if (typeof window === 'undefined') {
    return
  }

  const trimmed = value.trim()
  if (trimmed) {
    window.localStorage.setItem(BUS_API_KEY_STORAGE, trimmed)
  } else {
    window.localStorage.removeItem(BUS_API_KEY_STORAGE)
  }
}

export function clearStoredBusConfig(): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(BUS_URL_STORAGE)
  window.localStorage.removeItem(BUS_API_KEY_STORAGE)
}

export function hasStoredBusApiKey(): boolean {
  return getStoredBusApiKey().length > 0
}

function buildHeaders(initHeaders?: HeadersInit, options?: { admin?: boolean }): Headers {
  const headers = new Headers(initHeaders ?? {})
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const sessionToken = getStoredAdminSessionToken()
  if (sessionToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${sessionToken}`)
  }

  return headers
}

async function requestRaw(path: string, init?: RequestInit, options?: { admin?: boolean }): Promise<Response> {
  const response = await fetch(`${DIRECTORY_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: buildHeaders(init?.headers, options),
  })

  if (!response.ok) {
    let payload: { error?: string; errorCode?: string } | null = null
    try {
      payload = await response.clone().json()
    } catch {
      payload = null
    }

    throw new ApiError(payload?.error ?? `Request failed with ${response.status}`, response.status, payload?.errorCode)
  }

  return response
}

async function request<T>(path: string, init?: RequestInit, options?: { admin?: boolean }): Promise<T> {
  const response = await requestRaw(path, init, options)
  return response.json() as Promise<T>
}

function buildBusHeaders(initHeaders?: HeadersInit): Headers {
  const headers = new Headers(initHeaders ?? {})
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const apiKey = getStoredBusApiKey()
  if (apiKey) {
    headers.set('Authorization', `Bearer ${apiKey}`)
  }

  return headers
}

async function requestBusRaw(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${getBusBaseUrl()}${path}`, {
    ...init,
    headers: buildBusHeaders(init?.headers),
  })

  if (!response.ok) {
    let payload: { error?: string; errorCode?: string } | null = null
    try {
      payload = await response.clone().json()
    } catch {
      payload = null
    }

    throw new ApiError(payload?.error ?? `Bus request failed with ${response.status}`, response.status, payload?.errorCode)
  }

  return response
}

async function requestBus<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await requestBusRaw(path, init)
  return response.json() as Promise<T>
}

function withApiKey(apiKey?: string): HeadersInit | undefined {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue
    }
    query.set(key, String(value))
  }

  const serialized = query.toString()
  return serialized ? `?${serialized}` : ''
}

function getFilenameFromResponse(response: Response, dataset: string, format: ExportFormat): string {
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = disposition.match(/filename="([^"]+)"/i)
  return match?.[1] ?? `beam-${dataset}.${format}`
}

export const directoryApi = {
  getHealth: () => request<DirectoryHealth>('/health'),
  getRootStats: () => request<RootStatsResponse>('/stats'),
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
  listWaitlist: () => request<WaitlistListResponse>('/waitlist', undefined, { admin: true }),
  listBetaRequests: (params?: {
    q?: string
    status?: BetaRequestStatus
    owner?: string
    source?: string
    workflowType?: string
    attention?: BetaRequestAttention
    sort?: 'attention' | 'updated_desc' | 'created_desc' | 'stage' | 'owner' | 'last_contact_desc'
    limit?: number
  }) => request<BetaRequestListResponse>(`/admin/beta-requests${buildQuery({
    q: params?.q,
    status: params?.status,
    owner: params?.owner,
    source: params?.source,
    workflowType: params?.workflowType,
    attention: params?.attention,
    sort: params?.sort,
    limit: params?.limit,
  })}`, undefined, { admin: true }),
  getBetaRequest: (id: number) => request<BetaRequestDetailResponse>(`/admin/beta-requests/${id}`, undefined, { admin: true }),
  updateBetaRequest: (id: number, input: BetaRequestUpdateInput) => request<BetaRequestUpdateResponse>(`/admin/beta-requests/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, { admin: true }),
  downloadBetaRequestsExport: async (format: BetaRequestExportFormat, params?: {
    q?: string
    status?: BetaRequestStatus
    owner?: string
    source?: string
    workflowType?: string
    attention?: BetaRequestAttention
    sort?: 'attention' | 'updated_desc' | 'created_desc' | 'stage' | 'owner' | 'last_contact_desc'
    limit?: number
  }): Promise<ExportDownload> => {
    const response = await requestRaw(`/admin/beta-requests/export${buildQuery({
      format,
      q: params?.q,
      status: params?.status,
      owner: params?.owner,
      source: params?.source,
      workflowType: params?.workflowType,
      attention: params?.attention,
      sort: params?.sort,
      limit: params?.limit,
    })}`, undefined, { admin: true })

    return {
      blob: await response.blob(),
      filename: getFilenameFromResponse(response, 'beta-requests', format),
    }
  },
  listOperatorNotifications: (params?: {
    q?: string
    status?: OperatorNotificationStatus
    source?: OperatorNotificationSource
    limit?: number
    hours?: number
  }) => request<OperatorNotificationListResponse>(`/admin/operator-notifications${buildQuery({
    q: params?.q,
    status: params?.status,
    source: params?.source,
    limit: params?.limit,
    hours: params?.hours,
  })}`, undefined, { admin: true }),
  updateOperatorNotification: (id: number, input: {
    status: OperatorNotificationStatus
  }) => request<OperatorNotificationUpdateResponse>(`/admin/operator-notifications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, { admin: true }),
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
  getObservabilityOverview: (hours = 24) => request<ObservabilityOverview>(`/observability/overview?hours=${hours}`, undefined, { admin: true }),
  searchObservabilityIntents: (params?: {
    q?: string
    from?: string
    to?: string
    intentType?: string
    status?: string
    errorCode?: string
    limit?: number
    hours?: number
  }) => request<RecentIntentsResponse>(`/observability/intents${buildQuery({
    q: params?.q,
    from: params?.from,
    to: params?.to,
    intentType: params?.intentType,
    status: params?.status,
    errorCode: params?.errorCode,
    limit: params?.limit,
    hours: params?.hours,
  })}`, undefined, { admin: true }),
  getIntentTrace: (nonce: string) => request<IntentTraceResponse>(`/observability/intents/${encodeURIComponent(nonce)}`, undefined, { admin: true }),
  getAuditLog: (params?: {
    q?: string
    action?: string
    actor?: string
    target?: string
    limit?: number
    hours?: number
  }) => request<AuditResponse>(`/observability/audit${buildQuery({
    q: params?.q,
    action: params?.action,
    actor: params?.actor,
    target: params?.target,
    limit: params?.limit,
    hours: params?.hours,
  })}`, undefined, { admin: true }),
  getAgentHealth: (beamId: string, hours = 24 * 7) => request<AgentHealthResponse>(`/observability/agents/${encodeURIComponent(beamId)}/health?hours=${hours}`, undefined, { admin: true }),
  getFederationHealth: () => request<FederationHealthResponse>('/observability/federation', undefined, { admin: true }),
  getErrorAnalytics: (hours = 24 * 7) => request<ErrorAnalyticsResponse>(`/observability/errors?hours=${hours}`, undefined, { admin: true }),
  getAlerts: (hours = 24) => request<AlertsResponse>(`/observability/alerts?hours=${hours}`, undefined, { admin: true }),
  getRetention: () => request<RetentionResponse>('/observability/retention', undefined, { admin: true }),
  previewPruneObservability: (dataset: string, olderThanDays: number) => request<PrunePreviewResponse>(`/observability/prune-preview${buildQuery({
    dataset,
    olderThanDays,
  })}`, undefined, { admin: true }),
  pruneObservability: (
    dataset: string,
    olderThanDays: number,
    confirmation: { confirmDataset: string; confirmPhrase: string },
  ) => request<PruneResponse>('/observability/prune', {
    method: 'POST',
    body: JSON.stringify({ dataset, olderThanDays, ...confirmation }),
  }, { admin: true }),
  downloadObservabilityExport: async (dataset: ExportDataset, format: ExportFormat, params?: {
    hours?: number
    limit?: number
    q?: string
  }): Promise<ExportDownload> => {
    const response = await requestRaw(`/observability/export/${dataset}${buildQuery({
      format,
      hours: params?.hours,
      limit: params?.limit,
      q: params?.q,
    })}`, undefined, { admin: true })
    return {
      blob: await response.blob(),
      filename: getFilenameFromResponse(response, dataset, format),
    }
  },
}

export const adminAuthApi = {
  getConfig: () => request<AdminAuthConfig>('/admin/auth/config'),
  requestMagicLink: (email: string) => request<AdminMagicLinkResponse>('/admin/auth/magic-link', {
    method: 'POST',
    body: JSON.stringify({ email }),
  }),
  verify: (token: string) => request<AdminSessionInfo>('/admin/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ token }),
  }),
  getSession: () => request<AdminSessionInfo>('/admin/auth/session'),
  logout: () => request<{ ok: boolean }>('/admin/auth/logout', {
    method: 'POST',
  }),
}

export const busApi = {
  getHealth: () => requestBus<BusHealth>('/health'),
  getStats: () => requestBus<BusStats>('/v1/beam/stats'),
  listDeadLetters: (params?: {
    sender?: string
    recipient?: string
    intent?: string
    limit?: number
  }) => requestBus<DeadLetterResponse>(`/v1/beam/dead-letter${buildQuery({
    sender: params?.sender,
    recipient: params?.recipient,
    intent: params?.intent,
    limit: params?.limit,
  })}`),
  requeueDeadLetter: (messageId: string) => requestBus<RequeueDeadLetterResponse>(`/v1/beam/dead-letter/${encodeURIComponent(messageId)}/requeue`, {
    method: 'POST',
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
