export { BeamIdentity } from './identity.js'
export { BeamDirectory, BeamDirectoryError } from './directory.js'
export { BeamClient, BeamThread } from './client.js'
export { beamIdFromApiKey } from './api-key.js'
export { BeamDID, BeamCredentialsClient, CredentialVerifier } from './did.js'
export {
  createIntentFrame,
  createResultFrame,
  signFrame,
  validateIntentFrame,
  validateResultFrame,
  canonicalizeFrame,
  intentSigningText,
  MAX_FRAME_SIZE,
  REPLAY_WINDOW_MS
} from './frames.js'
export type {
  AgentProfile,
  AssuranceScope,
  AgentKeyRecord,
  AgentKeyState,
  AgentRegistration,
  AgentRecord,
  AgentSearchQuery,
  BeamClientConfig,
  BeamTrustConfig,
  ReceivedIntentFrame,
  BeamIdentityConfig,
  BeamIdentityData,
  BeamIdString,
  BrowseFilters,
  BrowseResult,
  Delegation,
  DirectoryConfig,
  DirectoryStats,
  DomainVerification,
  IntentFrame,
  IntentSendResult,
  ApprovalRequired,
  KeyRotationResult,
  KeyRevocationResult,
  Report,
  RemoteAssuranceAssertion,
  ResultFrame,
  VerificationTier,
  WebSocketTicket,
} from './types.js'
export type {
  DIDDocument,
  VerificationMethod,
  ServiceEndpoint,
  VerifiableCredential,
  CredentialSubject,
  Proof,
} from './did.js'
export * from './key-management.js'
export {
  verifyAgent,
  verifyAgentTrust,
  verifyStapledAssertion,
  checkStapledAssertion,
  spkiKeyId,
  verifyEd25519Spki,
} from './verify-agent.js'
export type { VerifyAgentOptions, StapledCheckOptions, VerifyStapledOptions } from './verify-agent.js'
export { TrustAssertionStapler, DEFAULT_ASSERTION_TTL_MS } from './stapling.js'
export type { TrustStaplerOptions } from './stapling.js'
export {
  MAX_STAPLED_ASSERTION_BYTES,
  parseStapledAssertion,
  reasonFromDetail,
  trustResultFromCheck,
  unverifiedTrustResult,
  DIRECTORY_SIGNING_PUBLIC_KEY,
  DEFAULT_DIRECTORY_URL,
  BEAM_ADDRESS_PATTERN,
  assertionSigningText,
  canonicalizeJson,
  decodeBase64,
  encodeBase64,
  evaluateTrustCheck,
  flipSignatureByte,
  keyIdFromSha256Hex,
  parseBeamAddress,
  summaryLine,
} from './trust-assertion.js'
export type {
  AgentCheck,
  CheckDetail,
  CheckStatus,
  PublicOrg,
  PublicOwner,
  PublicScopes,
  SignatureStatus,
  StapledTrustEnvelope,
  StapledTrustReason,
  StapledTrustResult,
  VerificationLevel,
} from './trust-assertion.js'
