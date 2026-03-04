import { type ClassValue, clsx } from 'clsx'

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return `${seconds}s ago`
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

export function formatLatency(ms?: number): string {
  if (ms === undefined || ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function truncateBeamId(beamId: string, maxLen = 30): string {
  if (beamId.length <= maxLen) return beamId
  return beamId.slice(0, maxLen) + '…'
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

export function trustScoreColor(score: number): string {
  if (score >= 75) return '#39d98a'
  if (score >= 50) return '#4c9cf1'
  if (score >= 25) return '#f7c603'
  return '#f75c5c'
}

export function generateKeyHash(): string {
  const array = new Uint8Array(16)
  crypto.getRandomValues(array)
  return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('')
}
