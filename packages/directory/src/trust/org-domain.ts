import { getDomain, getDomainWithoutSuffix, getPublicSuffix } from 'tldts'

const NAMESPACE_RE = /^[a-z0-9_-]+$/

export type DomainNamespace = {
  domain: string
  label: string
  disambiguated: string
}

function slug(value: string): string {
  return value.toLowerCase().replaceAll('_', '-').replaceAll('.', '-')
}

export function registrableDomain(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
  if (!host || host.includes(':')) {
    return null
  }
  return getDomain(host, { allowPrivateDomains: true })?.toLowerCase() ?? null
}

/**
 * The beam namespace stays a single label so existing addresses such as
 * `agent@coppen.beam.directory` keep working. The legal identity is the full
 * registrable domain. `coppen.de` may use `coppen` or `coppen-de`; `coppen.at`
 * uses `coppen` only while that label is free, otherwise `coppen-at`.
 */
export function namespaceForDomain(domain: string): DomainNamespace | null {
  const registrable = registrableDomain(domain)
  if (!registrable) {
    return null
  }
  const label = getDomainWithoutSuffix(registrable, { allowPrivateDomains: true })?.toLowerCase() ?? ''
  const suffix = getPublicSuffix(registrable, { allowPrivateDomains: true })?.toLowerCase() ?? ''
  if (!label || !suffix || !NAMESPACE_RE.test(label)) {
    return null
  }
  const disambiguated = `${slug(label)}-${slug(suffix)}`
  if (!NAMESPACE_RE.test(disambiguated)) {
    return null
  }
  return { domain: registrable, label: slug(label), disambiguated }
}

export function namespaceMatchesDomain(name: string, domain: string): boolean {
  const allowed = namespaceForDomain(domain)
  if (!allowed) {
    return false
  }
  const normalized = slug(name)
  return normalized === allowed.label || normalized === allowed.disambiguated
}
