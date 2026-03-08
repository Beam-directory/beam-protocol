/** Beam ID format: agent@org.beam.directory */
export type BeamIdString = `${string}@${string}.beam.directory`

export interface BeamIdentityConfig {
  agentName: string
  orgName: string
}

export interface BeamIdentityData {
  beamId: BeamIdString
  publicKeyBase64: string
  privateKeyBase64: string
}

export interface IntentFrame {
  v: '1'
  intent: string
  from: BeamIdString
  to: BeamIdString
  payload: Record<string, unknown>
  nonce: string
  timestamp: string
  signature?: string
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

export interface AgentRegistration {
  beamId: BeamIdString
  displayName: string
  capabilities: string[]
  publicKey: string
  org: string
}

export interface AgentRecord extends AgentRegistration {
  trustScore: number
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
  autoReconnect?: boolean
  onDisconnect?: () => void
  onReconnect?: () => void
}

export interface AgentSearchQuery {
  org?: string
  capabilities?: string[]
  minTrustScore?: number
  limit?: number
}
