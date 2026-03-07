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
