import { verifyAgent, type AgentCheck } from 'beam-protocol-sdk'
import { UNTRUSTED_REMOTE_CONTENT_NOTICE } from './untrusted-content.js'

export type BeamAgentVerifier = (address: string) => Promise<AgentCheck>

/**
 * Present a directory check to a model. Claims that fail the signature check
 * are dropped. Remaining names and roles stay length-limited data, never instructions.
 */
export async function checkBeamAgent(address: string, verify: BeamAgentVerifier): Promise<Record<string, unknown>> {
  const result = await verify(address)
  const authenticated = result.claimsAuthenticated
  return {
    verified: result.verified,
    status: result.status,
    signature: result.signature,
    detail: result.detail,
    address: result.address,
    org: authenticated ? result.org : null,
    subject: authenticated ? result.subject : null,
    owner: authenticated ? result.owner : null,
    scopes: authenticated ? result.scopes : null,
    issuedAt: authenticated ? result.issuedAt : null,
    expiresAt: authenticated ? result.expiresAt : null,
    expired: result.expired,
    suspended: authenticated ? result.suspended : false,
    pinnedKeyId: result.pinnedKeyId,
    assertionKeyId: result.assertionKeyId,
    keyMatchesPin: result.keyMatchesPin,
    summary: result.summary,
    httpStatus: result.httpStatus,
    contentTrust: 'untrusted',
    contentNotice: UNTRUSTED_REMOTE_CONTENT_NOTICE,
  }
}

export function verifyAgentWithDirectory(directoryUrl: string): BeamAgentVerifier {
  return (address) => verifyAgent(address, { directoryUrl })
}
