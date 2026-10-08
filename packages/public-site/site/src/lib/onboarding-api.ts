/**
 * Onboarding API client for directory v1.8.0.
 *
 * Live routes (packages/directory/src):
 * - createOrg                 POST /orgs                                          routes/orgs.ts
 * - getOrg                    GET  /orgs/:name                                    routes/orgs.ts
 * - checkDomainVerification   POST /orgs/:name/verify   { method: dns | well-known }
 * - submitOrgRegistry         POST /orgs/:name/registry                           routes/orgs.ts
 * - getOrgRegistry            GET  /orgs/:name/registry
 * - createPerson              POST /orgs/:name/people                             routes/people.ts
 * - listPeople                GET  /orgs/:name/people
 * - requestManualKyc          POST /orgs/:name/people/:id/kyc   { provider: "manual" }
 * - inviteEmployee            POST /orgs/:name/people/invitations
 * - acceptInvitation          POST /people/invitations/accept
 * - registerAgent             POST /orgs/:name/agents     publicKey + responsiblePersonId
 * - publishEncryptionKey      PATCH /agents/:beamId/config  signed by the agent key
 * - issueMandate              POST /agents/:beamId/mandates signed by the person key
 * - getTrustAssertion         GET  /agents/:beamId/trust-assertion
 * - getNetworkIdentity        GET  /network/me
 * - sendContactRequest        POST /network/connections (signed)
 * - registerInterest          POST /waitlist
 *
 * The directory never receives a private key. Signing uses a non-extractable CryptoKey in this tab.
 *
 * Still not real, and still marked in the UI:
 * - thirdPartyKyc            company ID checks stay manual; Stripe Identity is the private-person path
 * - syncEmployeeDirectory    no Personio or Microsoft Entra connection
 * - checkPowerOfRepresentation  the filing records a claimed role; nothing checks the register
 * - grokSending              sending from Grok is off until a separate decision
 */
import type { Messages } from '../i18n/en.ts'
import { createNonce, KeySupportError, signCanonical, signMutation } from './agent-keys'
import { directoryApiBase } from './directory-client'
import type { MandatePayload, ScopeGrant } from './onboarding-steps'

export type Capability =
  | 'createOrg'
  | 'getOrg'
  | 'checkDomainVerification'
  | 'verifyDomainByWellKnownFile'
  | 'submitOrgRegistry'
  | 'createPerson'
  | 'requestManualKyc'
  | 'getKycStatus'
  | 'inviteEmployee'
  | 'acceptInvitation'
  | 'registerAgent'
  | 'publishEncryptionKey'
  | 'issueMandate'
  | 'getTrustAssertion'
  | 'getNetworkIdentity'
  | 'sendContactRequest'
  | 'registerInterest'
  | 'thirdPartyKyc'
  | 'stripeIdentity'
  | 'syncEmployeeDirectory'
  | 'checkPowerOfRepresentation'
  | 'grokSending'

export type CapabilityStatus = 'live' | 'unavailable'

export const CAPABILITIES: Record<Capability, CapabilityStatus> = {
  createOrg: 'live',
  getOrg: 'live',
  checkDomainVerification: 'live',
  verifyDomainByWellKnownFile: 'live',
  submitOrgRegistry: 'live',
  createPerson: 'live',
  requestManualKyc: 'live',
  getKycStatus: 'live',
  inviteEmployee: 'live',
  acceptInvitation: 'live',
  registerAgent: 'live',
  publishEncryptionKey: 'live',
  issueMandate: 'live',
  getTrustAssertion: 'live',
  getNetworkIdentity: 'live',
  sendContactRequest: 'live',
  registerInterest: 'live',
  thirdPartyKyc: 'unavailable',
  stripeIdentity: 'live',
  syncEmployeeDirectory: 'unavailable',
  checkPowerOfRepresentation: 'unavailable',
  grokSending: 'unavailable',
}

export function isAvailable(capability: Capability): boolean {
  return CAPABILITIES[capability] === 'live'
}

export class NotAvailableYet extends Error {
  readonly capability: Capability
  readonly status = 'unavailable' as const

  constructor(capability: Capability) {
    super(`${capability} ist noch nicht verfügbar.`)
    this.name = 'NotAvailableYet'
    this.capability = capability
  }
}

