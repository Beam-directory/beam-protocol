export { BeamIdentity } from './identity.js'
export { BeamDirectory, BeamDirectoryError } from './directory.js'
export { BeamClient, BeamThread } from './client.js'
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
  BeamIdString,
  BeamIdentityConfig,
  BeamIdentityData,
  IntentFrame,
  ResultFrame,
  AgentRegistration,
  AgentRecord,
  DirectoryConfig,
  BeamClientConfig,
  AgentSearchQuery
} from './types.js'
export type {
  DIDDocument,
  VerificationMethod,
  ServiceEndpoint,
  VerifiableCredential,
  CredentialSubject,
  Proof,
} from './did.js'
