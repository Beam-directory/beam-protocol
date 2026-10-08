/**
 * TODO Nach Backend-Deploy (#211–#215): registerAgent → POST /orgs/:name/agents mit publicKey + responsiblePersonId;
 * submitBusinessRegistration → POST /orgs/:name/registry; well-known, Personen/KYC/Mandate in CAPABILITIES auf live;
 * Namensraum mit Länderendung (label-suffix) wird dann vom Server akzeptiert.
 *
 * Onboarding API client. ALL onboarding calls go through this module so endpoints can be swapped in one place
 * when the onboarding backend (built in a parallel PR) lands.
 *
 * Live today (routes in packages/directory/src):
 * - createOrg                      POST /orgs                              routes/orgs.ts
 * - getOrg                         GET  /orgs/:name                        routes/orgs.ts
 * - checkDomainVerification        POST /orgs/:name/verify  (DNS TXT)      routes/orgs.ts
 * - registerAgent                  POST /agents/register    (Ed25519 SPKI) routes/agents.ts
 * - submitBusinessRegistration     POST /agents/:beamId/verify-business    routes/business-verify.ts
 *                                  (DE: format check + manual review; UK: Companies House lookup + review)
 * - getBusinessStatus              GET  /agents/:beamId/business-status    routes/business-verify.ts
 * - getNetworkIdentity             GET  /network/me                        routes/network.ts
 * - sendContactRequest             POST /network/connections (signed)      routes/network.ts
 * - registerInterest               POST /waitlist                          server.ts
 *
 * Pending backend (these throw NotAvailableYet and never make a request):
 * - verifyDomainByWellKnownFile    no /.well-known/ verification route
 * - lookupLei                      no LEI lookup
 * - checkPowerOfRepresentation     no Vertretungsberechtigung check
 * - startKyc / getKycStatus        no ID-document KYC
 * - syncEmployeeDirectory          no Personio / Microsoft Entra sync
 * - inviteEmployee                 only admin workspace invitations in the dashboard, not for org identities
 * - issueMandate                   /agents/:beamId/delegate is agent-to-agent with a free-text scope;
 *                                  no person-issued mandate, no amount limits, no escalation
 * - suffixedOrgName                createOrg with a "label-suffix" name (e.g. coppen-at) is sent to POST /orgs, but the
 *                                  current backend still answers 403 ORG_NAMESPACE_DOMAIN_MISMATCH (accepted after #211)
 */
import { directoryApiBase } from './directory-client'
import { signMutation } from './agent-keys'

export type Capability =
  | 'createOrg'
  | 'getOrg'
  | 'checkDomainVerification'
  | 'registerAgent'
  | 'submitBusinessRegistration'
  | 'getBusinessStatus'
  | 'getNetworkIdentity'
  | 'sendContactRequest'
  | 'registerInterest'
  | 'verifyDomainByWellKnownFile'
  | 'lookupLei'
  | 'checkPowerOfRepresentation'
  | 'startKyc'
  | 'getKycStatus'
  | 'syncEmployeeDirectory'
  | 'inviteEmployee'
  | 'issueMandate'
  | 'suffixedOrgName'

export type CapabilityStatus = 'live' | 'unavailable'

