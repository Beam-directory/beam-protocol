export const BEAM_MESSAGE_LIFECYCLE = [
  'received',
  'validated',
  'queued',
  'dispatched',
  'delivered',
  'acked',
  'failed',
  'dead_letter',
] as const

export type BeamMessageLifecycleStatus = (typeof BEAM_MESSAGE_LIFECYCLE)[number]

const START = '__start__'

const ALLOWED_TRANSITIONS: Record<BeamMessageLifecycleStatus | typeof START, ReadonlySet<BeamMessageLifecycleStatus>> = {
  [START]: new Set(['received']),
  received: new Set(['received', 'validated', 'queued', 'failed', 'dead_letter', 'dispatched']),
  validated: new Set(['validated', 'queued', 'dispatched', 'failed', 'dead_letter']),
  queued: new Set(['queued', 'dispatched', 'failed', 'dead_letter']),
  dispatched: new Set(['dispatched', 'queued', 'delivered', 'failed', 'dead_letter']),
  delivered: new Set(['delivered', 'acked', 'failed', 'queued', 'dead_letter']),
  acked: new Set(['acked']),
  failed: new Set(['failed', 'queued']),
  dead_letter: new Set(['dead_letter', 'queued']),
}

export function isBeamMessageLifecycleStatus(value: string | null | undefined): value is BeamMessageLifecycleStatus {
  return typeof value === 'string' && BEAM_MESSAGE_LIFECYCLE.includes(value as BeamMessageLifecycleStatus)
}

export function normalizeBeamMessageLifecycleStatus(value: string | null | undefined): BeamMessageLifecycleStatus | null {
  if (!value) {
    return null
  }

  if (isBeamMessageLifecycleStatus(value)) {
    return value
  }

  switch (value) {
    case 'pending':
      return 'queued'
    case 'expired':
      return 'dead_letter'
    default:
      return null
  }
}

export function assertBeamMessageLifecycleTransition(
  previous: BeamMessageLifecycleStatus | null,
  next: BeamMessageLifecycleStatus,
  context = 'beam message lifecycle',
): void {
  const allowed = ALLOWED_TRANSITIONS[previous ?? START]
  if (allowed.has(next)) {
    return
  }

  throw new Error(`Invalid ${context} transition from ${previous ?? 'start'} to ${next}`)
}
