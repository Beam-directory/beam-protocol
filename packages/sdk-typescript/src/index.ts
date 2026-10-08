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
export { verifyAgent, spkiKeyId, verifyEd25519Spki } from './verify-agent.js'
export type { VerifyAgentOptions } from './verify-agent.js'
export {
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
  VerificationLevel,
} from './trust-assertion.js'
