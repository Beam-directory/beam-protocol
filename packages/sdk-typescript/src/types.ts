/** Beam ID format: agent@org.beam.directory */
export type BeamIdString = `${string}@${string}.beam.directory`

export interface BeamIdentityConfig {
  agentName: string
  orgName: string
}

export interface BeamIdentityData {
  beamId: BeamIdString
  publicKeyBase64: string   // SPKI DER, base64
  privateKeyBase64: string  // PKCS8 DER, base64
}

export interface IntentFrame {
  v: '1'
  intent: string
  from: BeamIdString
  to: BeamIdString
  payload: Record<string, unknown>
  nonce: string      // UUID v4
  timestamp: string  // ISO 8601
  signature?: string // Ed25519 base64, set after signing
}

export interface ResultFrame {
  v: '1'
  success: boolean
  payload?: Record<string, unknown>
  error?: string
  errorCode?: string
  nonce: string      // from IntentFrame
  timestamp: string  // ISO 8601
  latency?: number   // ms
  signature?: string // Ed25519 base64
}

export interface AgentRegistration {
  beamId: BeamIdString
  displayName: string
  capabilities: string[]
  publicKey: string  // SPKI DER base64
  org: string
}

export interface AgentRecord extends AgentRegistration {
  did?: string
  trustScore: number  // 0.0-1.0
  verified: boolean
  createdAt: string
  lastSeen: string
}

export interface DirectoryConfig {
  baseUrl: string
  apiKey?: string
}

export interface BeamClientConfig {
  identity: BeamIdentityData
  directoryUrl: string
}

export interface AgentSearchQuery {
  org?: string
  capabilities?: string[]
  minTrustScore?: number
  limit?: number
}
