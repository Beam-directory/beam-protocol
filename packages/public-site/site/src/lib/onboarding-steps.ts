/**
 * Pure onboarding logic: validation, step gating and session persistence.
 * Persistence writes only an allow-listed set of non-secret fields to sessionStorage.
 * Org API keys, agent API keys and private keys are never written by this module.
 */
import type { Messages } from '../i18n/en.ts'

export const STEP_IDS = ['firma', 'person', 'agent', 'verbinden'] as const
export type StepId = (typeof STEP_IDS)[number]

export const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
/** Local part accepted by both /agents/register and /network (routes/network.ts BEAM_ID_RE). */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/
const NETWORK_BEAM_ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}@(?:[a-z0-9](?:[a-z0-9.-]{0,124}[a-z0-9])?\.)?beam\.directory$/
const DE_REGISTRATION_RE = /^(HRB|HRA)[\s-]*(\d{1,12})$/i
const UK_REGISTRATION_RE = /^[A-Z0-9]{2,8}$/

/** Common two-label public suffixes. The directory uses the full public suffix list and stays authoritative. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'co.at', 'or.at', 'co.nz', 'co.jp', 'com.br', 'com.tr', 'co.za',
])

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

/** Org namespace the directory expects: the registrable domain without its suffix ("firma.de" -> "firma"). */
export function deriveOrgName(domain: string): string {
  const registrable = registrableDomain(domain)
  return registrable.split('.')[0] ?? ''
}

function slugOrgPart(value: string): string {
  return value.toLowerCase().replace(/[_.]/g, '-')
}

/**
 * Alternative namespace when the plain label is taken, built like the backend (PR #211, trust/org-domain.ts):
 * label of the registrable domain + "-" + public suffix, both slugged. "coppen.at" -> "coppen-at",
 * "coppen.co.uk" -> "coppen-co-uk". Returns null for input that is not a valid domain.
 */
export function suggestDisambiguatedOrgName(domain: string): string | null {
  if (validateDomain(domain)) return null
  const [label, ...suffix] = registrableDomain(domain).split('.')
  if (!label || suffix.length === 0) return null
  return `${slugOrgPart(label)}-${slugOrgPart(suffix.join('.'))}`
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

export function validateRecipientBeamId(value: string, ownBeamId?: string): ValidationKey | null {
  const beamId = value.trim().toLowerCase()
  if (!NETWORK_BEAM_ID_RE.test(beamId)) return 'recipientInvalid'
  if (ownBeamId && beamId === ownBeamId) return 'recipientSelf'
  return null
}

export function validateContactMessage(value: string): ValidationKey | null {
  return value.trim().length > 280 ? 'messageTooLong' : null
}

export type RegistryCountry = 'DE' | 'UK'

export function validateRegistration(country: RegistryCountry, registrationNumber: string, legalName: string): ValidationKey | null {
  if (legalName.trim().length < 2) return 'legalNameRequired'
  const number = registrationNumber.trim().toUpperCase()
  if (country === 'DE' && !DE_REGISTRATION_RE.test(number)) return 'registryDeInvalid'
  if (country === 'UK' && !UK_REGISTRATION_RE.test(number.replace(/\s+/g, ''))) return 'registryUkInvalid'
  return null
}

export function validateEmail(value: string): ValidationKey | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : 'emailInvalid'
}

/* ------------------------------------------------------------- Vollmacht (Entwurf) ---------------------------------------------------------- */

export interface MandateDraft {
  read: boolean
  acceptAppointments: boolean
  sendFiles: boolean
  order: boolean
  orderLimitEur: string
  escalate: boolean
  escalateTo: string
}

export const EMPTY_MANDATE: MandateDraft = {
  read: true,
  acceptAppointments: false,
  sendFiles: true,
  order: false,
  orderLimitEur: '',
  escalate: true,
  escalateTo: '',
}

