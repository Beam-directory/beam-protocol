/**
 * Pure onboarding logic: validation, step gating and session persistence.
 * Persistence writes only an allow-listed set of non-secret fields to sessionStorage.
 * Org API keys, agent API keys, invitation tokens and private keys are never written by this module.
 */
import type { Messages } from '../i18n/en.ts'

export const STEP_IDS = ['firma', 'person', 'agent', 'verbinden'] as const
export type StepId = (typeof STEP_IDS)[number]

export const INDIVIDUAL_STEP_IDS = ['address', 'identity', 'agent', 'verbinden'] as const
export type IndividualStepId = (typeof INDIVIDUAL_STEP_IDS)[number]
export type OnboardingPath = '' | 'organization' | 'individual'

/** Same local part as POST /people/individual and POST /identity-claims. Address is `{handle}@beam.directory`. */
const PERSONAL_HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/

export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
/** Local part accepted by POST /orgs/:name/agents and /network (routes/network.ts BEAM_ID_RE). */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/
const NETWORK_BEAM_ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}@(?:[a-z0-9](?:[a-z0-9.-]{0,124}[a-z0-9])?\.)?beam\.directory$/
const DE_REGISTRATION_RE = /^(HRB|HRA)[\s-]*(\d{1,12})$/i
const AMOUNT_RE = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/

/** Common two-label public suffixes. The directory uses the full public suffix list and stays authoritative. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'co.at', 'or.at', 'co.nz', 'co.jp', 'com.br', 'com.tr', 'co.za',
])

export const APPLICANT_ROLES = [
  'geschaeftsfuehrer',
  'vorstand',
  'prokurist',
  'inhaber',
  'director',
  'authorized_signatory',
] as const
export type ApplicantRole = (typeof APPLICANT_ROLES)[number]

export type RegistryKind = 'handelsregister' | 'lei'
export type KycStatus = 'unverified' | 'pending' | 'verified' | 'rejected'
export type ScopeAction = 'read' | 'schedule.commit' | 'file.send' | 'order'

export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
}

/** Registrable domain, e.g. "www.team.firma.de" -> "firma.de". */
export function registrableDomain(domain: string): string {
  const labels = normalizeDomain(domain).split('.').filter(Boolean)
  if (labels.length < 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3 ? 3 : 2
  return labels.slice(-take).join('.')
}

/** Short label the directory grants after verification, when it is free ("firma.de" -> "firma"). */
export function deriveOrgName(domain: string): string {
  const registrable = registrableDomain(domain)
  return registrable.split('.')[0] ?? ''
}

/** Validators return a key of the validation dictionary (src/i18n); the UI renders it in the active language. */
export type ValidationKey = keyof Messages['validation']

export function validateDomain(domain: string): ValidationKey | null {
  const normalized = normalizeDomain(domain)
  if (!normalized) return 'domainRequired'
  if (!DOMAIN_RE.test(normalized)) return 'domainInvalid'
  if (!/^[a-z0-9_-]+$/.test(deriveOrgName(normalized))) return 'domainNoNamespace'
  return null
}

export function validateDisplayName(name: string): ValidationKey | null {
  const trimmed = name.trim()
  if (trimmed.length < 2) return 'nameRequired'
  if (trimmed.length > 120) return 'nameTooLong'
  return null
}

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase()
}

export function validateAgentName(value: string): ValidationKey | null {
  const name = normalizeAgentName(value)
  if (!name) return 'agentNameRequired'
  if (!AGENT_NAME_RE.test(name)) return 'agentNameInvalid'
  return null
}

export function buildBeamId(agentName: string, orgName: string): string {
  return `${normalizeAgentName(agentName)}@${orgName}.beam.directory`
}

export function validatePersonalHandle(value: string): ValidationKey | null {
  const handle = value.trim().toLowerCase()
  if (!handle) return 'handleRequired'
  if (!PERSONAL_HANDLE_RE.test(handle)) return 'handleInvalid'
  return null
}

export function personalBeamId(handle: string): string {
  return `${handle.trim().toLowerCase()}@beam.directory`
}

export function validateRecipientBeamId(value: string, ownBeamId?: string): ValidationKey | null {
  const beamId = value.trim().toLowerCase()
  if (!NETWORK_BEAM_ID_RE.test(beamId)) return 'recipientInvalid'
  if (ownBeamId && beamId === ownBeamId) return 'recipientSelf'
  return null
}

