export type VerificationTier = 'basic' | 'verified' | 'business' | 'enterprise'
export type AlertSeverity = 'info' | 'warning' | 'critical'
export type ExportDataset = 'intents' | 'audit' | 'errors' | 'federation' | 'alerts'
export type ExportFormat = 'json' | 'csv' | 'ndjson'
export type IntentLifecycleStatus = 'received' | 'validated' | 'queued' | 'dispatched' | 'delivered' | 'acked' | 'failed' | 'dead_letter'
export type AlertMetricUnit = 'ratio' | 'ms' | 'count'
export type AlertLinkSurface = 'trace' | 'intents' | 'audit' | 'errors' | 'federation' | 'alerts'
export type BetaRequestStatus = 'new' | 'reviewing' | 'contacted' | 'scheduled' | 'active' | 'closed'
export type BetaRequestAttention = 'unowned' | 'stale' | 'follow_up_due'
export type BetaRequestExportFormat = 'json' | 'csv'
export type OperatorNotificationStatus = 'new' | 'acknowledged' | 'acted'
export type OperatorNotificationSource = 'beta_request' | 'critical_alert'
export type PartnerHealthStatus = 'healthy' | 'watch' | 'critical'
export type WorkspaceStatus = 'active' | 'paused' | 'archived'
export type WorkspaceThreadScope = 'internal' | 'handoff'
export type WorkspaceBindingType = 'agent' | 'service' | 'partner'
export type WorkspaceBindingStatus = 'active' | 'paused'
export type WorkspaceIdentityLifecycleStatus = 'healthy' | 'stale' | 'paused' | 'missing' | 'revoked' | 'unowned'
export type WorkspacePrincipalType = 'human' | 'agent' | 'service' | 'partner'
export type WorkspaceThreadKind = 'internal' | 'handoff'
export type WorkspaceThreadStatus = 'open' | 'blocked' | 'closed'
export type WorkspaceThreadParticipantRole = 'owner' | 'participant' | 'observer' | 'approver'
export type WorkspacePartnerChannelStatus = 'active' | 'trial' | 'blocked'
export type WorkspacePartnerChannelHealth = 'healthy' | 'watch' | 'critical'
export type WorkspaceTimelineEventKind = 'workspace' | 'policy' | 'identity' | 'partner_channel' | 'thread' | 'digest'
export type WorkspacePolicyDefaultExternalInitiation = 'binding' | 'deny'
export type WorkspacePolicyRuleExternalInitiation = 'inherit' | 'allow' | 'deny'
export type OpenClawHostStatus = 'pending' | 'active' | 'revoked'
export type OpenClawHostHealth = 'pending' | 'healthy' | 'watch' | 'stale' | 'revoked'
export type OpenClawHostCredentialState = 'missing' | 'ready' | 'rotation_pending' | 'recovery_pending' | 'revoked'
export type OpenClawHostEnrollmentStatus = 'issued' | 'pending' | 'approved' | 'revoked' | 'expired'
export type OpenClawRouteSource = 'agent-folder' | 'workspace-agent' | 'gateway-agent' | 'subagent-run'
export type OpenClawRouteReportedState = 'live' | 'idle' | 'ended'
export type OpenClawRouteRuntimeState = 'live' | 'idle' | 'stale' | 'ended' | 'conflict' | 'revoked'
export type OpenClawRouteOwnerResolutionState = 'implicit' | 'preferred' | 'disabled'
export type OpenClawHostRotationReviewState = 'scheduled' | 'due_soon' | 'overdue'
export type OpenClawHostRecoveryRunbookState = 'idle' | 'prepared' | 'cutover_pending' | 'completed'
export type WorkspaceOverviewAttentionCode =
  | 'identity_missing'
  | 'stale_check_in'
  | 'binding_paused'
  | 'workspace_handoffs_disabled'
  | 'manual_review_required'
export type WorkspaceOverviewHandoffDirection = 'outbound' | 'inbound'

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

export interface WorkspaceRecord {
  id: number
  slug: string
  name: string
  orgName: string | null
  description: string | null
  status: WorkspaceStatus
  defaultThreadScope: WorkspaceThreadScope
  externalHandoffsEnabled: boolean
  createdAt: string
  updatedAt: string
  summary: {
    identities: number
    externalInitiators: number
    members: number
    partnerChannels: number
  }
  policyConfigured: boolean
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceRecord[]
  total: number
}

export interface WorkspaceIdentityBinding {
  id: number
  workspaceId: number
  beamId: string
  bindingType: WorkspaceBindingType
  owner: string | null
  runtimeType: string | null
  policyProfile: string | null
  defaultThreadScope: WorkspaceThreadScope
  canInitiateExternal: boolean
  status: WorkspaceBindingStatus
  notes: string | null
  createdAt: string
  updatedAt: string
  lastSeenAgeHours: number | null
  ownershipState: 'owned' | 'unowned'
  lifecycleStatus: WorkspaceIdentityLifecycleStatus
  runtime: {
    mode: 'runtime-backed' | 'service' | 'partner' | 'manual'
    connector: string | null
    label: string | null
    connected: boolean
    httpEndpoint: string | null
    deliveryMode: 'websocket' | 'http' | 'hybrid' | 'unavailable' | null
  }
  lastDelivery: OpenClawRouteDelivery | null
  hostId: number | null
  hostLabel: string | null
  hostHealth: OpenClawHostHealth | 'conflict' | null
  routeSource: OpenClawRouteSource | null
  runtimeSessionState: OpenClawRouteRuntimeState | null
  identity: {
    existsLocally: boolean
    beamId: string
    did: {
      id: string
      resolutionUrl: string
      agentUrl: string
      keysUrl: string
    }
    displayName: string | null
    org: string | null
    personal: boolean
    verificationTier: string | null
    trustScore: number | null
    lastSeen: string | null
    capabilities: string[]
    keyState: {
      active: {
        id: number
        beamId: string
        publicKey: string
        createdAt: number
        revokedAt: number | null
        status: 'active' | 'revoked'
      } | null
      revoked: Array<{
        id: number
        beamId: string
        publicKey: string
        createdAt: number
        revokedAt: number | null
        status: 'active' | 'revoked'
      }>
      keys: Array<{
        id: number
        beamId: string
        publicKey: string
        createdAt: number
        revokedAt: number | null
        status: 'active' | 'revoked'
      }>
      total: number
    } | null
  }
  workspacePolicy: {
    effective: WorkspacePolicyPreview
    bindingRule: {
      externalInitiation: WorkspacePolicyRuleExternalInitiation
      allowedPartners: string[]
    } | null
  }
}

