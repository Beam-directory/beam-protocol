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
  status: string
  error_code: string | null
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

export interface AuditLogRow {
  id: number
  action: string
  actor: string
  target: string
  timestamp: string
  details: string
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
  org?: string | null
  personal?: boolean
  email?: string | null
  emailVerified?: boolean
  description?: string | null
  logoUrl?: string | null
  verificationTier?: VerificationTier
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
  email: string | null
  email_verified: number
  verification_tier: VerificationTier
  email_token: string | null
  description: string | null
  logo_url: string | null
  trust_score: number
  verified: number
  flagged: number
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