export class OnboardingApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(message: string, status: number, code: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'OnboardingApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * Classifies a failed createOrg (routes/orgs.ts): 'name' = the claim is taken (409),
 * 'domain' = the domain itself is claimed, 'suffix-not-supported' = the name is neither the label
 * nor the label--suffix form the directory accepts.
 */
export function classifyOrgConflict(error: unknown): 'name' | 'domain' | 'suffix-not-supported' | null {
  if (!(error instanceof OnboardingApiError)) return null
  if (error.code === 'ORG_EXISTS' || error.code === 'ORG_CLAIM_PENDING') return 'name'
  if (error.code === 'DOMAIN_EXISTS' || error.code === 'DOMAIN_CLAIM_PENDING') return 'domain'
  if (error.code === 'ORG_NAMESPACE_DOMAIN_MISMATCH') return 'suffix-not-supported'
  return null
}

/** User-facing message in the active language (src/i18n errors dictionary). */
export function describeError(error: unknown, messages: Messages['errors']): string {
  if (error instanceof NotAvailableYet) return messages.notAvailable
  if (error instanceof KeySupportError) return messages.keySupport
  if (error instanceof OnboardingApiError) {
    return messages.codes[error.code] ?? (error.message || messages.generic)
  }
  if (error instanceof Error && error.message) return error.message
  return messages.generic
}

export async function checkPowerOfRepresentation(): Promise<never> {
  throw new NotAvailableYet('checkPowerOfRepresentation')
}

export async function syncEmployeeDirectory(): Promise<never> {
  throw new NotAvailableYet('syncEmployeeDirectory')
}

export async function startThirdPartyKyc(): Promise<never> {
  throw new NotAvailableYet('thirdPartyKyc')
}

type FetchLike = typeof fetch

export interface ClientOptions {
  baseUrl?: string
  fetchImpl?: FetchLike
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function request(
  path: string,
  init: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown; apiKey?: string; okStatuses?: number[] },
  options: ClientOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const baseUrl = (options.baseUrl ?? directoryApiBase()).replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.apiKey) headers.authorization = `Bearer ${init.apiKey}`

  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      credentials: 'omit',
    })
  } catch {
    throw new OnboardingApiError('Network error', 0, 'NETWORK_ERROR')
  }

  let body: Record<string, unknown>
  try {
    body = asRecord(await response.json())
  } catch {
    body = {}
  }

  const ok = response.ok || (init.okStatuses ?? []).includes(response.status)
  if (!ok) {
    const code = typeof body.errorCode === 'string' ? body.errorCode : response.status === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED'
    const message = typeof body.error === 'string' ? body.error : `Request failed with status ${response.status}`
    throw new OnboardingApiError(message, response.status, code, body)
  }
  return { status: response.status, body }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/* ------------------------------------------------------------------ Firma ------------------------------------------------------------------ */

export interface DnsChallenge {
  txtName: string
  txtValue: string
  wellKnownUrl: string
  wellKnownBody: string
}

export interface OrgRecord {
  name: string
  requestedName: string
  displayName: string
  domain: string
  beamDomain: string
  verified: boolean
  claimExpiresAt: string | null
  verifiedAt: string | null
  domainVerifiedVia: '' | 'dns' | 'well-known'
  verification: DnsChallenge | null
}

export interface OrgClaim extends OrgRecord {
  /** Org API key. Secret, returned exactly once by the directory. Keep in memory, never log or persist. */
  apiKey: string
}

function parseOrg(raw: Record<string, unknown>): OrgRecord {
  const verification = asRecord(raw.verification)
  const via = raw.domainVerifiedVia
  return {
    name: str(raw.name),
    requestedName: str(raw.requestedName) || str(raw.name),
    displayName: str(raw.displayName) || str(raw.name),
    domain: str(raw.domain),
    beamDomain: str(raw.beamDomain),
    verified: raw.verified === true,
    claimExpiresAt: strOrNull(raw.claimExpiresAt),
    verifiedAt: strOrNull(raw.verifiedAt),
    domainVerifiedVia: via === 'dns' || via === 'well-known' ? via : '',
    verification: verification.txtName && verification.txtValue
      ? {
          txtName: str(verification.txtName),
          txtValue: str(verification.txtValue),
          wellKnownUrl: str(verification.wellKnownUrl),
          wellKnownBody: str(verification.wellKnownBody) || str(verification.txtValue),
        }
      : null,
  }
}