export interface OpenClawEnrollmentRequest {
  id: number
  label: string | null
  workspaceSlug: string | null
  notes: string | null
  status: OpenClawHostEnrollmentStatus
  claimedHostId: number | null
  claimedAt: string | null
  approvedAt: string | null
  approvedBy: string | null
  revokedAt: string | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  token?: string
  installPack?: OpenClawInstallPack
}

export interface OpenClawInstallPack {
  directoryUrl: string
  workspaceSlug: string
  commands: {
    managedMacos: string
    managedLinux: string
    foregroundDebug: string
    status: string
    uninstall: string
  }
}

export interface OpenClawRouteDelivery {
  nonce: string
  intentType: string
  status: IntentLifecycleStatus
  errorCode: string | null
  requestedAt: string
  completedAt: string | null
  latencyMs: number | null
  href: string
}

export interface OpenClawHostRoute {
  id: number
  beamId: string
  workspaceSlug: string | null
  workspace: {
    id: number
    slug: string
    name: string
  } | null
  routeSource: OpenClawRouteSource
  routeKey: string
  runtimeType: string | null
  label: string | null
  displayName: string | null
  connectionMode: 'websocket' | 'http' | 'hybrid' | 'unavailable' | null
  httpEndpoint: string | null
  sessionKey: string | null
  reportedState: OpenClawRouteReportedState
  runtimeSessionState: OpenClawRouteRuntimeState
  ownerResolutionState: OpenClawRouteOwnerResolutionState
  ownerResolutionActor: string | null
  ownerResolutionAt: string | null
  ownerResolutionNote: string | null
  hostId: number
  hostLabel: string | null
  hostHealth: OpenClawHostHealth
  hostCredentialState: OpenClawHostCredentialState
  metadata: Record<string, unknown> | null
  lastSeenAt: string | null
  endedAt: string | null
  lastDelivery: OpenClawRouteDelivery | null
  createdAt: string
  updatedAt: string
  bindings: Array<{
    id: number
    workspaceId: number
    bindingType: WorkspaceBindingType
    status: WorkspaceBindingStatus
    owner: string | null
    runtimeType: string | null
  }>
}

export interface OpenClawHostSummary {
  id: number
  hostKey: string
  label: string | null
  hostname: string
  os: string
  connectorVersion: string
  beamDirectoryUrl: string
  workspaceSlug: string | null
  status: OpenClawHostStatus
  healthStatus: OpenClawHostHealth
  credentialState: OpenClawHostCredentialState
  credentialIssuedAt: string | null
  credentialRotatedAt: string | null
  credentialAgeHours: number | null
  recoveryCompletedAt: string | null
  routeCount: number
  approvedAt: string | null
  approvedBy: string | null
  revokedAt: string | null
  revocationReason: string | null
  lastHeartbeatAt: string | null
  lastHeartbeatAgeHours: number | null
  lastInventoryAt: string | null
  lastRouteEventAt: string | null
  createdAt: string
  updatedAt: string
  policy: {
    rotation: {
      intervalHours: number
      windowStartHour: number
      windowDurationHours: number
      nextRotationDueAt: string | null
      nextRotationWindowStartsAt: string | null
      nextRotationWindowEndsAt: string | null
      dueInHours: number | null
      reviewState: OpenClawHostRotationReviewState
    }
    recovery: {
      owner: string | null
      status: OpenClawHostRecoveryRunbookState
      notes: string | null
      replacementHostLabel: string | null
      windowStartsAt: string | null
      windowEndsAt: string | null
      updatedAt: string | null
    }
  }
  enrollment: OpenClawEnrollmentRequest | null
  summary: {
    total: number
    live: number
    idle: number
    stale: number
    conflict: number
    ended: number
    revoked: number
    unavailable: number
    delivery: {
      receipts: number
      failed: number
      lastRequestedAt: string | null
      lastStatus: IntentLifecycleStatus | null
      lastErrorCode: string | null
      lastHref: string | null
      coverage: {
        activeRoutes: number
        routesWithReceipts: number
        missingReceipts: number
        ratio: number | null
      }
      latency: {
        targetMs: number
        samples: number
        avgMs: number | null
        p50Ms: number | null
        p95Ms: number | null
        overSlo: number
        degraded: boolean
      }
    }
  }
}

export interface OpenClawConflictGroup {
  beamId: string
  routeCount: number
  routes: Array<{
    routeId: number
    hostId: number
    hostLabel: string | null
    hostname: string
    workspaceSlug: string | null
    routeKey: string
    routeSource: OpenClawRouteSource
    ownerResolutionState: OpenClawRouteOwnerResolutionState
  }>
}

