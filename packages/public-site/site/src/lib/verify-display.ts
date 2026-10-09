import { individualOwnerLabel, type AgentCheck } from 'beam-protocol-sdk/trust-assertion'

export function isVerifiedIndividual(result: Pick<AgentCheck, 'verified' | 'subject' | 'org'>): boolean {
  return result.verified === true && result.subject === 'individual' && result.org === null
}

export function formatLocalSummary(
  result: AgentCheck,
  copy: {
    verifiedPrefix: string
    verifiedIndividualPrefix: string
    notVerifiedLine: string
    onBehalfOf: (role: string) => string
    may: (scopes: string) => string
  },
): string {
  if (result.status === 'rate_limited' || result.status === 'api_error') return result.summary
  if (isVerifiedIndividual(result)) {
    const label = individualOwnerLabel(result.owner)
    const owner = label ? `, ${copy.onBehalfOf(label)}` : ''
    const scopes = result.scopes ? `, ${copy.may(result.scopes.actions.join(', '))}` : ''
    return `${copy.verifiedIndividualPrefix}${owner}${scopes}`
  }
  if (!result.verified || !result.org) return copy.notVerifiedLine
  const org = result.org.domain ? `${result.org.name} (${result.org.domain})` : result.org.name
  const owner = result.owner ? `, ${copy.onBehalfOf(result.owner.role)}` : ''
  const scopes = result.scopes ? `, ${copy.may(result.scopes.actions.join(', '))}` : ''
  return `${copy.verifiedPrefix} ${org}${owner}${scopes}`
}