/** POST /orgs (routes/orgs.ts). The stored name is label--suffix until the domain is verified. */
export async function createOrg(
  input: { name: string; displayName: string; domain: string },
  options?: ClientOptions,
): Promise<OrgClaim> {
  const { body } = await request('/orgs', { method: 'POST', body: input }, options)
  const apiKey = str(body.apiKey)
  if (!apiKey) throw new OnboardingApiError('Directory returned no org API key', 500, 'INVALID_RESPONSE')
  return { ...parseOrg(body), apiKey }
}

/** GET /orgs/:name (routes/orgs.ts). Requires the org API key. Used to resume an onboarding. */
export async function getOrg(name: string, apiKey: string, options?: ClientOptions): Promise<OrgRecord> {
  const { body } = await request(`/orgs/${encodeURIComponent(name)}`, { method: 'GET', apiKey }, options)
  return parseOrg(asRecord(body.org))
}

export type DomainCheck =
  | { verified: true; method: 'dns' | 'well-known'; org: OrgRecord }
  | { verified: false; method: 'dns' | 'well-known'; expected: string; txtName: string; wellKnownUrl: string; records: string[]; errorCode: string }

/**
 * POST /orgs/:name/verify. method "dns" looks up the TXT record. method "well-known" fetches
 * https://domain/.well-known/beam-verification. 409 means the proof is not there yet.
 */
export async function checkDomainVerification(
  name: string,
  apiKey: string,
  method: 'dns' | 'well-known' = 'dns',
  options?: ClientOptions,
): Promise<DomainCheck> {
  const { status, body } = await request(
    `/orgs/${encodeURIComponent(name)}/verify`,
    { method: 'POST', apiKey, body: { method }, okStatuses: [409] },
    options,
  )
  if (status === 409 && (body.errorCode === 'TXT_NOT_FOUND' || body.errorCode === 'WELL_KNOWN_NOT_FOUND')) {
    return {
      verified: false,
      method,
      expected: str(body.expected),
      txtName: str(body.txtName),
      wellKnownUrl: str(body.wellKnownUrl),
      records: Array.isArray(body.records) ? body.records.filter((value): value is string => typeof value === 'string') : [],
      errorCode: str(body.errorCode),
    }
  }
  if (status === 409) {
    throw new OnboardingApiError(str(body.error), status, str(body.errorCode) || 'REQUEST_FAILED', body)
  }
  const org = parseOrg(asRecord(body.org))
  return { verified: true, method, org: { ...org, domainVerifiedVia: org.domainVerifiedVia || method } }
}

export interface RegistryFilingInput {
  kind: 'handelsregister' | 'lei'
  country: string
  registrationNumber: string
  registerCourt?: string | null
  legalName: string
  applicantName: string
  applicantRole: string
}

export interface RegistryFiling {
  id: number
  kind: string
  country: string
  registrationNumber: string
  registerCourt: string | null
  legalName: string
  applicantName: string
  applicantRole: string
  status: string
}

function parseFiling(raw: Record<string, unknown>): RegistryFiling {
  return {
    id: typeof raw.id === 'number' ? raw.id : 0,
    kind: str(raw.kind),
    country: str(raw.country),
    registrationNumber: str(raw.registrationNumber),
    registerCourt: strOrNull(raw.registerCourt),
    legalName: str(raw.legalName),
    applicantName: str(raw.applicantName),
    applicantRole: str(raw.applicantRole),
    status: str(raw.status) || 'pending',
  }
}

/** POST /orgs/:name/registry. Format check only. Status stays pending until a Beam operator reviews it. */
export async function submitOrgRegistry(
  orgName: string,
  apiKey: string,
  input: RegistryFilingInput,
  options?: ClientOptions,
): Promise<RegistryFiling> {
  const { body } = await request(
    `/orgs/${encodeURIComponent(orgName)}/registry`,
    { method: 'POST', apiKey, body: input },
    options,
  )
  return parseFiling(asRecord(body.filing))
}