export interface OpenClawFleetOverviewResponse {
  summary: {
    totalHosts: number
    pendingHosts: number
    activeHosts: number
    revokedHosts: number
    staleHosts: number
    liveRoutes: number
    staleRoutes: number
    conflictRoutes: number
    endedRoutes: number
    failedReceipts: number
    routesMissingReceipts: number
    receiptCoverageRatio: number | null
    degradedHosts: number
    latencySloBreaches: number
    rotationDueHosts: number
    recoveryRunbooksOpen: number
    duplicateIdentityConflicts: number
    pendingCredentialActions: number
    actionItems: number
    criticalItems: number
  }
  hosts: OpenClawHostSummary[]
  conflicts: OpenClawConflictGroup[]
}

export interface OpenClawFleetDigestItem {
  id: string
  severity: 'warning' | 'critical'
  category: 'host' | 'credential' | 'conflict' | 'delivery'
  title: string
  detail: string
  nextAction: string
  hostId: number | null
  hostLabel: string | null
  workspaceSlug: string | null
  href: string | null
  traceHref: string | null
}

export interface OpenClawFleetDigestResponse {
  generatedAt: string
  summary: {
    totalHosts: number
    activeHosts: number
    pendingHosts: number
    revokedHosts: number
    staleHosts: number
    liveRoutes: number
    staleRoutes: number
    failedReceipts: number
    routesMissingReceipts: number
    receiptCoverageRatio: number | null
    degradedHosts: number
    latencySloBreaches: number
    rotationDueHosts: number
    recoveryRunbooksOpen: number
    duplicateIdentityConflicts: number
    pendingCredentialActions: number
    actionItems: number
    criticalItems: number
    warningItems: number
  }
  actionItems: OpenClawFleetDigestItem[]
  markdown: string
}

export interface OpenClawHostsResponse {
  hosts: OpenClawHostSummary[]
  total: number
}

export interface OpenClawHostRoutesResponse {
  host: OpenClawHostSummary
  routes: OpenClawHostRoute[]
  total: number
}

export interface OpenClawHostIdentitiesResponse {
  host: OpenClawHostSummary
  identities: Array<{
    beamId: string
    displayName: string | null
    org: string | null
    route: OpenClawHostRoute
    bindings: Array<{
      id: number
      workspaceId: number
      workspaceSlug: string | null
      workspaceName: string | null
      bindingType: WorkspaceBindingType
      status: WorkspaceBindingStatus
      owner: string | null
      runtimeType: string | null
    }>
  }>
  total: number
}

export interface OpenClawHostDetailResponse {
  host: OpenClawHostSummary
  routes: OpenClawHostRoute[]
  heartbeats: Array<{
    id: number
    routeCount: number
    connectorVersion: string | null
    healthStatus: OpenClawHostHealth
    details: Record<string, unknown> | null
    heartbeatAt: string
  }>
}

export interface OpenClawEnrollmentCreateInput {
  label?: string | null
  workspaceSlug?: string | null
  notes?: string | null
  expiresInHours?: number | null
}

export interface OpenClawEnrollmentCreateResponse {
  enrollment: OpenClawEnrollmentRequest
}

export interface OpenClawHostApproveResponse {
  host: OpenClawHostSummary
  credential: string
}

export interface OpenClawHostRevokeResponse {
  host: OpenClawHostSummary
}

export interface OpenClawHostCredentialActionResponse {
  host: OpenClawHostSummary
  credential: string
  installPack: {
    commands: {
      useCredential: string
      foregroundDebug: string
    }
  }
}

export interface OpenClawHostPolicyPatchInput {
  rotationIntervalHours?: number | null
  rotationWindowStartHour?: number | null
  rotationWindowDurationHours?: number | null
  recoveryOwner?: string | null
  recoveryStatus?: OpenClawHostRecoveryRunbookState | null
  recoveryNotes?: string | null
  replacementHostLabel?: string | null
  recoveryWindowStartsAt?: string | null
  recoveryWindowEndsAt?: string | null
}

export interface OpenClawHostPolicyActionResponse {
  host: OpenClawHostSummary
}

export interface OpenClawRouteActionResponse {
  route: OpenClawHostRoute | null
}

export interface OpenClawFleetDigestDeliveryResponse {
  ok: boolean
  email: string
  deliveredAt: string
  summary: OpenClawFleetDigestResponse['summary']
}

export interface WorkspaceIdentitiesResponse {
  workspace: WorkspaceRecord
  bindings: WorkspaceIdentityBinding[]
  total: number
}

export interface WorkspacePartnerChannel {
  id: number
  workspaceId: number
  partnerBeamId: string
  label: string | null
  owner: string | null
  status: WorkspacePartnerChannelStatus
  healthStatus: WorkspacePartnerChannelHealth
  notes: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastIntentNonce: string | null
  createdAt: string
  updatedAt: string
  stats: {
    recentSuccesses: number
    recentFailures: number
    totalObserved: number
  }
  partner: {
    existsLocally: boolean
    displayName: string | null
    org: string | null
    verificationTier: string | null
    trustScore: number | null
    lastSeen: string | null
  }
  workspaceRoute: {
    workspaceId: number
    workspaceSlug: string
    workspaceName: string
    bindingId: number
    bindingType: WorkspaceBindingType
    bindingStatus: WorkspaceBindingStatus
    displayName: string | null
    runtimeType: string | null
    runtime: {
      mode: 'runtime-backed' | 'service' | 'partner' | 'manual'
      connector: string | null
      label: string | null
      connected: boolean
      httpEndpoint: string | null
      deliveryMode: 'websocket' | 'http' | 'hybrid' | 'unavailable' | null
    }
  } | null
  trace: {
    nonce: string
    status: IntentLifecycleStatus
    intentType: string
    requestedAt: string
    completedAt: string | null
    errorCode: string | null
    href: string
  } | null
}

export interface WorkspacePartnerChannelsResponse {
  workspace: WorkspaceRecord
  channels: WorkspacePartnerChannel[]
  total: number
}

