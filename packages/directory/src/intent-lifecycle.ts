export const INTENT_LIFECYCLE_STAGES = [
  'received',
  'validated',
  'queued',
  'dispatched',
  'delivered',
  'acked',
  'failed',
  'dead_letter',
] as const

export type IntentLifecycleStatus = (typeof INTENT_LIFECYCLE_STAGES)[number]
export type IntentLifecycleBucket = 'success' | 'error' | 'in_flight'

const START = '__start__'

const ALLOWED_TRANSITIONS: Record<IntentLifecycleStatus | typeof START, ReadonlySet<IntentLifecycleStatus>> = {
  [START]: new Set(['received']),
  received: new Set(['received', 'validated', 'queued', 'failed', 'dead_letter']),
  validated: new Set(['validated', 'queued', 'dispatched', 'failed', 'dead_letter']),
  queued: new Set(['queued', 'dispatched', 'failed', 'dead_letter']),
  dispatched: new Set(['dispatched', 'queued', 'delivered', 'failed', 'dead_letter']),
  delivered: new Set(['delivered', 'acked', 'failed', 'queued', 'dead_letter']),
  acked: new Set(['acked']),
  failed: new Set(['failed', 'queued']),
  dead_letter: new Set(['dead_letter', 'queued']),
}

export function isIntentLifecycleStatus(value: string | null | undefined): value is IntentLifecycleStatus {
  return typeof value === 'string' && INTENT_LIFECYCLE_STAGES.includes(value as IntentLifecycleStatus)
}

export function normalizeIntentLifecycleStatus(value: string | null | undefined): IntentLifecycleStatus | null {
  if (!value) {
    return null
  }

  if (isIntentLifecycleStatus(value)) {
    return value
  }

  switch (value) {
    case 'pending':
      return 'received'
    case 'success':
      return 'acked'
    case 'error':
      return 'failed'
    case 'expired':
      return 'dead_letter'
    default:
      return null
  }
}

export function classifyIntentLifecycle(status: IntentLifecycleStatus): IntentLifecycleBucket {
  switch (status) {
    case 'acked':
      return 'success'
    case 'failed':
    case 'dead_letter':
      return 'error'
    default:
      return 'in_flight'
  }
}

export function isIntentLifecycleTerminal(status: IntentLifecycleStatus): boolean {
  return classifyIntentLifecycle(status) !== 'in_flight'
}

export function isIntentLifecycleSuccess(status: IntentLifecycleStatus): boolean {
  return status === 'acked'
}

export function isIntentLifecycleFailure(status: IntentLifecycleStatus): boolean {
  return status === 'failed' || status === 'dead_letter'
}

export function isIntentLifecycleInFlight(status: IntentLifecycleStatus): boolean {
  return !isIntentLifecycleTerminal(status)
}

export function assertIntentLifecycleTransition(
  previous: IntentLifecycleStatus | null,
  next: IntentLifecycleStatus,
  context = 'intent lifecycle',
): void {
  const allowed = ALLOWED_TRANSITIONS[previous ?? START]
  if (allowed.has(next)) {
    return
  }

  throw new Error(`Invalid ${context} transition from ${previous ?? 'start'} to ${next}`)
}

export function normalizeLegacyTraceLifecycle(
  stage: string,
  status: string,
): IntentLifecycleStatus | null {
  const normalizedStage = normalizeIntentLifecycleStatus(stage)
  if (normalizedStage) {
    return normalizedStage
  }

  switch (stage) {
    case 'sender_lookup':
      return 'received'
    case 'validated':
      return status === 'error' ? 'failed' : 'validated'
    case 'dispatch':
      return 'dispatched'
    case 'delivery':
      if (status === 'success') {
        return 'delivered'
      }
      return status === 'error' ? 'failed' : 'dispatched'
    case 'federation.resolve':
      return status === 'error' ? 'failed' : 'dispatched'
    case 'federation.relay':
      if (status === 'success') {
        return 'delivered'
      }
      return status === 'error' ? 'failed' : 'dispatched'
    case 'completed':
      return status === 'success' ? 'acked' : 'failed'
    case 'dedupe':
      return null
    default:
      return normalizeIntentLifecycleStatus(status)
  }
}