export async function getOrgRegistry(orgName: string, apiKey: string, options?: ClientOptions): Promise<RegistryFiling[]> {
  const { body } = await request(`/orgs/${encodeURIComponent(orgName)}/registry`, { method: 'GET', apiKey }, options)
  return Array.isArray(body.filings) ? body.filings.map((entry) => parseFiling(asRecord(entry))) : []
}

/* ------------------------------------------------------------------ Person ----------------------------------------------------------------- */

export interface PersonRecord {
  id: string
  org: string
  email: string
  displayName: string
  role: string
  supervisorPersonId: string | null
  status: string
  kycStatus: string
  kycProvider: string | null
  publicKey: string
  rights: ScopeGrant | null
}

function parseRights(value: unknown): ScopeGrant | null {
  const raw = asRecord(value)
  if (!Array.isArray(raw.actions)) return null
  const actions = raw.actions.filter((entry): entry is ScopeGrant['actions'][number] =>
    entry === 'read' || entry === 'schedule.commit' || entry === 'file.send' || entry === 'order')
  const orderRaw = asRecord(raw.order)
  const order = orderRaw.maxAmount && orderRaw.currency
    ? { maxAmount: str(orderRaw.maxAmount), currency: 'EUR' as const }
    : undefined
  return { actions, ...(order ? { order } : {}) }
}

function parsePerson(raw: Record<string, unknown>): PersonRecord {
  return {
    id: str(raw.id),
    org: str(raw.org),
    email: str(raw.email),
    displayName: str(raw.displayName),
    role: str(raw.role),
    supervisorPersonId: strOrNull(raw.supervisorPersonId),
    status: str(raw.status),
    kycStatus: str(raw.kycStatus) || 'unverified',
    kycProvider: strOrNull(raw.kycProvider),
    publicKey: str(raw.publicKey),
    rights: parseRights(raw.rights),
  }
}

export async function createPerson(
  orgName: string,
  apiKey: string,
  input: { email: string; displayName: string; role: string; publicKey: string; rights: ScopeGrant; supervisorPersonId?: string | null },
  options?: ClientOptions,
): Promise<PersonRecord> {
  const { body } = await request(`/orgs/${encodeURIComponent(orgName)}/people`, {
    method: 'POST',
    apiKey,
    body: {
      email: input.email.trim().toLowerCase(),
      displayName: input.displayName.trim(),
      role: input.role.trim(),
      publicKey: input.publicKey,
      rights: input.rights,
      ...(input.supervisorPersonId ? { supervisorPersonId: input.supervisorPersonId } : {}),
    },
  }, options)
  return parsePerson(asRecord(body.person))
}

export async function listPeople(orgName: string, apiKey: string, options?: ClientOptions): Promise<PersonRecord[]> {
  const { body } = await request(`/orgs/${encodeURIComponent(orgName)}/people`, { method: 'GET', apiKey }, options)
  return Array.isArray(body.people) ? body.people.map((entry) => parsePerson(asRecord(entry))) : []
}

/** Records a manual KYC request. provider "manual" only. Status becomes pending, never verified, from this call. */
export async function requestManualKyc(orgName: string, apiKey: string, personId: string, options?: ClientOptions): Promise<PersonRecord> {
  const { body } = await request(`/orgs/${encodeURIComponent(orgName)}/people/${encodeURIComponent(personId)}/kyc`, {
    method: 'POST',
    apiKey,
    body: { provider: 'manual' },
  }, options)
  return parsePerson(asRecord(body.person))
}

export async function getKycStatus(orgName: string, apiKey: string, personId: string, options?: ClientOptions): Promise<PersonRecord | null> {
  const people = await listPeople(orgName, apiKey, options)
  return people.find((person) => person.id === personId) ?? null
}

export interface InvitationResult {
  invitationId: string
  email: string
  role: string
  expiresAt: string
  /** One-time token. Shown once, kept in memory only. */
  token: string
}

