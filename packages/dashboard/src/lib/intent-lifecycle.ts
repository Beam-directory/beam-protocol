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

export function isIntentLifecycleStatus(value: string): value is IntentLifecycleStatus {
  return INTENT_LIFECYCLE_STAGES.includes(value as IntentLifecycleStatus)
}

export function classifyIntentLifecycle(status: string): IntentLifecycleBucket {
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

export function formatIntentLifecycleLabel(status: string): string {
  return status.split('_').join(' ')
}

export function intentLifecycleColor(status: string): string {
  switch (status) {
    case 'acked':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
    case 'failed':
    case 'dead_letter':
      return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
    case 'delivered':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
    case 'validated':
      return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300'
    case 'queued':
      return 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
    default:
      return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
  }
}

export function intentLifecycleDotColor(status: string): string {
  switch (status) {
    case 'acked':
      return 'bg-emerald-500'
    case 'failed':
    case 'dead_letter':
      return 'bg-red-500'
    case 'delivered':
      return 'bg-blue-500'
    case 'validated':
      return 'bg-cyan-500'
    case 'queued':
      return 'bg-violet-500'
    default:
      return 'bg-amber-500'
  }
}

export function intentLifecycleTone(status: string): 'default' | 'success' | 'warning' | 'critical' {
  const bucket = classifyIntentLifecycle(status)
  if (bucket === 'success') {
    return 'success'
  }
  if (bucket === 'error') {
    return 'critical'
  }
  return status === 'delivered' || status === 'validated' ? 'default' : 'warning'
}