export interface WorkspaceTimelineEntry {
  id: number
  kind: WorkspaceTimelineEventKind
  action: string
  actor: string
  target: string
  timestamp: string
  summary: string
  details: Record<string, unknown> | null
  href: string | null
  traceHref: string | null
}

export interface WorkspaceTimelineResponse {
  workspace: WorkspaceRecord
  entries: WorkspaceTimelineEntry[]
  total: number
}

export interface WorkspaceDigestActionItem {
  id: string
  category: 'approval' | 'identity' | 'partner_channel' | 'thread'
  severity: 'warning' | 'critical'
  title: string
  detail: string
  owner: string | null
  href: string | null
  nextAction: string
}

export interface WorkspaceDigestResponse {
  workspace: WorkspaceRecord
  generatedAt: string
  days: number
  summary: {
    actionItems: number
    escalations: number
    partnerChannels: number
    openThreads: number
    staleIdentities: number
    blockedExternalMotion: number
  }
  actionItems: WorkspaceDigestActionItem[]
  escalations: WorkspaceDigestActionItem[]
  partnerChannels: WorkspacePartnerChannel[]
  timeline: WorkspaceTimelineEntry[]
  markdown: string
}

export interface WorkspaceOverviewAttentionItem {
  binding: WorkspaceIdentityBinding
  reasonCode: WorkspaceOverviewAttentionCode
  reason: string
  lastSeenAgeHours: number | null
}

export interface WorkspaceOverviewHandoff {
  nonce: string
  intentType: string
  status: IntentLifecycleStatus
  requestedAt: string
  completedAt: string | null
  latencyMs: number | null
  errorCode: string | null
  direction: WorkspaceOverviewHandoffDirection
  fromBeamId: string
  toBeamId: string
  workspaceSide: {
    beamId: string
    displayName: string | null
    bindingType: WorkspaceBindingType | null
  }
  counterparty: {
    beamId: string
    displayName: string | null
    bindingType: WorkspaceBindingType | null
    inWorkspace: boolean
  }
}

export interface WorkspaceOverviewResponse {
  workspace: WorkspaceRecord
  generatedAt: string
  staleAfterHours: number
  summary: {
    totalIdentities: number
    activeIdentities: number
    localIdentities: number
    partnerIdentities: number
    externalReadyIdentities: number
    staleIdentities: number
    pendingApprovals: number
    blockedExternalMotion: number
    recentExternalHandoffs: number
  }
  staleBindings: WorkspaceOverviewAttentionItem[]
  blockedExternalMotion: WorkspaceOverviewAttentionItem[]
  recentExternalHandoffs: WorkspaceOverviewHandoff[]
}

export interface WorkspaceThreadTrace {
  nonce: string
  status: IntentLifecycleStatus
  intentType: string
  fromBeamId: string
  toBeamId: string
  requestedAt: string
  completedAt: string | null
  latencyMs: number | null
  errorCode: string | null
  href: string
}

export interface WorkspaceThread {
  id: number
  workspaceId: number
  kind: WorkspaceThreadKind
  title: string
  summary: string | null
  owner: string | null
  status: WorkspaceThreadStatus
  workflowType: string | null
  draftIntentType: string | null
  draftPayload: Record<string, unknown> | null
  linkedIntentNonce: string | null
  lastActivityAt: string
  createdAt: string
  updatedAt: string
  participantCount: number
  trace: WorkspaceThreadTrace | null
}

export interface WorkspaceThreadParticipant {
  id: number
  threadId: number
  principalId: string
  principalType: WorkspacePrincipalType
  displayName: string | null
  beamId: string | null
  workspaceBindingId: number | null
  role: WorkspaceThreadParticipantRole
  createdAt: string
  updatedAt: string
  identity: {
    existsLocally: boolean
    displayName: string | null
    org: string | null
    verificationTier: string | null
    trustScore: number | null
    lastSeen: string | null
  } | null
}

export interface WorkspaceThreadsResponse {
  workspace: WorkspaceRecord
  threads: WorkspaceThread[]
  total: number
}

export interface WorkspaceThreadDetailResponse {
  workspace: WorkspaceRecord
  thread: WorkspaceThread
  participants: WorkspaceThreadParticipant[]
}

export interface WorkspaceThreadDispatchInput {
  intentType?: string | null
  payload?: Record<string, unknown> | null
  message?: string | null
  language?: string | null
}

export interface WorkspaceThreadDispatchResponse extends WorkspaceThreadDetailResponse {
  partnerChannel: WorkspacePartnerChannel | null
  dispatch: {
    nonce: string
    intentType: string
    success: boolean
    error: string | null
    errorCode: string | null
    traceHref: string | null
  }
  workspaceSync: {
    workspaceId: number
    workspaceSlug: string
    workspaceName: string
    threadId: number
    threadHref: string
    bindingId: number
    beamId: string
    disposition: 'created' | 'updated'
  } | null
}

export interface WorkspacePolicyBindingRule {
  beamId: string | null
  bindingType: WorkspaceBindingType | null
  policyProfile: string | null
  externalInitiation: WorkspacePolicyRuleExternalInitiation
  allowedPartners: string[]
}

export interface WorkspacePolicyWorkflowRule {
  workflowType: string
  requireApproval: boolean
  allowedPartners: string[]
  approvers: string[]
}

export interface WorkspacePolicyDocument {
  version: 1
  defaults: {
    externalInitiation: WorkspacePolicyDefaultExternalInitiation
    allowedPartners: string[]
  }
  bindingRules: WorkspacePolicyBindingRule[]
  workflowRules: WorkspacePolicyWorkflowRule[]
  metadata: {
    notes: string | null
  }
}

export interface WorkspacePolicyPreview {
  beamId: string
  bindingType: WorkspaceBindingType
  policyProfile: string | null
  externalInitiation: 'allow' | 'deny'
  allowedPartners: string[]
  approvalRequired: boolean
  approvers: string[]
  matchedBindingRules: number
  matchedWorkflowRules: number
  workflowType: string | null
}