export async function inviteEmployee(
  orgName: string,
  apiKey: string,
  input: { email: string; role: string; rights: ScopeGrant; supervisorPersonId?: string | null },
  options?: ClientOptions,
): Promise<InvitationResult> {
  const { body } = await request(`/orgs/${encodeURIComponent(orgName)}/people/invitations`, {
    method: 'POST',
    apiKey,
    body: {
      email: input.email.trim().toLowerCase(),
      role: input.role.trim(),
      rights: input.rights,
      ...(input.supervisorPersonId ? { supervisorPersonId: input.supervisorPersonId } : {}),
    },
  }, options)
  const token = str(body.token)
  if (!token) throw new OnboardingApiError('Directory returned no invitation token', 500, 'INVALID_RESPONSE')
  return {
    invitationId: str(body.invitationId),
    email: str(body.email),
    role: str(body.role),
    expiresAt: str(body.expiresAt),
    token,
  }
}

export async function acceptInvitation(
  input: { token: string; displayName: string; publicKey: string },
  options?: ClientOptions,
): Promise<PersonRecord> {
  const { body } = await request('/people/invitations/accept', {
    method: 'POST',
    body: { token: input.token.trim(), displayName: input.displayName.trim(), publicKey: input.publicKey },
  }, options)
  return parsePerson(asRecord(body.person))
}

/* ------------------------------------------------------------------ Agent ------------------------------------------------------------------ */

export interface RegisterAgentInput {
  orgName: string
  agentName: string
  displayName: string
  /** Ed25519 public key, base64 SPKI. Generated in the browser. */
  publicKey: string
  responsiblePersonId: string
  capabilities?: string[]
}

export interface RegisteredAgent {
  beamId: string
  displayName: string
  org: string
  /** Agent API key (bk_…). Secret, returned once. Keep in memory and in the user's recovery kit only. */
  apiKey: string
  responsiblePersonId: string | null
}

/** POST /orgs/:name/agents. The directory does not generate the key and does not accept a private key. */
export async function registerAgent(input: RegisterAgentInput, orgApiKey: string, options?: ClientOptions): Promise<RegisteredAgent> {
  const { body } = await request(
    `/orgs/${encodeURIComponent(input.orgName)}/agents`,
    {
      method: 'POST',
      apiKey: orgApiKey,
      body: {
        agentName: input.agentName,
        displayName: input.displayName,
        publicKey: input.publicKey,
        responsiblePersonId: input.responsiblePersonId,
        capabilities: input.capabilities ?? [],
      },
    },
    options,
  )
  const apiKey = str(body.apiKey)
  if (!apiKey) throw new OnboardingApiError('Directory returned no agent API key', 500, 'INVALID_RESPONSE')
  return {
    beamId: str(body.beamId),
    displayName: str(body.displayName) || input.displayName,
    org: str(body.org) || input.orgName,
    apiKey,
    responsiblePersonId: strOrNull(body.responsiblePersonId),
  }
}

/**
 * PATCH /agents/:beamId/config. Signed by the agent key, same canonical payload routes/agents.ts rebuilds:
 * { type: 'agent.config', beamId, dhPublicKey, timestamp, nonce }.
 */
export async function publishEncryptionKey(
  input: { beamId: string; dhPublicKey: string; signingKey: CryptoKey },
  options?: ClientOptions,
): Promise<void> {
  const payload = {
    type: 'agent.config' as const,
    beamId: input.beamId,
    dhPublicKey: input.dhPublicKey,
    timestamp: new Date().toISOString(),
    nonce: createNonce(),
  }
  const signature = await signCanonical(payload, input.signingKey)
  await request(`/agents/${encodeURIComponent(input.beamId)}/config`, {
    method: 'PATCH',
    body: { ...payload, signature },
  }, options)
}

export interface IssuedMandate {
  jti: string
  status: string
  expiresAt: string
  agentBeamId: string
}

/** POST /agents/:beamId/mandates. Signature is over the full mandate payload, with the person key. */
export async function issueMandate(
  input: { beamId: string; payload: MandatePayload; signingKey: CryptoKey },
  options?: ClientOptions,
): Promise<IssuedMandate> {
  const signature = await signCanonical(input.payload, input.signingKey)
  const { body } = await request(`/agents/${encodeURIComponent(input.beamId)}/mandates`, {
    method: 'POST',
    body: {
      jti: input.payload.jti,
      scopes: input.payload.scopes,
      expiresAt: input.payload.expiresAt,
      escalationPersonId: input.payload.escalationPersonId,
      signature,
    },
  }, options)
  const mandate = asRecord(body.mandate)
  return {
    jti: str(mandate.jti) || input.payload.jti,
    status: str(mandate.status) || 'active',
    expiresAt: str(mandate.expiresAt) || input.payload.expiresAt,
    agentBeamId: str(mandate.agentBeamId) || input.beamId,
  }
}

