import { type ClassValue, clsx } from 'clsx'

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

export function formatRelativeTime(value?: string | number | null): string {
  if (!value) return '—'
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime()
  if (Number.isNaN(timestamp)) return '—'

  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return `${seconds}s ago`
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

export function formatLatency(ms?: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function truncateBeamId(beamId: string, maxLen = 36): string {
  if (beamId.length <= maxLen) return beamId
  return `${beamId.slice(0, maxLen)}…`
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

export function trustScoreColor(score: number): string {
  if (score < 0.3) return 'bg-red-500'
  if (score < 0.7) return 'bg-amber-500'
  return 'bg-emerald-500'
}

export function trustScoreText(score: number): string {
  return `${Math.round(score * 100)}%`
}

export function verificationTierColor(tier: string): string {
  switch (tier) {
    case 'enterprise':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300'
    case 'business':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
    case 'verified':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
    default:
      return 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  }
}

export function toBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
}