export function validateContactMessage(value: string): ValidationKey | null {
  return value.trim().length > 280 ? 'messageTooLong' : null
}

export function validateEmail(value: string): ValidationKey | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : 'emailInvalid'
}

export function validateRole(value: string): ValidationKey | null {
  const role = value.trim()
  if (role.length < 1 || role.length > 80) return 'roleRequired'
  return null
}

/** ISO 7064 checksum, same rule as packages/directory/src/trust/registry-format.ts. */
export function isValidLei(value: string): boolean {
  const lei = value.trim().toUpperCase()
  if (!/^[A-Z0-9]{20}$/.test(lei)) return false
  let expanded = ''
  for (const char of lei) {
    const code = char.charCodeAt(0)
    expanded += code >= 65 ? String(code - 55) : char
  }
  let remainder = 0
  for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97
  return remainder === 1
}

export function validateRegistry(input: {
  kind: RegistryKind
  registrationNumber: string
  legalName: string
  registerCourt: string
  applicantName: string
  applicantRole: string
  leiCountry: string
}): ValidationKey | null {
  if (input.legalName.trim().length < 2 || input.legalName.trim().length > 200) return 'legalNameRequired'
  if (input.applicantName.trim().length < 2) return 'applicantNameRequired'
  if (!APPLICANT_ROLES.includes(input.applicantRole as ApplicantRole)) return 'applicantRoleRequired'
  if (input.kind === 'handelsregister') {
    if (!DE_REGISTRATION_RE.test(input.registrationNumber.trim().toUpperCase())) return 'registryDeInvalid'
    const court = input.registerCourt.trim()
    if (court.length < 2 || court.length > 160) return 'registerCourtRequired'
    return null
  }
  if (!/^[A-Za-z]{2}$/.test(input.leiCountry.trim())) return 'leiCountryInvalid'
  if (!isValidLei(input.registrationNumber)) return 'leiInvalid'
  return null
}

/* ------------------------------------------------------------- Scopes ---------------------------------------------------------------------- */

export interface ScopeDraft {
  read: boolean
  schedule: boolean
  files: boolean
  order: boolean
  orderLimitEur: string
}

export const EMPTY_SCOPE: ScopeDraft = {
  read: true,
  schedule: false,
  files: true,
  order: false,
  orderLimitEur: '',
}

export interface ScopeGrant {
  actions: ScopeAction[]
  order?: { maxAmount: string; currency: 'EUR' }
}