export interface TrustAssertionView {
  beamId: string
  orgName: string
  orgVerified: boolean
  registryStatus: string
  personRole: string
  personSubject: 'individual' | 'organization' | ''
  personLevel: string
  personProvider: string
  kycStatus: string
  mandateJti: string
  suspended: boolean
}

/** GET /agents/:beamId/trust-assertion. Org key is required while the agent is unlisted. */
export async function getTrustAssertion(beamId: string, orgApiKey: string, options?: ClientOptions): Promise<TrustAssertionView> {
  const { body } = await request(`/agents/${encodeURIComponent(beamId)}/trust-assertion`, { method: 'GET', apiKey: orgApiKey }, options)
  const org = asRecord(body.org)
  const person = asRecord(body.person)
  const mandate = asRecord(body.mandate)
  return {
    beamId: str(body.beamId) || beamId,
    orgName: str(org.name),
    orgVerified: org.verified === true,
    registryStatus: str(org.registryStatus) || 'none',
    personRole: str(person.role),
    personSubject: person.subject === 'individual' ? 'individual' : person.subject === 'organization' ? 'organization' : '',
    personLevel: str(person.level),
    personProvider: str(person.provider),
    kycStatus: str(person.kycStatus),
    mandateJti: str(mandate.jti),
    suspended: body.suspended === true,
  }
}

/* ------------------------------------------------------------------ Verbinden -------------------------------------------------------------- */

export interface NetworkIdentity {
  beamId: string
  displayName: string
  assured: boolean
  assurance: string
}

/** GET /network/me (routes/network.ts). */
export async function getNetworkIdentity(agentApiKey: string, options?: ClientOptions): Promise<NetworkIdentity> {
  const { body } = await request('/network/me', { method: 'GET', apiKey: agentApiKey }, options)
  const identity = asRecord(body.identity)
  return {
    beamId: str(identity.beamId),
    displayName: str(identity.displayName),
    assured: identity.assured === true,
    assurance: str(identity.assurance) || 'none',
  }
}

export interface ContactRequestResult {
  connectionId: string
  status: string
  recipientBeamId: string
}

/**
 * POST /network/connections (routes/network.ts). Signed exactly like network-v2.js:
 * payload { type: 'network.connection.request', requesterBeamId, recipientBeamId, message } + timestamp + nonce.
 */
export async function sendContactRequest(
  input: { requesterBeamId: string; recipientBeamId: string; message: string; agentApiKey: string; signingKey: CryptoKey },
  options?: ClientOptions,
): Promise<ContactRequestResult> {
  const recipientBeamId = input.recipientBeamId.trim().toLowerCase()
  const signed = await signMutation({
    type: 'network.connection.request',
    requesterBeamId: input.requesterBeamId,
    recipientBeamId,
    message: input.message.trim(),
  }, input.signingKey)
  const { body } = await request('/network/connections', { method: 'POST', apiKey: input.agentApiKey, body: signed }, options)
  const connection = asRecord(body.connection)
  return {
    connectionId: str(connection.connectionId),
    status: str(connection.status) || 'pending',
    recipientBeamId: str(connection.recipientBeamId) || recipientBeamId,
  }
}

/* ------------------------------------------------------------------ Privatperson ---------------------------------------------------------- */

export async function getIdentityProviderStatus(options?: ClientOptions): Promise<{ enabled: boolean }> {
  const baseUrl = (options?.baseUrl ?? directoryApiBase()).replace(/\/$/, '')
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis)
  try {
    const response = await fetchImpl(`${baseUrl}/people/individual/provider`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) return { enabled: false }
    const body = asRecord(await response.json())
    return { enabled: body.enabled === true && body.provider === 'stripe_identity' }
  } catch {
    return { enabled: false }
  }
}

export interface CreatedIndividual {
  personId: string
  apiKey: string
  beamId: string
  identityApiKey: string
  kycStatus: string
}

