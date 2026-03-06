export { BeamIdentity } from './identity.js'
export { BeamDirectory, BeamDirectoryError } from './directory.js'
export { BeamClient } from './client.js'
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