export interface WorkspaceWorkflowPolicyPreview {
  workflowType: string
  bindings: WorkspacePolicyPreview[]
}

export interface WorkspacePolicyResponse {
  workspace: WorkspaceRecord
  policy: WorkspacePolicyDocument
  updatedAt: string | null
  updatedBy: string | null
  previews: {
    bindings: WorkspacePolicyPreview[]
    workflows: WorkspaceWorkflowPolicyPreview[]
  }
}

export type WorkspacePolicyPatchInput = Partial<WorkspacePolicyDocument>

export interface WorkspaceIdentityPatchInput {
  owner?: string | null
  runtimeType?: string | null
  policyProfile?: string | null
  defaultThreadScope?: WorkspaceThreadScope
  canInitiateExternal?: boolean
  status?: WorkspaceBindingStatus
  notes?: string | null
}

export interface WorkspaceIdentityPolicyPatchInput {
  externalInitiation?: WorkspacePolicyRuleExternalInitiation
  allowedPartners?: string[]
}

export interface WorkspaceIdentityPolicyResponse {
  workspace: WorkspaceRecord
  updatedAt: string | null
  updatedBy: string | null
  rule: {
    beamId: string | null
    bindingType: WorkspaceBindingType | null
    policyProfile: string | null
    externalInitiation: WorkspacePolicyRuleExternalInitiation
    allowedPartners: string[]
  } | null
  preview: WorkspacePolicyPreview
  binding: WorkspaceIdentityBinding
}

export interface WorkspaceIdentityCredentialBundle {
  format: 'beam-local-identity/v1'
  beamId: string
  did: string
  displayName: string | null
  workspaceSlug: string
  directoryUrl: string
  generatedAt: string
  publicKey: string
  privateKey: string
  apiKey: string
  urls: {
    didResolution: string
    agent: string
    keys: string
  }
}

export interface WorkspaceIdentityReissueResponse {
  binding: WorkspaceIdentityBinding
  credential: WorkspaceIdentityCredentialBundle
}

export interface WorkspacePartnerChannelCreateInput {
  partnerBeamId: string
  label?: string | null
  owner?: string | null
  status?: WorkspacePartnerChannelStatus
  notes?: string | null
}

export interface WorkspacePartnerChannelPatchInput {
  label?: string | null
  owner?: string | null
  status?: WorkspacePartnerChannelStatus
  notes?: string | null
  lastSuccessAt?: string | null
  lastFailureAt?: string | null
  lastIntentNonce?: string | null
}

export interface WorkspaceThreadParticipantInput {
  principalId: string
  principalType: WorkspacePrincipalType
  displayName?: string | null
  beamId?: string | null
  workspaceBindingId?: number | null
  role?: WorkspaceThreadParticipantRole
}

