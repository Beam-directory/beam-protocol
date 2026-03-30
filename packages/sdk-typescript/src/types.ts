export type BeamIdString = `${string}@beam.directory` | `${string}@${string}.beam.directory`

export type VerificationTier = 'basic' | 'verified' | 'business' | 'enterprise'

export interface BeamIdentityConfig {
  agentName: string
  orgName?: string
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
  org?: string
}

export interface AgentRecord extends AgentRegistration {
  did?: string
  apiKey?: string
  trustScore: number  // 0.0-1.0
  verified: boolean
  createdAt: string
  lastSeen: string
  keyState?: AgentKeyState
}

export interface AgentProfile extends AgentRecord {
  description?: string
  logoUrl?: string
  website?: string
  verificationTier?: VerificationTier
  verificationStatus?: 'pending' | 'verified' | 'failed' | 'unverified'
  domain?: string
  intentsHandled?: number
}

export interface BrowseFilters {
  capability?: string
  tier?: VerificationTier
  verified_only?: boolean
}

export interface BrowseResult {
  page: number
  pageSize: number
  total: number
  agents: AgentProfile[]
}

export interface DirectoryStats {
  totalAgents: number
  verifiedAgents: number
  intentsProcessed: number
  consumerAgents?: number
  uptime?: number
  waitlistSize?: number
  version?: string
  gitSha?: string | null
  deployedAt?: string
  release?: {
    version: string
    gitSha: string | null
    gitShaShort?: string | null
    deployedAt: string
  }
}

export interface Delegation {
  id?: string
  sourceBeamId: BeamIdString
  targetBeamId: BeamIdString
  scope: string
  expiresAt?: string
  createdAt?: string
  status?: string
}

export interface Report {
  id?: string
  reporterBeamId: BeamIdString
  targetBeamId: BeamIdString
  reason: string
  createdAt?: string
  status?: string
}

export interface DomainVerification {
  domain: string
  verified: boolean
  status?: string
  tier?: VerificationTier
  txtName?: string
  txtValue?: string
  expected?: string
  records?: string[]
  checkedAt?: string
}

export interface KeyRotationResult {
  beamId: BeamIdString
  publicKey: string
  rotatedAt?: string
  previousKey?: string
  keyState?: AgentKeyState
}

export interface AgentKeyRecord {
  id?: number
  beamId: BeamIdString
  publicKey: string
  createdAt: number
  revokedAt: number | null
  status: 'active' | 'revoked'
}

export interface AgentKeyState {
  active: AgentKeyRecord | null
  revoked: AgentKeyRecord[]
  keys: AgentKeyRecord[]
  total: number
}

export interface KeyRevocationResult {
  beamId: BeamIdString
  revoked: boolean
  revokedKey: AgentKeyRecord | null
  keyState: AgentKeyState
}

export interface DirectoryConfig {
  baseUrl: string
  apiKey?: string
}

export interface BeamClientConfig {
  identity?: BeamIdentityData
  apiKey?: string
  directoryUrl: string
}

export interface AgentSearchQuery {
  org?: string
  capabilities?: string[]
  minTrustScore?: number
  limit?: number
}
