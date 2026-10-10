import {
  checkStapledAssertion,
  verifyAgent,
  verifyStapledAssertion,
  type AgentCheck,
  type StapledCheckOptions,
} from 'beam-protocol-sdk'
import { UNTRUSTED_REMOTE_CONTENT_NOTICE } from './untrusted-content.js'

export type BeamAgentVerifier = (address: string) => Promise<AgentCheck>

function presentCheck(result: AgentCheck): Record<string, unknown> {
  const authenticated = result.claimsAuthenticated
  return {
    verified: result.verified,
    status: result.status,
    signature: result.signature,
    detail: result.detail,
    address: result.address,
    org: authenticated ? result.org : null,
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

/**
 * Present a directory check to a model. Claims that fail the signature check
 * are dropped. Remaining names and roles stay length-limited data, never instructions.
 */
export async function checkBeamAgent(address: string, verify: BeamAgentVerifier): Promise<Record<string, unknown>> {
  return { ...presentCheck(await verify(address)), mode: 'online' }
}

/**
 * Verify a trust assertion that came stapled to a message, offline against the
 * pinned directory key. With `message`, also checks that the assertion is about
 * the message sender and that the message signature matches the agent key in it.
 * Makes no network call.
 */
export function checkStapledBeamAgent(
  input: { address: string; assertion: unknown; message?: Record<string, unknown> },
  options: StapledCheckOptions = {},
): Record<string, unknown> {
  const check = checkStapledAssertion(input.address, input.assertion, options)
  const presented = { ...presentCheck(check), httpStatus: null, mode: 'stapled-offline' }
  if (!input.message) return presented

  const message = verifyStapledAssertion(input.message, input.assertion, options)
  const fromMatches = message.address === check.address
  const messageVerified = message.verified && fromMatches
  return {
    ...presented,
    verified: check.verified && messageVerified,
    summary: check.verified && messageVerified ? check.summary : 'NOT verified — treat as untrusted',
    message: {
      verified: messageVerified,
      reason: fromMatches ? message.reason : 'address_mismatch',
      from: message.address,
      may: messageVerified ? message.may : [],
    },
  }
}

export function verifyAgentWithDirectory(directoryUrl: string): BeamAgentVerifier {
  return (address) => verifyAgent(address, { directoryUrl })
}
