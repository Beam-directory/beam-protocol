import type { IntentLifecycleStatus } from './intent-lifecycle.js'

// Beam ID string format: agent@org.beam.directory or agent@beam.directory
export type BeamIdString = string

export interface AgentRecord {
  beam_id: string
  org: string | null
  personal: number
  display_name: string
  capabilities: string[]
  public_key: string
  trust_score: number
  verified: number
  verification_tier: VerificationTier
  flagged: number
  created_at: string
  last_seen: string
}

export type VerificationTier = 'basic' | 'verified' | 'business' | 'enterprise'

export interface IntentFrame {
  v: '1'
  intent: string
  from: string
  to: string
  payload: Record<string, unknown>
  nonce: string
  timestamp: string
  signature?: string
}

export interface IntentAclRow {
  id: number
  target_beam_id: string
  intent_type: string
  allowed_from: string
  created_at: string
}

export interface IntentLogRow {
  id: number
  nonce: string
  from_beam_id: string
  to_beam_id: string
  intent_type: string
  requested_at: string
  completed_at: string | null
  round_trip_latency_ms: number | null
  status: IntentLifecycleStatus
  error_code: string | null
  result_json: string | null
}

export interface IntentTraceEventRow {
  id: number
  nonce: string
  from_beam_id: string
  to_beam_id: string
  intent_type: string
  stage: IntentLifecycleStatus
  status: IntentLifecycleStatus
  timestamp: string
  details: string | null
}

export interface TrustScoreRow {
  id: number
  source_beam_id: string
  target_beam_id: string
  score: number
  last_updated: string
}

export interface FederationPeer {
  directoryUrl: string
  publicKey: string
  trustLevel: number
  lastSeen: string | null
  syncedAt: string | null
}

export interface FederationPeerRow {
  id: number
  directory_url: string
  public_key: string
  trust_level: number
  status: string
  created_at: string
  last_seen: string | null
  synced_at: string | null
}

export interface FederatedAgentRow {
  beam_id: string
  home_directory_url: string
  cached_document: string
  cached_at: string
  ttl: number
}

export interface DirectoryRoleRow {
  user_id: string
  role: 'admin' | 'operator' | 'viewer'
  directory_url: string
}

export interface AdminMagicLinkRow {
  token: string
  email: string
  role: 'admin' | 'operator' | 'viewer'
  created_at: string
  expires_at: string
  used: number
}

export interface AdminSessionRow {
  id: string
  email: string
  role: 'admin' | 'operator' | 'viewer'
  created_at: string
  last_seen_at: string
  expires_at: string
  revoked_at: string | null
}

export interface AuditLogRow {
  id: number
  action: string
  actor: string
  target: string
  timestamp: string
  details: string
}

export type OperatorNotificationSource = 'beta_request' | 'critical_alert'
export type OperatorNotificationStatus = 'new' | 'acknowledged' | 'acted'
export type OperatorNotificationSeverity = 'info' | 'warning' | 'critical'

export interface OperatorNotificationRow {
  id: number
  source_type: OperatorNotificationSource
  source_key: string
  beta_request_id: number | null
  alert_id: string | null
  severity: OperatorNotificationSeverity
  title: string
  message: string
  href: string | null
  owner: string | null
  next_action: string | null
  status: OperatorNotificationStatus
  created_at: string
  updated_at: string
  acknowledged_at: string | null
  acted_at: string | null
  actor: string | null
  details_json: string | null
}

