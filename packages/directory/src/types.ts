// Beam ID string format: agent@org.beam.directory
export type BeamIdString = string

export interface AgentRecord {
  beam_id: string
  org: string
  display_name: string
  capabilities: string[]
  public_key: string
  trust_score: number
  verified: number
  verification_tier: string
  flagged: number
  created_at: string
  last_seen: string
}

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
  org: string
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
  org: string
  display_name: string
  capabilities: string
  public_key: string
  trust_score: number
  verified: number
  verification_tier: string
  flagged: number
  created_at: string
  last_seen: string
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
  type: 'intent' | 'result' | 'connected' | 'error' | 'delivered'
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