/** POST /people/individual. Returns the person API key once. */
export async function createIndividual(
  input: { email: string; handle: string; displayName: string; publicKey: string },
  options?: ClientOptions,
): Promise<CreatedIndividual> {
  const { body } = await request('/people/individual', { method: 'POST', body: input }, options)
  const person = asRecord(body.person)
  const identity = asRecord(body.identity)
  const apiKey = str(body.apiKey)
  const personId = str(person.id)
  if (!apiKey || !personId) throw new OnboardingApiError('Directory returned no person key', 500, 'INVALID_RESPONSE')
  return {
    personId,
    apiKey,
    beamId: str(identity.beamId),
    identityApiKey: str(identity.apiKey),
    kycStatus: str(person.kycStatus) || 'unverified',
  }
}

export interface IndividualProfile {
  personId: string
  kycStatus: string
  kycProvider: string | null
}

/** GET /people/individual/me. Used after the person returns from the Stripe-hosted check. */
export async function getIndividualProfile(personApiKey: string, options?: ClientOptions): Promise<IndividualProfile> {
  const { body } = await request('/people/individual/me', { method: 'GET', apiKey: personApiKey }, options)
  const person = asRecord(body.person)
  const personId = str(person.id)
  if (!personId) throw new OnboardingApiError('Directory returned no person', 500, 'INVALID_RESPONSE')
  return {
    personId,
    kycStatus: str(person.kycStatus) || 'unverified',
    kycProvider: strOrNull(person.kycProvider),
  }
}

export interface IdentityVerification {
  sessionId: string
  url: string | null
  status: string
  reused: boolean
}

/** POST /people/individual/verification-sessions. Authenticated. Does not mark the person verified. */
export async function startIndividualVerification(personApiKey: string, options?: ClientOptions): Promise<IdentityVerification> {
  const { body } = await request('/people/individual/verification-sessions', {
    method: 'POST',
    apiKey: personApiKey,
    body: {},
    okStatuses: [409],
  }, options)
  const verification = asRecord(body.verification)
  const sessionId = str(verification.sessionId)
  if (!sessionId) {
    const code = str(body.errorCode) || 'INVALID_RESPONSE'
    throw new OnboardingApiError(str(body.error) || 'Directory returned no verification session', 409, code, body)
  }
  return {
    sessionId,
    url: strOrNull(verification.url),
    status: str(verification.status),
    reused: verification.reused === true || body.errorCode === 'VERIFICATION_SESSION_ACTIVE',
  }
}

export async function registerIndividualAgent(
  input: { agentName: string; displayName: string; publicKey: string; capabilities?: string[]; personApiKey: string },
  options?: ClientOptions,
): Promise<RegisteredAgent> {
  const { body } = await request('/people/individual/agents', {
    method: 'POST',
    apiKey: input.personApiKey,
    body: {
      agentName: input.agentName,
      displayName: input.displayName,
      publicKey: input.publicKey,
      capabilities: input.capabilities ?? [],
    },
  }, options)
  const apiKey = str(body.apiKey)
  if (!apiKey) throw new OnboardingApiError('Directory returned no agent API key', 500, 'INVALID_RESPONSE')
  return {
    beamId: str(body.beamId),
    displayName: str(body.displayName) || input.displayName,
    org: '',
    apiKey,
    responsiblePersonId: strOrNull(body.responsiblePersonId),
  }
}

/* ------------------------------------------------------------------ Interesse -------------------------------------------------------------- */

/**
 * POST /waitlist (server.ts). Records interest in a capability that is not available yet.
 * The response only means "stored"; it never unlocks or verifies anything.
 */
export async function registerInterest(
  input: { email: string; company?: string; capability: Capability; note?: string; honeypot?: string },
  options?: ClientOptions,
): Promise<void> {
  const summary = [`Onboarding-Interesse: ${input.capability}`, input.note?.trim() ? `Notiz: ${input.note.trim()}` : null]
    .filter((line): line is string => Boolean(line))
    .join('\n')
  await request('/waitlist', {
    method: 'POST',
    body: {
      email: input.email.trim().toLowerCase(),
      company: input.company?.trim() || undefined,
      source: 'onboarding-interest',
      workflowType: `onboarding-${input.capability}`.slice(0, 80),
      workflowSummary: summary,
      hp_company: input.honeypot ?? '',
    },
  }, options)
}
