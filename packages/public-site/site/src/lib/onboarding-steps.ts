/**
 * Pure onboarding logic: validation, step gating and session persistence.
 * Persistence writes only an allow-listed set of non-secret fields to sessionStorage.
 * Org API keys, agent API keys and private keys are never written by this module.
 */

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

export function validateDomain(domain: string): string | null {
  const normalized = normalizeDomain(domain)
  if (!normalized) return 'Bitte die Domain der Firma angeben.'
  if (!DOMAIN_RE.test(normalized)) return 'Bitte eine gültige Domain angeben, zum Beispiel firma.de.'
  if (!/^[a-z0-9_-]+$/.test(deriveOrgName(normalized))) return 'Aus dieser Domain lässt sich kein Namensraum ableiten.'
  return null
}

export function validateDisplayName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.length < 2) return 'Bitte den Namen angeben.'
  if (trimmed.length > 120) return 'Der Name ist zu lang.'
  return null
}

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase()
}

export function validateAgentName(value: string): string | null {
  const name = normalizeAgentName(value)
  if (!name) return 'Bitte einen Namen für die Adresse angeben.'
  if (!AGENT_NAME_RE.test(name)) {
    return '2 bis 63 Zeichen: Kleinbuchstaben, Ziffern, Bindestrich oder Unterstrich, beginnend mit Buchstabe oder Ziffer.'
  }
  return null
}

export function buildBeamId(agentName: string, orgName: string): string {
  return `${normalizeAgentName(agentName)}@${orgName}.beam.directory`
}

export function validateRecipientBeamId(value: string, ownBeamId?: string): string | null {
  const beamId = value.trim().toLowerCase()
  if (!NETWORK_BEAM_ID_RE.test(beamId)) return 'Bitte eine gültige Beam-ID angeben, zum Beispiel lakis@partner.beam.directory.'
  if (ownBeamId && beamId === ownBeamId) return 'Das ist die Beam-ID deines eigenen Agenten.'
  return null
}

export function validateContactMessage(value: string): string | null {
  return value.trim().length > 280 ? 'Die Nachricht darf höchstens 280 Zeichen haben.' : null
}

export type RegistryCountry = 'DE' | 'UK'

export function validateRegistration(country: RegistryCountry, registrationNumber: string, legalName: string): string | null {
  if (legalName.trim().length < 2) return 'Bitte den rechtlichen Namen laut Register angeben.'
  const number = registrationNumber.trim().toUpperCase()
  if (country === 'DE' && !DE_REGISTRATION_RE.test(number)) return 'Deutsche Registernummer: HRB oder HRA mit Ziffern, zum Beispiel HRB 123456.'
  if (country === 'UK' && !UK_REGISTRATION_RE.test(number.replace(/\s+/g, ''))) return 'UK Company Number: 2 bis 8 Buchstaben oder Ziffern.'
  return null
}

export function validateEmail(value: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : 'Bitte eine gültige E-Mail-Adresse angeben.'
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

export function validateMandate(draft: MandateDraft): string | null {
  if (!draft.read && !draft.acceptAppointments && !draft.sendFiles && !draft.order) return 'Bitte mindestens eine Befugnis wählen.'
  if (draft.order) {
    const amount = Number(draft.orderLimitEur.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return 'Bitte einen Höchstbetrag für Bestellungen angeben.'
  }
  if (draft.escalate && draft.escalateTo.trim().length < 2) return 'Bitte angeben, an wen eskaliert wird.'
  return null
}

/** Readable preview of what a future signed mandate would contain. It is not issued anywhere. */
export function mandatePreview(draft: MandateDraft, beamId: string): Record<string, unknown> {
  const scopes: Record<string, unknown>[] = []
  if (draft.read) scopes.push({ scope: 'lesen' })
  if (draft.acceptAppointments) scopes.push({ scope: 'termine.zusagen' })
  if (draft.sendFiles) scopes.push({ scope: 'dateien.senden' })
  if (draft.order) scopes.push({ scope: 'bestellen', maxBetragEur: Number(draft.orderLimitEur.replace(',', '.')) || 0 })
  return {
    agent: beamId || 'agent@firma.beam.directory',
    scopes,
    eskalation: draft.escalate ? draft.escalateTo.trim() || 'Vorgesetzte Person' : null,
    status: 'Entwurf, nicht ausgestellt',
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
export function canAdvance(step: StepId, state: GateState): { ok: boolean; reason?: string } {
  if (step === 'firma' && !state.orgVerified) {
    return { ok: false, reason: 'Weiter geht es, sobald die Domain der Firma verifiziert ist.' }
  }
  if (step === 'agent' && !state.agentRegistered) {
    return { ok: false, reason: 'Weiter geht es, sobald der Agent registriert ist.' }
  }
  return { ok: true }
}