export function validateMandate(draft: MandateDraft): ValidationKey | null {
  if (!draft.read && !draft.acceptAppointments && !draft.sendFiles && !draft.order) return 'scopeRequired'
  if (draft.order) {
    const amount = Number(draft.orderLimitEur.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return 'orderLimitRequired'
  }
  if (draft.escalate && draft.escalateTo.trim().length < 2) return 'escalateToRequired'
  return null
}

/**
 * Preview of what a future signed mandate would contain. Technical, language-neutral identifiers.
 * It is not issued anywhere.
 */
export function mandatePreview(draft: MandateDraft, beamId: string): Record<string, unknown> {
  const scopes: Record<string, unknown>[] = []
  if (draft.read) scopes.push({ scope: 'read' })
  if (draft.acceptAppointments) scopes.push({ scope: 'appointments.accept' })
  if (draft.sendFiles) scopes.push({ scope: 'files.send' })
  if (draft.order) scopes.push({ scope: 'order', maxAmountEur: Number(draft.orderLimitEur.replace(',', '.')) || 0 })
  return {
    agent: beamId || 'agent@company.beam.directory',
    scopes,
    escalateTo: draft.escalate ? draft.escalateTo.trim() || null : null,
    status: 'draft-not-issued',
  }
}

/* ------------------------------------------------------------- Fortschritt ------------------------------------------------------------------ */

/** Non-secret progress only. Adding a field here is a deliberate decision: never add keys or API keys. */
export interface OnboardingProgress {
  step: number
  displayName: string
  domain: string
  orgName: string
  orgVerified: boolean
  txtName: string
  txtValue: string
  claimExpiresAt: string | null
  registryCountry: RegistryCountry
  registrationNumber: string
  legalName: string
  agentName: string
  agentDisplayName: string
  registeredBeamId: string
}

export const INITIAL_PROGRESS: OnboardingProgress = {
  step: 0,
  displayName: '',
  domain: '',
  orgName: '',
  orgVerified: false,
  txtName: '',
  txtValue: '',
  claimExpiresAt: null,
  registryCountry: 'DE',
  registrationNumber: '',
  legalName: '',
  agentName: '',
  agentDisplayName: '',
  registeredBeamId: '',
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

/** Copies only the allow-listed fields with the right types. Anything else (e.g. apiKey) is dropped. */
export function sanitizeProgress(value: unknown): OnboardingProgress {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const text = (key: keyof OnboardingProgress, max = 260): string => {
    const field = raw[key]
    return typeof field === 'string' ? field.slice(0, max) : String(INITIAL_PROGRESS[key] ?? '')
  }
  const step = typeof raw.step === 'number' && Number.isInteger(raw.step) ? Math.min(Math.max(raw.step, 0), STEP_IDS.length - 1) : 0
  return {
    step,
    displayName: text('displayName', 120),
    domain: text('domain'),
    orgName: text('orgName', 80),
    orgVerified: raw.orgVerified === true,
    txtName: text('txtName'),
    txtValue: text('txtValue'),
    claimExpiresAt: typeof raw.claimExpiresAt === 'string' ? raw.claimExpiresAt.slice(0, 40) : null,
    registryCountry: raw.registryCountry === 'UK' ? 'UK' : 'DE',
    registrationNumber: text('registrationNumber', 40),
    legalName: text('legalName', 200),
    agentName: text('agentName', 63),
    agentDisplayName: text('agentDisplayName', 120),
    registeredBeamId: text('registeredBeamId', 200),
  }
}

export function loadProgress(storage: StorageLike | null = sessionStore()): OnboardingProgress {
  if (!storage) return { ...INITIAL_PROGRESS }
  try {
    const stored = storage.getItem(PROGRESS_STORAGE_KEY)
    return stored ? sanitizeProgress(JSON.parse(stored)) : { ...INITIAL_PROGRESS }
  } catch {
    return { ...INITIAL_PROGRESS }
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
  agentRegistered: boolean
}

/** Whether the user may move on from a step. Steps 2 and 4 are informational or optional and never block. */
export function canAdvance(step: StepId, state: GateState): { ok: boolean; reason?: 'firma' | 'agent' } {
  if (step === 'firma' && !state.orgVerified) {
    return { ok: false, reason: 'firma' }
  }
  if (step === 'agent' && !state.agentRegistered) {
    return { ok: false, reason: 'agent' }
  }
  return { ok: true }
}