export type WorkspaceStatus = 'active' | 'paused' | 'archived'
export type WorkspaceThreadScope = 'internal' | 'handoff'
export type WorkspaceMemberRole = 'owner' | 'operator' | 'viewer'
export type WorkspacePrincipalType = 'human' | 'agent' | 'service' | 'partner'
export type WorkspaceIdentityBindingType = 'agent' | 'service' | 'partner'
export type WorkspaceIdentityBindingStatus = 'active' | 'paused'
export type WorkspacePartnerChannelStatus = 'active' | 'trial' | 'blocked'
export type WorkspacePartnerChannelHealth = 'healthy' | 'watch' | 'critical'
export type WorkspaceThreadKind = 'internal' | 'handoff'
export type WorkspaceThreadStatus = 'open' | 'blocked' | 'closed'
export type WorkspaceThreadParticipantRole = 'owner' | 'participant' | 'observer' | 'approver'
export type WorkspacePolicyDefaultExternalInitiation = 'deny' | 'binding'
export type WorkspacePolicyRuleExternalInitiation = 'inherit' | 'allow' | 'deny'
export type WorkspaceIdentityLifecycleStatus = 'healthy' | 'stale' | 'paused' | 'missing' | 'revoked' | 'unowned'
export type WorkspaceTimelineEventKind = 'workspace' | 'policy' | 'identity' | 'partner_channel' | 'thread' | 'digest'
export type OpenClawHostStatus = 'pending' | 'active' | 'revoked'
export type OpenClawHostHealth = 'pending' | 'healthy' | 'watch' | 'stale' | 'revoked'
export type OpenClawHostEnrollmentStatus = 'issued' | 'pending' | 'approved' | 'revoked' | 'expired'
export type OpenClawHostCredentialState = 'missing' | 'ready' | 'rotation_pending' | 'recovery_pending' | 'revoked'
export type OpenClawRouteSource = 'agent-folder' | 'workspace-agent' | 'gateway-agent' | 'subagent-run'
export type OpenClawRouteReportedState = 'live' | 'idle' | 'ended'
export type OpenClawRouteRuntimeState = 'live' | 'idle' | 'stale' | 'ended' | 'conflict' | 'revoked'
export type OpenClawRouteOwnerResolutionState = 'implicit' | 'preferred' | 'disabled'
export type OpenClawFleetDigestRunTriggerKind = 'manual' | 'scheduled'
export type OpenClawFleetDigestDeliveryKind = 'digest' | 'escalation'
export type OpenClawFleetDigestDeliveryStatus = 'delivered' | 'failed' | 'unavailable' | 'skipped'
export type OpenClawFleetDigestRunDeliveryState = 'pending' | 'delivered' | 'partial' | 'failed' | 'unavailable'
export type OpenClawFleetAlertTargetDeliveryKind = 'email' | 'webhook'
export type OpenClawFleetAlertSeverityThreshold = 'warning' | 'critical'
export type OpenClawFleetAlertDeliveryStatus = 'delivered' | 'failed' | 'unavailable' | 'skipped'

export interface WorkspaceRow {
  id: number
  slug: string
  name: string
  org_name: string | null
  description: string | null
  status: WorkspaceStatus
  default_thread_scope: WorkspaceThreadScope
  external_handoffs_enabled: number
  created_at: string
  updated_at: string
}

export interface WorkspaceMemberRow {
  id: number
  workspace_id: number
  principal_id: string
  principal_type: WorkspacePrincipalType
  role: WorkspaceMemberRole
  created_at: string
  updated_at: string
}

export interface WorkspaceIdentityBindingRow {
  id: number
  workspace_id: number
  beam_id: string
  binding_type: WorkspaceIdentityBindingType
  owner: string | null
  runtime_type: string | null
  policy_profile: string | null
  default_thread_scope: WorkspaceThreadScope
  can_initiate_external: number
  status: WorkspaceIdentityBindingStatus
  notes: string | null
  created_at: string
  updated_at: string
}

export interface WorkspacePartnerChannelRow {
  id: number
  workspace_id: number
  partner_beam_id: string
  label: string | null
  owner: string | null
  status: WorkspacePartnerChannelStatus
  notes: string | null
  last_success_at: string | null
  last_failure_at: string | null
  last_intent_nonce: string | null
  created_at: string
  updated_at: string
}

export interface WorkspaceThreadRow {
  id: number
  workspace_id: number
  kind: WorkspaceThreadKind
  title: string
  summary: string | null
  owner: string | null
  status: WorkspaceThreadStatus
  workflow_type: string | null
  draft_intent_type: string | null
  draft_payload_json: string | null
  linked_intent_nonce: string | null
  last_activity_at: string
  created_at: string
  updated_at: string
}

export interface WorkspaceThreadParticipantRow {
  id: number
  thread_id: number
  principal_id: string
  principal_type: WorkspacePrincipalType
  display_name: string | null
  beam_id: string | null
  workspace_binding_id: number | null
  role: WorkspaceThreadParticipantRole
  created_at: string
  updated_at: string
}

export interface OpenClawHostRow {
  id: number
  host_key: string
  enrollment_request_id: number | null
  label: string | null
  hostname: string
  os: string
  connector_version: string
  beam_directory_url: string
  workspace_slug: string | null
  status: OpenClawHostStatus
  health_status: OpenClawHostHealth
  route_count: number
  credential_hash: string | null
  credential_nonce: string | null
  credential_state: OpenClawHostCredentialState
  credential_issued_at: string | null
  credential_rotated_at: string | null
  recovery_completed_at: string | null
  approved_at: string | null
  approved_by: string | null
  revoked_at: string | null
  revocation_reason: string | null
  last_heartbeat_at: string | null
  last_inventory_at: string | null
  last_route_event_at: string | null
  metadata_json: string | null
  created_at: string
  updated_at: string
}

