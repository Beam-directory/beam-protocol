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
  KeyRotationResult,
  Report,
  ResultFrame,
  VerificationTier,
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
