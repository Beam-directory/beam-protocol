// Beam ID string format: agent@org.beam.directory
export type BeamIdString = string

export interface AgentRecord {
  beam_id: string
  org: string
  display_name: string
  capabilities: string[]  // parsed array
  public_key: string      // SPKI DER base64
  trust_score: number     // 0.0-1.0
  verified: number        // 0 or 1 (SQLite boolean)
  created_at: string      // ISO 8601
  last_seen: string       // ISO 8601
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

// AgentRow represents a raw row from the SQLite agents table
export interface AgentRow {
  beam_id: string
  org: string
  display_name: string
  capabilities: string  // JSON string
  public_key: string
  trust_score: number
  verified: number
  created_at: string
  last_seen: string
}

export interface WsMessage {
  type: 'intent' | 'result' | 'connected' | 'error' | 'delivered'
  frame?: IntentFrame | ResultFrame
  nonce?: string
  message?: string
  beamId?: string
  senderPublicKey?: string
}

export type WsClientMessage =
  | { type: 'intent'; frame: IntentFrame }
  | { type: 'result'; frame: ResultFrame }