export interface WorkspaceThreadCreateInput {
  kind: WorkspaceThreadKind
  title: string
  summary?: string | null
  owner?: string | null
  status?: WorkspaceThreadStatus
  workflowType?: string | null
  draftIntentType?: string | null
  draftPayload?: Record<string, unknown> | null
  linkedIntentNonce?: string | null
  participants?: WorkspaceThreadParticipantInput[]
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
  relatedPartnerRequests?: AlertRelatedPartnerRequest[]
  notificationId?: number | null
  notificationStatus?: OperatorNotificationStatus | null
  notificationOwner?: string | null
  notificationNextAction?: string | null
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

export interface AlertRelatedPartnerRequest {
  id: number
  company: string | null
  workflowType: string | null
  stage: string
  href: string
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
  id: string
  description?: string
  params?: Record<string, {
    type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'integer'
    enum?: unknown[]
    required?: boolean
    description?: string
    default?: unknown
    maxLength?: number
  }>
  payload?: Record<string, {
    type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'integer'
    enum?: unknown[]
    required?: boolean
    description?: string
    default?: unknown
    maxLength?: number
  }>
  response?: Record<string, unknown>
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
  proofIntentNonce: string | null
  requestStatus: BetaRequestStatus
  stage: BetaRequestStatus
  owner: string | null
  operatorNotes: string | null
  nextAction: string | null
  lastContactAt: string | null
  nextMeetingAt: string | null
  reminderAt: string | null
  blockedPrerequisites: string[]
  stageEnteredAt: string
  stageAgeHours: number
  stageAgeLabel: string
  stale: boolean
  staleReason: string | null
  followUpDue: boolean
  followUpReason: string | null
  attentionFlags: BetaRequestAttention[]
  notificationId: number | null
  notificationStatus: OperatorNotificationStatus | null
  createdAt: string
  updatedAt: string
}

export type BetaRequestActivityKind =
  | 'request_created'
  | 'stage_changed'
  | 'request_updated'
  | 'contact_logged'
  | 'meeting_scheduled'
  | 'reminder'
  | 'notification'

export type BetaRequestActivityTone = 'default' | 'success' | 'warning'

export interface BetaRequestActivityEntry {
  key: string
  kind: BetaRequestActivityKind
  timestamp: string
  title: string
  detail: string
  actor: string | null
  tone: BetaRequestActivityTone
  href: string | null
  upcoming: boolean
}

export interface BetaRequestProofSummaryParty {
  beamId: string
  displayName: string
  verificationTier: string
  trustScore: number | null
  verified: boolean
}

export interface BetaRequestProofSummary {
  generatedAt: string
  proofIntentNonce: string
  headline: string
  summary: string
  recommendation: string
  markdown: string
  identity: {
    sender: BetaRequestProofSummaryParty
    recipient: BetaRequestProofSummaryParty
  }
  delivery: {
    intentType: string
    status: IntentLifecycleStatus
    requestedAt: string
    completedAt: string | null
    latencyMs: number | null
    traceStageCount: number
    stages: string[]
    routeLabel: string | null
    shieldDecision: string | null
  }
  operatorVisibility: {
    signalStatus: OperatorNotificationStatus | 'missing'
    signalOwner: string | null
    nextAction: string | null
    activityCount: number
    liveAgents: number
    activeAlerts: number
    traceHref: string
    signalHref: string | null
    requestHref: string
  }
}

export interface BetaRequestProofPack {
  generatedAt: string
  audience: 'external'
  request: {
    id: number
    company: string | null
    workflowType: string | null
    workflowSummary: string | null
    currentStage: BetaRequestStatus
  }
  proof: {
    headline: string
    summary: string
    recommendation: string
    proofIntentNonce: string
    intentType: string
    deliveryStatus: string
    latencyMs: number | null
    traceStages: string[]
    sender: BetaRequestProofSummaryParty
    recipient: BetaRequestProofSummaryParty
  }
  evidence: {
    releaseUrl: string
    statusUrl: string
    traceReference: string
    requestReference: string
  }
  redaction: {
    excludedFields: string[]
    notes: string[]
  }
  markdown: string
}

export interface PartnerHealthRequest {
  id: number
  email: string
  company: string | null
  workflowType: string | null
  workflowTypeLabel: string
  stage: BetaRequestStatus
  owner: string | null
  nextAction: string | null
  lastContactAt: string | null
  nextMeetingAt: string | null
  reminderAt: string | null
  proofIntentNonce: string | null
  stageAgeHours: number
  stageAgeLabel: string
  stale: boolean
  staleReason: string | null
  followUpDue: boolean
  followUpReason: string | null
  attentionFlags: BetaRequestAttention[]
  notificationId: number | null
  notificationStatus: OperatorNotificationStatus | null
  latestIntentStatus: string | null
  latestLatencyMs: number | null
  latencyBreach: boolean
  deadLetter: boolean
  incidentCount: number
  breachCount: number
  alertCount: number
  healthStatus: PartnerHealthStatus
  links: {
    requestHref: string
    traceHref: string | null
    inboxHref: string | null
    alertHref: string | null
  }
}

export interface PartnerHealthIncident {
  id: string
  severity: 'warning' | 'critical'
  title: string
  detail: string
  company: string | null
  workflowType: string | null
  owner: string | null
  requestId: number
  requestHref: string
  traceHref: string | null
  alertHref: string | null
  deadLetter: boolean
  followUpDue: boolean
}

export interface PartnerHealthWorkflowSummary {
  workflowType: string
  label: string
  requests: number
  healthy: number
  watch: number
  critical: number
  followUpDue: number
  deadLetters: number
  averageLatencyMs: number | null
}

export interface PartnerHealthOwnerSummary {
  owner: string | null
  requests: number
  critical: number
  watch: number
  healthy: number
  followUpDue: number
  nextMeetingScheduled: number
}

export interface PartnerDigestActionItem {
  requestId: number
  company: string | null
  email: string
  workflowType: string | null
  stage: BetaRequestStatus
  owner: string | null
  nextAction: string | null
  lastContactAt: string | null
  nextMeetingAt: string | null
  reminderAt: string | null
  proofIntentNonce: string | null
  reason: string
  href: string
}

export interface PartnerDigestResponse {
  generatedAt: string
  windowDays: number
  ownerFilter: string | null
  summary: {
    totalThreads: number
    ownedThreads: number
    dueNow: number
    upcomingMeetings: number
    meetingsThisWeek: number
    unownedThreads: number
  }
  actionItems: PartnerDigestActionItem[]
  markdown: string
}

export interface PartnerHealthResponse {
  generatedAt: string
  windowDays: number
  alertWindowHours: number
  slaLatencyMs: number
  summary: {
    activeRequests: number
    healthy: number
    watch: number
    critical: number
    latencyBreaches: number
    deadLetters: number
    openIncidents: number
    followUpDue: number
  }
  requests: PartnerHealthRequest[]
  workflows: PartnerHealthWorkflowSummary[]
  owners: PartnerHealthOwnerSummary[]
  incidents: PartnerHealthIncident[]
  digestPreview: {
    summary: PartnerDigestResponse['summary']
    markdown: string
  }
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
  followUpDue: number
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
  activity: BetaRequestActivityEntry[]
  proofSummary: BetaRequestProofSummary | null
}

export interface BetaRequestUpdateInput {
  status?: BetaRequestStatus
  owner?: string | null
  operatorNotes?: string | null
  nextAction?: string | null
  lastContactAt?: string | null
  nextMeetingAt?: string | null
  reminderAt?: string | null
  proofIntentNonce?: string | null
  blockedPrerequisites?: string[] | null
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
  owner: string | null
  nextAction: string | null
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

export interface FunnelEntryPage {
  pageKey: string
  events: number
  sessions: number
}

export interface FunnelCtaClick {
  ctaKey: string
  targetPage: string | null
  events: number
  sessions: number
}

export interface FunnelMilestone {
  key: string
  label: string
  sessions: number
  events: number
  conversionFromPrevious: number | null
  conversionFromLanding: number | null
}

export interface FunnelTimelinePoint {
  day: string
  landingSessions: number
  guidedSessions: number
  requestSessions: number
  demoSessions: number
}

export interface FunnelRecentEvent {
  id: number
  sessionId: string
  origin: string
  pageKey: string
  eventCategory: string
  ctaKey: string | null
  targetPage: string | null
  workflowType: string | null
  milestoneKey: string | null
  createdAt: string
}

export interface PartnerMotionStage {
  stage: BetaRequestStatus
  count: number
  averageAgeHours: number | null
  oldestAgeHours: number | null
  stale: number
  followUpDue: number
  unowned: number
  proofLinked: number
}

export interface PartnerMotionStall {
  id: number
  company: string | null
  email: string
  workflowType: string | null
  stage: BetaRequestStatus
  owner: string | null
  stageAgeHours: number
  stageAgeLabel: string
  followUpDue: boolean
  stale: boolean
  attentionFlags: BetaRequestAttention[]
  followUpReason: string | null
  staleReason: string | null
  nextAction: string | null
  lastContactAt: string | null
  nextMeetingAt: string | null
  reminderAt: string | null
  proofIntentNonce: string | null
}

export interface PartnerMotionWeeklyPoint {
  weekStart: string
  requests: number
  qualified: number
  scheduled: number
  pilotComplete: number
  nextStepReady: number
}

export interface PartnerMotionWorkflow {
  workflowType: string
  requests: number
  qualified: number
  scheduled: number
  pilotComplete: number
  overdue: number
}

export interface FunnelAnalyticsResponse {
  days: number
  generatedAt: string
  summary: {
    anonymousSessions: number
    pageViews: number
    ctaClicks: number
    requestEvents: number
    demoEvents: number
    landingSessions: number
    guidedSessions: number
    hostedBetaSessions: number
    requestSessions: number
    demoSessions: number
    landingToGuidedRate: number | null
    landingToRequestRate: number | null
    requestToDemoRate: number | null
  }
  milestones: FunnelMilestone[]
  entryPages: FunnelEntryPage[]
  ctaClicks: FunnelCtaClick[]
  demoMilestones: Array<{
    milestoneKey: string
    events: number
    sessions: number
  }>
  workflows: Array<{
    workflowType: string
    events: number
    sessions: number
  }>
  timeline: FunnelTimelinePoint[]
  recentEvents: FunnelRecentEvent[]
  partnerMotion: {
    summary: {
      requests: number
      qualified: number
      scheduled: number
      pilotComplete: number
      nextStepReady: number
      overdueFollowUps: number
      stalledRequests: number
      unowned: number
      qualificationRate: number | null
      schedulingRate: number | null
      pilotCompleteRate: number | null
      nextStepRate: number | null
    }
    byStage: PartnerMotionStage[]
    stalled: PartnerMotionStall[]
    weekly: PartnerMotionWeeklyPoint[]
    workflows: PartnerMotionWorkflow[]
  }
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
  getOpenClawFleetOverview: () => request<OpenClawFleetOverviewResponse>('/admin/openclaw/fleet/overview', undefined, { admin: true }),
  getOpenClawFleetDigest: (params?: { format?: 'json' | 'markdown' }) => request<OpenClawFleetDigestResponse>(`/admin/openclaw/fleet/digest${buildQuery({ format: params?.format })}`, undefined, { admin: true }),
  deliverOpenClawFleetDigest: (input?: { email?: string | null }) => request<OpenClawFleetDigestDeliveryResponse>('/admin/openclaw/fleet/digest/deliver', {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  }, { admin: true }),
  listOpenClawHosts: () => request<OpenClawHostsResponse>('/admin/openclaw/hosts', undefined, { admin: true }),
  getOpenClawHost: (id: number) => request<OpenClawHostDetailResponse>(`/admin/openclaw/hosts/${id}`, undefined, { admin: true }),
  getOpenClawHostRoutes: (id: number) => request<OpenClawHostRoutesResponse>(`/admin/openclaw/hosts/${id}/routes`, undefined, { admin: true }),
  getOpenClawHostIdentities: (id: number) => request<OpenClawHostIdentitiesResponse>(`/admin/openclaw/hosts/${id}/identities`, undefined, { admin: true }),
  createOpenClawEnrollment: (input: OpenClawEnrollmentCreateInput) => request<OpenClawEnrollmentCreateResponse>('/admin/openclaw/hosts/enrollment', {
    method: 'POST',
    body: JSON.stringify(input),
  }, { admin: true }),
  approveOpenClawHost: (id: number) => request<OpenClawHostApproveResponse>(`/admin/openclaw/hosts/${id}/approve`, {
    method: 'POST',
  }, { admin: true }),
  rotateOpenClawHost: (id: number) => request<OpenClawHostCredentialActionResponse>(`/admin/openclaw/hosts/${id}/rotate`, {
    method: 'POST',
  }, { admin: true }),
  recoverOpenClawHost: (id: number) => request<OpenClawHostCredentialActionResponse>(`/admin/openclaw/hosts/${id}/recover`, {
    method: 'POST',
  }, { admin: true }),
  updateOpenClawHostPolicy: (id: number, input: OpenClawHostPolicyPatchInput) => request<OpenClawHostPolicyActionResponse>(`/admin/openclaw/hosts/${id}/policy`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, { admin: true }),
  revokeOpenClawHost: (id: number, input?: { reason?: string | null }) => request<OpenClawHostRevokeResponse>(`/admin/openclaw/hosts/${id}/revoke`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  }, { admin: true }),
  preferOpenClawRoute: (id: number, input?: { note?: string | null }) => request<OpenClawRouteActionResponse>(`/admin/openclaw/routes/${id}/prefer`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  }, { admin: true }),
  disableOpenClawRoute: (id: number, input?: { note?: string | null }) => request<OpenClawRouteActionResponse>(`/admin/openclaw/routes/${id}/disable`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  }, { admin: true }),
  clearOpenClawRouteOwner: (id: number, input?: { note?: string | null }) => request<OpenClawRouteActionResponse>(`/admin/openclaw/routes/${id}/clear-owner`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  }, { admin: true }),
  listWorkspaces: () => request<WorkspaceListResponse>('/admin/workspaces', undefined, { admin: true }),
  getWorkspaceOverview: (slug: string) => request<WorkspaceOverviewResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/overview`, undefined, { admin: true }),
  listWorkspaceIdentities: (slug: string) => request<WorkspaceIdentitiesResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/identities`, undefined, { admin: true }),
  updateWorkspaceIdentity: (slug: string, id: number, input: WorkspaceIdentityPatchInput) => request<{ binding: WorkspaceIdentityBinding }>(`/admin/workspaces/${encodeURIComponent(slug)}/identities/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, { admin: true }),
  updateWorkspaceIdentityPolicy: (slug: string, id: number, input: WorkspaceIdentityPolicyPatchInput) => request<WorkspaceIdentityPolicyResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/identities/${id}/policy`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, { admin: true }),
  reissueWorkspaceIdentityCredential: (slug: string, id: number) => request<WorkspaceIdentityReissueResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/identities/${id}/reissue-local-credential`, {
    method: 'POST',
  }, { admin: true }),
  listWorkspacePartnerChannels: (slug: string) => request<WorkspacePartnerChannelsResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/partner-channels`, undefined, { admin: true }),
  createWorkspacePartnerChannel: (slug: string, input: WorkspacePartnerChannelCreateInput) => request<{ channel: WorkspacePartnerChannel }>(`/admin/workspaces/${encodeURIComponent(slug)}/partner-channels`, {
    method: 'POST',
    body: JSON.stringify(input),
  }, { admin: true }),
  updateWorkspacePartnerChannel: (slug: string, id: number, input: WorkspacePartnerChannelPatchInput) => request<{ channel: WorkspacePartnerChannel }>(`/admin/workspaces/${encodeURIComponent(slug)}/partner-channels/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, { admin: true }),
  listWorkspaceThreads: (slug: string) => request<WorkspaceThreadsResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/threads`, undefined, { admin: true }),
  createWorkspaceThread: (slug: string, input: WorkspaceThreadCreateInput) => request<WorkspaceThreadDetailResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/threads`, {
    method: 'POST',
    body: JSON.stringify(input),
  }, { admin: true }),
  getWorkspaceThread: (slug: string, id: number) => request<WorkspaceThreadDetailResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/threads/${id}`, undefined, { admin: true }),
  dispatchWorkspaceThread: (slug: string, id: number, input: WorkspaceThreadDispatchInput) => request<WorkspaceThreadDispatchResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/threads/${id}/dispatch`, {
    method: 'POST',
    body: JSON.stringify(input),
  }, { admin: true }),
  getWorkspacePolicy: (slug: string) => request<WorkspacePolicyResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/policy`, undefined, { admin: true }),
  updateWorkspacePolicy: (slug: string, input: WorkspacePolicyPatchInput) => request<WorkspacePolicyResponse & { updated: boolean }>(`/admin/workspaces/${encodeURIComponent(slug)}/policy`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, { admin: true }),
  getWorkspaceTimeline: (slug: string, limit = 100) => request<WorkspaceTimelineResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/timeline${buildQuery({ limit })}`, undefined, { admin: true }),
  getWorkspaceDigest: (slug: string, params?: { days?: number }) => request<WorkspaceDigestResponse>(`/admin/workspaces/${encodeURIComponent(slug)}/digest${buildQuery({ days: params?.days })}`, undefined, { admin: true }),
  deliverWorkspaceDigest: (slug: string, input?: { days?: number; email?: string | null }) => request<{ ok: boolean; email: string; deliveredAt: string }>(`/admin/workspaces/${encodeURIComponent(slug)}/digest/deliver`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  }, { admin: true }),
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
  getPartnerHealth: (params?: {
    days?: number
    hours?: number
  }) => request<PartnerHealthResponse>(`/admin/partner-health${buildQuery({
    days: params?.days,
    hours: params?.hours,
  })}`, undefined, { admin: true }),
  getPartnerDigest: (params?: {
    days?: number
    owner?: string
  }) => request<PartnerDigestResponse>(`/admin/partner-digest${buildQuery({
    days: params?.days,
    owner: params?.owner,
  })}`, undefined, { admin: true }),
  deliverPartnerDigest: (input?: {
    days?: number
    owner?: string | null
    email?: string | null
  }) => request<{ ok: boolean; email: string; deliveredAt: string }>('/admin/partner-digest/deliver', {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  }, { admin: true }),
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
  getProofPack: (id: number) => request<BetaRequestProofPack>(`/admin/beta-requests/${id}/proof-pack`, undefined, { admin: true }),
  downloadProofPack: async (id: number, format: 'json' | 'markdown'): Promise<ExportDownload> => {
    const response = await requestRaw(`/admin/beta-requests/${id}/proof-pack${buildQuery({ format })}`, undefined, { admin: true })
    return {
      blob: await response.blob(),
      filename: getFilenameFromResponse(response, `proof-pack-${id}`, format === 'markdown' ? 'json' : 'json').replace(/\.json$/u, format === 'markdown' ? '.md' : '.json'),
    }
  },
  downloadPartnerDigest: async (params?: {
    days?: number
    owner?: string
  }): Promise<ExportDownload> => {
    const response = await requestRaw(`/admin/partner-digest${buildQuery({
      format: 'markdown',
      days: params?.days,
      owner: params?.owner,
    })}`, undefined, { admin: true })
    return {
      blob: await response.blob(),
      filename: getFilenameFromResponse(response, 'partner-digest', 'json').replace(/\.json$/u, '.md'),
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
    status?: OperatorNotificationStatus
    owner?: string | null
    nextAction?: string | null
  }) => request<OperatorNotificationUpdateResponse>(`/admin/operator-notifications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, { admin: true }),
  getFunnelAnalytics: (days = 30) => request<FunnelAnalyticsResponse>(`/admin/funnel?days=${days}`, undefined, { admin: true }),
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
