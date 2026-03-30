import { type ClassValue, clsx } from 'clsx'
import { intentLifecycleColor } from './intent-lifecycle'

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

export function formatPercent(value?: number | null, digits = 1): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
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

export function formatChartTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
  }).format(date)
}

export function trustScoreColor(score: number): string {
  if (score < 0.3) return 'bg-red-500'
  if (score < 0.7) return 'bg-yellow-500'
  return 'bg-emerald-500'
}

export function trustScoreTextColor(score: number): string {
  if (score < 0.3) return 'text-red-600 dark:text-red-400'
  if (score < 0.7) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-emerald-600 dark:text-emerald-400'
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

export function intentStatusColor(status: string): string {
  return intentLifecycleColor(status)
}

export function alertSeverityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
    case 'warning':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
    default:
      return 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

export function toBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
}
