import type { AgentRow } from '../types.js'
import { toBeamDID } from '../did.js'

export function serializeAgent(row: AgentRow, options: { connected?: boolean } = {}): object {
  const { email_token: _emailToken, api_key_hash: _apiKeyHash, ...agent } = row

  return {
    ...agent,
    did: toBeamDID(row.beam_id),
    capabilities: JSON.parse(row.capabilities) as string[],
    email_verified: row.email_verified === 1,
    personal: row.personal === 1,
    verified: row.verified === 1 || row.verification_tier !== 'basic',
    flagged: row.flagged === 1,
    verificationTier: row.verification_tier,
    ...(options.connected === undefined ? {} : { connected: options.connected }),
  }
}