/** "500", "500.5" and "500,50" become an amount the directory accepts. Zero is rejected. */
export function normalizeAmount(value: string): string | null {
  const trimmed = value.trim().replace(',', '.')
  if (!AMOUNT_RE.test(trimmed)) return null
  const [whole, fraction = ''] = trimmed.split('.')
  const cents = BigInt(`${whole}${fraction.padEnd(2, '0')}`)
  if (cents <= 0n) return null
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`
}

export function scopeGrantFromDraft(draft: ScopeDraft): { grant: ScopeGrant } | { error: ValidationKey } {
  const actions: ScopeAction[] = []
  if (draft.read) actions.push('read')
  if (draft.schedule) actions.push('schedule.commit')
  if (draft.files) actions.push('file.send')
  let order: ScopeGrant['order']
  if (draft.order) {
    const amount = normalizeAmount(draft.orderLimitEur)
    if (!amount) return { error: 'orderLimitRequired' }
    actions.push('order')
    order = { maxAmount: amount, currency: 'EUR' }
  }
  if (actions.length === 0) return { error: 'scopeRequired' }
  return { grant: { actions, ...(order ? { order } : {}) } }
}

function amountToCents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(`${whole}${fraction.padEnd(2, '0')}`)
}

/** Same inclusion rule as packages/directory/src/trust/scopes.ts scopeWithin, for the EUR orders this form issues. */
export function scopeWithin(child: ScopeGrant, parent: ScopeGrant): boolean {
  if (child.actions.some((action) => !parent.actions.includes(action))) return false
  if (child.actions.includes('order')) {
    if (!parent.order || !child.order || parent.order.currency !== child.order.currency) return false
    if (amountToCents(child.order.maxAmount) > amountToCents(parent.order.maxAmount)) return false
  }
  return true
}

export const MANDATE_TTL_MS = 90 * 24 * 60 * 60 * 1000

export interface MandatePayload {
  type: 'mandate'
  jti: string
  version: 1
  personId: string
  agentBeamId: string
  org: string | null
  scopes: ScopeGrant
  expiresAt: string
  escalationPersonId: null
}

/** Exact object the directory verifies. escalationPersonId is null because the first person has no supervisor. */
export function mandatePayload(input: {
  jti: string
  personId: string
  agentBeamId: string
  org: string | null
  scopes: ScopeGrant
  expiresAt: string
}): MandatePayload {
  return {
    type: 'mandate',
    jti: input.jti,
    version: 1,
    personId: input.personId,
    agentBeamId: input.agentBeamId,
    org: input.org,
    scopes: input.scopes,
    expiresAt: input.expiresAt,
    escalationPersonId: null,
  }
}

/* ------------------------------------------------------------- Fortschritt ------------------------------------------------------------------ */

/** Non-secret progress only. Adding a field here is a deliberate decision: never add keys, API keys or invitation tokens. */
export interface OnboardingProgress {
  step: number
  path: OnboardingPath
  personalHandle: string
  displayName: string
  domain: string
  orgName: string
  requestedOrgName: string
  orgVerified: boolean
  domainVerifiedVia: '' | 'dns' | 'well-known'
  txtName: string
  txtValue: string
  wellKnownUrl: string
  wellKnownBody: string
  claimExpiresAt: string | null
  registryKind: RegistryKind
  registrationNumber: string
  legalName: string
  registerCourt: string
  applicantName: string
  applicantRole: ApplicantRole | ''
  leiCountry: string
  registryStatus: string
  personId: string
  personEmail: string
  personDisplayName: string
  personRole: string
  personKycStatus: '' | KycStatus
  personKycProvider: string
  personRights: ScopeDraft
  agentName: string
  agentDisplayName: string
  registeredBeamId: string
  encryptionKeyPublished: boolean
  mandateJti: string
  mandateStatus: string
}

export const INITIAL_PROGRESS: OnboardingProgress = {
  step: 0,
  path: '',
  personalHandle: '',
  displayName: '',
  domain: '',
  orgName: '',
  requestedOrgName: '',
  orgVerified: false,
  domainVerifiedVia: '',
  txtName: '',
  txtValue: '',
  wellKnownUrl: '',
  wellKnownBody: '',
  claimExpiresAt: null,
  registryKind: 'handelsregister',
  registrationNumber: '',
  legalName: '',
  registerCourt: '',
  applicantName: '',
  applicantRole: '',
  leiCountry: 'DE',
  registryStatus: '',
  personId: '',
  personEmail: '',
  personDisplayName: '',
  personRole: '',
  personKycStatus: '',
  personKycProvider: '',
  personRights: { ...EMPTY_SCOPE },
  agentName: '',
  agentDisplayName: '',
  registeredBeamId: '',
  encryptionKeyPublished: false,
  mandateJti: '',
  mandateStatus: '',
}

export const PROGRESS_STORAGE_KEY = 'beam.onboarding.progress.v1'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function sessionStore(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

function readScope(value: unknown): ScopeDraft {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!raw) return { ...EMPTY_SCOPE }
  return {
    read: raw.read === true,
    schedule: raw.schedule === true,
    files: raw.files === true,
    order: raw.order === true,
    orderLimitEur: typeof raw.orderLimitEur === 'string' ? raw.orderLimitEur.slice(0, 20) : '',
  }
}

/** Copies only the allow-listed fields with the right types. Anything else (e.g. apiKey) is dropped. */
export function sanitizeProgress(value: unknown): OnboardingProgress {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const text = (key: keyof OnboardingProgress, max = 260): string => {
    const field = raw[key]
    return typeof field === 'string' ? field.slice(0, max) : String(INITIAL_PROGRESS[key] ?? '')
  }
  const step = typeof raw.step === 'number' && Number.isInteger(raw.step) ? Math.min(Math.max(raw.step, 0), STEP_IDS.length - 1) : 0
  const kyc = raw.personKycStatus
  const role = raw.applicantRole
  const path: OnboardingPath = raw.path === 'individual' || raw.path === 'organization' || raw.path === ''
    ? raw.path
    : 'organization'
  return {
    step,
    path,
    personalHandle: text('personalHandle', 32).toLowerCase(),
    displayName: text('displayName', 120),
    domain: text('domain'),
    orgName: text('orgName', 80),
    requestedOrgName: text('requestedOrgName', 80),
    orgVerified: raw.orgVerified === true,
    domainVerifiedVia: raw.domainVerifiedVia === 'dns' || raw.domainVerifiedVia === 'well-known' ? raw.domainVerifiedVia : '',
    txtName: text('txtName'),
    txtValue: text('txtValue'),
    wellKnownUrl: text('wellKnownUrl'),
    wellKnownBody: text('wellKnownBody'),
    claimExpiresAt: typeof raw.claimExpiresAt === 'string' ? raw.claimExpiresAt.slice(0, 40) : null,
    registryKind: raw.registryKind === 'lei' ? 'lei' : 'handelsregister',
    registrationNumber: text('registrationNumber', 40),
    legalName: text('legalName', 200),
    registerCourt: text('registerCourt', 160),
    applicantName: text('applicantName', 200),
    applicantRole: typeof role === 'string' && APPLICANT_ROLES.includes(role as ApplicantRole) ? role as ApplicantRole : '',
    leiCountry: text('leiCountry', 2).toUpperCase() || 'DE',
    registryStatus: text('registryStatus', 20),
    personId: text('personId', 80),
    personEmail: text('personEmail', 200),
    personDisplayName: text('personDisplayName', 120),
    personRole: text('personRole', 80),
    personKycStatus: kyc === 'unverified' || kyc === 'pending' || kyc === 'verified' || kyc === 'rejected' ? kyc : '',
    personKycProvider: text('personKycProvider', 40),
    personRights: readScope(raw.personRights),
    agentName: text('agentName', 63),
    agentDisplayName: text('agentDisplayName', 120),
    registeredBeamId: text('registeredBeamId', 200),
    encryptionKeyPublished: raw.encryptionKeyPublished === true,
    mandateJti: text('mandateJti', 80),
    mandateStatus: text('mandateStatus', 20),
  }
}

export function loadProgress(storage: StorageLike | null = sessionStore()): OnboardingProgress {
  if (!storage) return { ...INITIAL_PROGRESS, personRights: { ...EMPTY_SCOPE } }
  try {
    const stored = storage.getItem(PROGRESS_STORAGE_KEY)
    return stored ? sanitizeProgress(JSON.parse(stored)) : { ...INITIAL_PROGRESS, personRights: { ...EMPTY_SCOPE } }
  } catch {
    return { ...INITIAL_PROGRESS, personRights: { ...EMPTY_SCOPE } }
  }
}

export function saveProgress(progress: OnboardingProgress, storage: StorageLike | null = sessionStore()): void {
  if (!storage) return
  try {
    storage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(sanitizeProgress(progress)))
  } catch {
    // Storage can be full or disabled; onboarding keeps working in memory.
  }
}

export function clearProgress(storage: StorageLike | null = sessionStore()): void {
  try {
    storage?.removeItem(PROGRESS_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------- Schritt-Freigabe ------------------------------------------------------------- */

export interface GateState {
  orgVerified: boolean
  orgKeyInMemory: boolean
  personReady: boolean
  agentRegistered: boolean
}

/** Whether the user may move on from a step. Connect is optional and never blocks. */
export function canAdvance(step: StepId, state: GateState): { ok: boolean; reason?: 'firma' | 'person' | 'agent' } {
  if (step === 'firma' && !state.orgVerified) return { ok: false, reason: 'firma' }
  if (step === 'person' && !state.personReady) return { ok: false, reason: 'person' }
  if (step === 'agent' && !state.agentRegistered) return { ok: false, reason: 'agent' }
  return { ok: true }
}

export function canAdvanceIndividual(
  step: IndividualStepId,
  state: { addressReady: boolean; identityVerified: boolean; agentRegistered: boolean },
): { ok: boolean; reason?: 'address' | 'identity' | 'agent' } {
  if (step === 'address' && !state.addressReady) return { ok: false, reason: 'address' }
  if (step === 'identity' && !state.identityVerified) return { ok: false, reason: 'identity' }
  if (step === 'agent' && !state.agentRegistered) return { ok: false, reason: 'agent' }
  return { ok: true }
}