export interface OpenClawHostEnrollmentRequestRow {
  id: number
  request_key: string
  label: string | null
  workspace_slug: string | null
  notes: string | null
  status: OpenClawHostEnrollmentStatus
  claimed_host_id: number | null
  claimed_at: string | null
  approved_at: string | null
  approved_by: string | null
  revoked_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface OpenClawHostRouteRow {
  id: number
  host_id: number
  beam_id: string
  workspace_slug: string | null
  route_source: OpenClawRouteSource
  route_key: string
  runtime_type: string | null
  label: string | null
  connection_mode: 'websocket' | 'http' | 'hybrid' | 'unavailable' | null
  http_endpoint: string | null
  session_key: string | null
  reported_state: OpenClawRouteReportedState
  runtime_session_state: OpenClawRouteRuntimeState
  owner_resolution_state: OpenClawRouteOwnerResolutionState
  owner_resolution_actor: string | null
  owner_resolution_at: string | null
  owner_resolution_note: string | null
  metadata_json: string | null
  last_seen_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

export interface OpenClawResolvedRouteRow extends OpenClawHostRouteRow {
  host_label: string | null
  hostname: string
  host_status: OpenClawHostStatus
  host_health_status: OpenClawHostHealth
  host_credential_state: OpenClawHostCredentialState
  host_workspace_slug: string | null
  host_last_heartbeat_at: string | null
  host_last_inventory_at: string | null
}

export interface OpenClawHostHeartbeatRow {
  id: number
  host_id: number
  route_count: number
  connector_version: string
  health_status: OpenClawHostHealth
  details_json: string | null
  heartbeat_at: string
}

export interface OpenClawFleetDigestScheduleRow {
  id: number
  enabled: number
  delivery_email: string | null
  escalation_email: string | null
  run_hour_utc: number
  run_minute_utc: number
  escalate_on_critical: number
  last_scheduled_for_at: string | null
  last_run_id: number | null
  last_delivery_at: string | null
  last_escalation_delivery_at: string | null
  created_at: string
  updated_at: string
}

export interface OpenClawFleetDigestRunRow {
  id: number
  trigger_kind: OpenClawFleetDigestRunTriggerKind
  actor: string | null
  generated_at: string
  summary_json: string
  action_items_json: string
  escalation_items_json: string
  markdown: string
  delivery_state: OpenClawFleetDigestRunDeliveryState
  last_delivery_error_code: string | null
  created_at: string
}

export interface OpenClawFleetDigestDeliveryRow {
  id: number
  run_id: number | null
  delivery_kind: OpenClawFleetDigestDeliveryKind
  recipient_email: string
  status: OpenClawFleetDigestDeliveryStatus
  error_code: string | null
  error_message: string | null
  delivered_at: string
  details_json: string | null
}

export interface OpenClawFleetAlertTargetRow {
  id: number
  label: string
  delivery_kind: OpenClawFleetAlertTargetDeliveryKind
  destination: string
  severity_threshold: OpenClawFleetAlertSeverityThreshold
  enabled: number
  metadata_json: string | null
  last_delivery_status: OpenClawFleetAlertDeliveryStatus | null
  last_delivery_at: string | null
  last_error_code: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

export interface OpenClawFleetAlertDeliveryRow {
  id: number
  target_id: number
  run_id: number | null
  target_label: string
  delivery_kind: OpenClawFleetAlertTargetDeliveryKind
  destination: string
  severity_threshold: OpenClawFleetAlertSeverityThreshold
  severity: OpenClawFleetAlertSeverityThreshold
  item_count: number
  status: OpenClawFleetAlertDeliveryStatus
  error_code: string | null
  error_message: string | null
  delivered_at: string
  details_json: string | null
}

export interface OpenClawPolicyPackRow {
  id: number
  pack_key: string
  label: string
  description: string | null
  host_group_label: string | null
  policy_json: string
  created_at: string
  updated_at: string
}

export interface OpenClawWorkspaceTemplateRow {
  id: number
  template_key: string
  label: string
  description: string | null
  host_group_label: string | null
  policy_pack_key: string | null
  template_json: string
  created_at: string
  updated_at: string
}

export interface WorkspacePolicyRow {
  workspace_id: number
  policy_json: string
  updated_at: string
  updated_by: string | null
}

export interface WorkspacePolicyBindingRule {
  beamId: string | null
  bindingType: WorkspaceIdentityBindingType | null
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

export interface WorkspacePolicyMetadata {
  notes: string | null
  template?: {
    templateKey: string | null
    templateLabel: string | null
    policyPackKey: string | null
    policyPackLabel: string | null
    hostGroupLabel: string | null
    appliedAt: string | null
    appliedBy: string | null
  } | null
}

export interface WorkspacePolicy {
  version: 1
  defaults: {
    externalInitiation: WorkspacePolicyDefaultExternalInitiation
    allowedPartners: string[]
  }
  bindingRules: WorkspacePolicyBindingRule[]
  workflowRules: WorkspacePolicyWorkflowRule[]
  metadata: WorkspacePolicyMetadata
}

export type FunnelEventCategory = 'page_view' | 'cta_click' | 'request' | 'demo_milestone'

export interface FunnelEventRow {
  id: number
  session_id: string
  origin: string
  page_key: string
  event_category: FunnelEventCategory
  cta_key: string | null
  target_page: string | null
  workflow_type: string | null
  milestone_key: string | null
  created_at: string
}

export interface ShieldAuditLogRow {
  id: number
  nonce: string | null
  timestamp: string | null
  sender_beam_id: string | null
  sender_trust: number | null
  intent_type: string | null
  payload_hash: string | null
  decision: string | null
  risk_score: number | null
  response_size: number | null
  anomaly_flags: string | null
  created_at: string
}

export interface DnsCacheRow {
  cache_key: string
  record_type: string
  payload: string
  expires_at: number
  cached_at: string
}

export interface FederatedTrustRow {
  beam_id: string
  source_directory_url: string
  origin_directory_url: string
  asserted_trust: number
  effective_trust: number
  hop_count: number
  asserted_at: string
}

export interface ResultFrame {
  v: '1'
  success: boolean
  payload?: Record<string, unknown>
  error?: string
  errorCode?: string
  nonce: string
  timestamp: string
  latency?: number
  signature?: string
}

export interface RegisterRequest {
  beamId: string
  displayName: string
  capabilities: string[]
  publicKey: string
  apiKeyHash?: string | null
  org?: string | null
  personal?: boolean
  email?: string | null
  emailVerified?: boolean
  description?: string | null
  logoUrl?: string | null
  website?: string | null
  verificationTier?: VerificationTier
  visibility?: 'public' | 'unlisted'
  // S4: P2P HTTP direct delivery endpoint
  httpEndpoint?: string | null
  // S5: E2E encryption key (X25519)
  dhPublicKey?: string | null
}

export interface OrgRow {
  name: string
  display_name: string
  domain: string | null
  beam_domain: string
  api_key_hash: string
  verification_token: string
  verified: number
  created_at: string
  verified_at: string | null
}

export interface OrgAgentRow {
  id: number
  org_name: string
  agent_name: string
  beam_id: string
  display_name: string
  capabilities: string
  public_key: string
  created_at: string
  updated_at: string
}

export interface AgentRow {
  beam_id: string
  org: string | null
  personal: number
  display_name: string
  capabilities: string
  public_key: string
  api_key_hash: string | null
  email: string | null
  email_verified: number
  verification_tier: VerificationTier
  email_token: string | null
  description: string | null
  logo_url: string | null
  website: string | null
  trust_score: number
  verified: number
  flagged: number
  visibility: 'public' | 'unlisted'
  shield_config: string | null
  http_endpoint: string | null
  dh_public_key: string | null
  plan: 'free' | 'pro' | 'business' | 'enterprise'
  created_at: string
  last_seen: string
}

export interface AgentIntentStats {
  received: number
  responded: number
  avg_response_time_ms: number | null
}

export interface DomainVerificationRow {
  id: number
  beam_id: string
  domain: string
  challenge_token: string
  status: string
  created_at: number
  verified_at: string | null
}

export interface BusinessVerificationRow {
  id: number
  beam_id: string
  country: string
  registration_number: string
  legal_name: string
  status: string
  verification_source: string | null
  source_reference: string | null
  evidence: string | null
  created_at: string
  verified_at: string | null
}

export interface AgentKeyRow {
  id: number
  beam_id: string
  public_key: string
  created_at: number
  revoked_at: number | null
}

export interface DelegationRow {
  id: number
  grantor_beam_id: string
  grantee_beam_id: string
  scope: string
  created_at: number
  expires_at: number
  revoked: number
}

export interface ReportRow {
  id: number
  reporter_beam_id: string
  target_beam_id: string
  reason: string
  created_at: number
  status: string
}

export interface WsMessage {
  type: 'intent' | 'result' | 'connected' | 'error' | 'delivered' | 'feed_connected' | 'intent_feed'
  frame?: IntentFrame | ResultFrame
  nonce?: string
  message?: string
  beamId?: string
  senderPublicKey?: string
  actingBeamId?: string
}

export type WsClientMessage =
  | { type: 'intent'; frame: IntentFrame }
  | { type: 'result'; frame: ResultFrame }