export const CAPABILITIES: Record<Capability, CapabilityStatus> = {
  createOrg: 'live',
  getOrg: 'live',
  checkDomainVerification: 'live',
  registerAgent: 'live',
  submitBusinessRegistration: 'live',
  getBusinessStatus: 'live',
  getNetworkIdentity: 'live',
  sendContactRequest: 'live',
  registerInterest: 'live',
  verifyDomainByWellKnownFile: 'unavailable',
  lookupLei: 'unavailable',
  checkPowerOfRepresentation: 'unavailable',
  startKyc: 'unavailable',
  getKycStatus: 'unavailable',
  syncEmployeeDirectory: 'unavailable',
  inviteEmployee: 'unavailable',
  issueMandate: 'unavailable',
  suffixedOrgName: 'unavailable',
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

/** German messages for directory error codes the onboarding can hit. */
const ERROR_MESSAGES: Record<string, string> = {
  INVALID_ORG_NAME: 'Der Namensraum darf nur Kleinbuchstaben, Ziffern, Bindestriche und Unterstriche enthalten.',
  INVALID_DOMAIN: 'Bitte eine gültige Domain angeben, zum Beispiel firma.de.',
  ORG_NAMESPACE_DOMAIN_MISMATCH: 'Der Namensraum muss zum Namen der Domain passen (firma.de → firma).',
  ORG_EXISTS: 'Dieser Namensraum ist bereits an eine verifizierte Firma vergeben.',
  ORG_CLAIM_PENDING: 'Für diesen Namensraum läuft bereits eine Anmeldung. Mit dem Org-Schlüssel kannst du sie fortsetzen.',
  DOMAIN_EXISTS: 'Diese Domain ist bereits einer verifizierten Firma zugeordnet. Melde dich bei uns, falls das nicht stimmt.',
  DOMAIN_CLAIM_PENDING: 'Für diese Domain läuft bereits eine Anmeldung. Mit dem Org-Schlüssel kannst du sie fortsetzen.',
  ORG_CLAIM_EXPIRED: 'Die Anmeldung ist abgelaufen. Bitte die Domain neu beanspruchen.',
  TXT_NOT_FOUND: 'Der DNS-TXT-Eintrag wurde noch nicht gefunden. DNS-Änderungen brauchen manchmal etwas Zeit.',
  DNS_LOOKUP_FAILED: 'Die DNS-Abfrage ist fehlgeschlagen. Bitte später erneut prüfen.',
  UNAUTHORIZED: 'Der Schlüssel ist ungültig.',
  NOT_FOUND: 'Nicht gefunden.',
  ORG_VERIFICATION_REQUIRED: 'Die Domain der Firma muss zuerst verifiziert sein.',
  ORG_OWNERSHIP_REQUIRED: 'Für diese Firma ist ein gültiger Org-Schlüssel nötig.',
  ORG_REGISTRATION_REQUIRED: 'Die Firma muss zuerst angelegt werden.',
  BEAM_ID_ALREADY_REGISTERED: 'Diese Beam-ID ist bereits vergeben.',
  INVALID_BEAM_ID: 'Die Beam-ID hat ein ungültiges Format.',
  INVALID_PUBLIC_KEY_FORMAT: 'Der öffentliche Schlüssel hat ein ungültiges Format.',
  INVALID_REGISTRATION_NUMBER: 'Die Registernummer hat ein ungültiges Format (DE: HRB oder HRA mit Ziffern).',
  INVALID_REQUEST: 'Land, Registernummer und rechtlicher Name sind nötig.',
  COMPANIES_HOUSE_UNAVAILABLE: 'Die Abfrage bei Companies House ist gerade nicht eingerichtet.',
  BUSINESS_VERIFICATION_FAILED: 'Die Registerangaben konnten nicht bestätigt werden.',
  IDENTITY_NOT_ASSURED: 'Dein Agent muss zu einer verifizierten Firma gehören, bevor er Kontakte anfragen kann.',
  INVALID_RECIPIENT: 'Bitte eine andere, gültige Beam-ID angeben.',
  RECIPIENT_NOT_FOUND: 'Diese verifizierte Beam-ID wurde nicht gefunden.',
  MESSAGE_TOO_LONG: 'Die Nachricht darf höchstens 280 Zeichen haben.',
  CONNECTION_EXISTS: 'Zu dieser Beam-ID besteht bereits eine Verbindung oder Anfrage.',
  CONNECTION_BLOCKED: 'Diese Verbindung ist blockiert.',
  INVALID_SIGNATURE: 'Die Signatur konnte nicht geprüft werden.',
  NONCE_REPLAY: 'Diese signierte Anfrage wurde bereits verwendet.',
  INVALID_EMAIL: 'Bitte eine gültige E-Mail-Adresse angeben.',
  RATE_LIMITED: 'Zu viele Anfragen. Bitte kurz warten.',
  NETWORK_ERROR: 'Beam ist gerade nicht erreichbar. Bitte Verbindung prüfen und erneut versuchen.',
}

/**
 * Classifies a failed createOrg (routes/orgs.ts): 'name' = the namespace is taken or pending (409 ORG_EXISTS /
 * ORG_CLAIM_PENDING, a label-suffix name can help), 'domain' = the domain itself is claimed (no suggestion),
 * 'suffix-not-supported' = the backend does not accept label-suffix names yet (403 ORG_NAMESPACE_DOMAIN_MISMATCH).
 */
export function classifyOrgConflict(error: unknown): 'name' | 'domain' | 'suffix-not-supported' | null {
  if (!(error instanceof OnboardingApiError)) return null
  if (error.code === 'ORG_EXISTS' || error.code === 'ORG_CLAIM_PENDING') return 'name'
  if (error.code === 'DOMAIN_EXISTS' || error.code === 'DOMAIN_CLAIM_PENDING') return 'domain'
  if (error.code === 'ORG_NAMESPACE_DOMAIN_MISMATCH') return 'suffix-not-supported'
  return null
}

export function describeError(error: unknown): string {
  if (error instanceof NotAvailableYet) return 'Diese Funktion ist bald verfügbar.'
  if (error instanceof OnboardingApiError) {
    return ERROR_MESSAGES[error.code] ?? (error.message || 'Die Anfrage ist fehlgeschlagen.')
  }
  if (error instanceof Error && error.message) return error.message
  return 'Die Anfrage ist fehlgeschlagen.'
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
  init: { method: 'GET' | 'POST'; body?: unknown; apiKey?: string; okStatuses?: number[] },
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
}

export interface OrgRecord {
  name: string
  displayName: string
  domain: string
  beamDomain: string
  verified: boolean
  claimExpiresAt: string | null
  verifiedAt: string | null
  verification: DnsChallenge | null
}

export interface OrgClaim extends OrgRecord {
  /** Org API key. Secret, returned exactly once by the directory. Keep in memory, never log or persist. */
  apiKey: string
}

function parseOrg(raw: Record<string, unknown>): OrgRecord {
  const verification = asRecord(raw.verification)
  return {
    name: str(raw.name),
    displayName: str(raw.displayName) || str(raw.name),
    domain: str(raw.domain),
    beamDomain: str(raw.beamDomain),
    verified: raw.verified === true,
    claimExpiresAt: strOrNull(raw.claimExpiresAt),
    verifiedAt: strOrNull(raw.verifiedAt),
    verification: verification.txtName && verification.txtValue
      ? { txtName: str(verification.txtName), txtValue: str(verification.txtValue) }
      : null,
  }
}

/** POST /orgs (routes/orgs.ts). Creates a namespace claim and returns the DNS challenge plus the org API key. */
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
  | { verified: true; org: OrgRecord }
  | { verified: false; expected: string; txtName: string; records: string[] }

/** POST /orgs/:name/verify (routes/orgs.ts). Looks up the DNS TXT record; 409 means "not found yet". */
export async function checkDomainVerification(name: string, apiKey: string, options?: ClientOptions): Promise<DomainCheck> {
  const { status, body } = await request(
    `/orgs/${encodeURIComponent(name)}/verify`,
    { method: 'POST', apiKey, okStatuses: [409] },
    options,
  )
  if (status === 409 && body.errorCode === 'TXT_NOT_FOUND') {
    return {
      verified: false,
      expected: str(body.expected),
      txtName: str(body.txtName),
      records: Array.isArray(body.records) ? body.records.filter((value): value is string => typeof value === 'string') : [],
    }
  }
  if (status === 409) {
    throw new OnboardingApiError(str(body.error), status, str(body.errorCode) || 'REQUEST_FAILED', body)
  }
  return { verified: true, org: parseOrg(asRecord(body.org)) }
}

export async function verifyDomainByWellKnownFile(): Promise<never> {
  throw new NotAvailableYet('verifyDomainByWellKnownFile')
}

export async function lookupLei(): Promise<never> {
  throw new NotAvailableYet('lookupLei')
}

export async function checkPowerOfRepresentation(): Promise<never> {
  throw new NotAvailableYet('checkPowerOfRepresentation')
}

export interface BusinessRegistrationInput {
  country: 'DE' | 'UK'
  registrationNumber: string
  legalName: string
}

export interface BusinessRegistrationResult {
  status: 'pending' | 'verified' | 'failed' | string
  reviewRequired: boolean
  message: string
}

/**
 * POST /agents/:beamId/verify-business (routes/business-verify.ts). Needs the agent API key, so it runs after the
 * first agent exists. DE: format check, then manual review. UK: Companies House lookup, then review. Never "verified" here.
 */
export async function submitBusinessRegistration(
  beamId: string,
  agentApiKey: string,
  input: BusinessRegistrationInput,
  options?: ClientOptions,
): Promise<BusinessRegistrationResult> {
  const { body } = await request(
    `/agents/${encodeURIComponent(beamId)}/verify-business`,
    { method: 'POST', apiKey: agentApiKey, body: input },
    options,
  )
  return {
    status: str(body.status) || 'pending',
    reviewRequired: body.reviewRequired === true,
    message: str(body.message),
  }
}

export interface BusinessStatus {
  verified: boolean
  verificationTier: string
  review: { status: string; legalName: string; registrationNumber: string } | null
}

/** GET /agents/:beamId/business-status (routes/business-verify.ts). */
export async function getBusinessStatus(beamId: string, agentApiKey: string, options?: ClientOptions): Promise<BusinessStatus> {
  const { body } = await request(`/agents/${encodeURIComponent(beamId)}/business-status`, { method: 'GET', apiKey: agentApiKey }, options)
  const review = asRecord(body.businessVerification)
  return {
    verified: body.verified === true,
    verificationTier: str(body.verificationTier) || 'basic',
    review: body.businessVerification
      ? { status: str(review.status), legalName: str(review.legalName), registrationNumber: str(review.registrationNumber) }
      : null,
  }
}

/* ------------------------------------------------------------------ Person ----------------------------------------------------------------- */

export async function startKyc(): Promise<never> {
  throw new NotAvailableYet('startKyc')
}

export async function getKycStatus(): Promise<never> {
  throw new NotAvailableYet('getKycStatus')
}

export async function syncEmployeeDirectory(): Promise<never> {
  throw new NotAvailableYet('syncEmployeeDirectory')
}

export async function inviteEmployee(): Promise<never> {
  throw new NotAvailableYet('inviteEmployee')
}

/* ------------------------------------------------------------------ Agent ------------------------------------------------------------------ */

export interface RegisterAgentInput {
  beamId: string
  org: string
  displayName: string
  /** Ed25519 public key, base64 SPKI. Generated in the browser; the private key is never sent. */
  publicKey: string
  /** X25519 public key, base64 SPKI, for end-to-end encryption in /network. */
  dhPublicKey: string
  capabilities?: string[]
  description?: string
}

export interface RegisteredAgent {
  beamId: string
  displayName: string
  org: string
  /** Agent API key (bk_…). Secret, returned once. Keep in memory and in the user's recovery kit only. */
  apiKey: string
  verificationTier: string
}

/** POST /agents/register (routes/agents.ts). Org Beam IDs need the org API key and a verified org domain. */
export async function registerAgent(input: RegisterAgentInput, orgApiKey: string, options?: ClientOptions): Promise<RegisteredAgent> {
  const { body } = await request(
    '/agents/register',
    {
      method: 'POST',
      apiKey: orgApiKey,
      body: {
        beamId: input.beamId,
        org: input.org,
        displayName: input.displayName,
        publicKey: input.publicKey,
        dhPublicKey: input.dhPublicKey,
        capabilities: input.capabilities ?? [],
        ...(input.description ? { description: input.description } : {}),
      },
    },
    options,
  )
  const apiKey = str(body.apiKey)
  if (!apiKey) throw new OnboardingApiError('Directory returned no agent API key', 500, 'INVALID_RESPONSE')
  return {
    beamId: str(body.beamId) || str(body.beam_id) || input.beamId,
    displayName: str(body.displayName) || str(body.display_name) || input.displayName,
    org: str(body.org) || input.org,
    apiKey,
    verificationTier: str(body.verificationTier) || str(body.verification_tier) || 'basic',
  }
}

export type MandateScope =
  | { kind: 'read' }
  | { kind: 'accept-appointments' }
  | { kind: 'send-files' }
  | { kind: 'order'; maxAmountEur: number }
  | { kind: 'escalate'; to: string }

export async function issueMandate(): Promise<never> {
  throw new NotAvailableYet('issueMandate')
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
