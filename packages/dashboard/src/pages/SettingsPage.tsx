import { useEffect, useMemo, useState } from 'react'
import { ApiError, DIRECTORY_URL, directoryApi, type DirectoryHealth } from '../lib/api'

const PRIVATE_KEY_PREFIX = 'beam-dashboard-private-key:'

export default function SettingsPage() {
  const [health, setHealth] = useState<DirectoryHealth | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const response = await directoryApi.getHealth()
        if (!cancelled) {
          setHealth(response)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to reach the directory API')
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const storedKeys = useMemo(() => {
    return Object.keys(localStorage).filter((key) => key.startsWith(PRIVATE_KEY_PREFIX))
  }, [])

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Operational status for the real API connection and browser-stored credentials.</p>
      </section>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel space-y-3">
          <div className="panel-title">API connection</div>
          <InfoRow label="Directory URL" value={DIRECTORY_URL} />
          <InfoRow label="Health status" value={health?.status ?? 'Unavailable'} />
          <InfoRow label="Protocol" value={health?.protocol ?? '—'} />
          <InfoRow label="Connected agents" value={health ? String(health.connectedAgents) : '—'} />
          <InfoRow label="Last heartbeat" value={health?.timestamp ?? '—'} />
        </div>

        <div className="panel space-y-3">
          <div className="panel-title">Browser storage</div>
          <InfoRow label="Stored private keys" value={String(storedKeys.length)} />
          <p className="text-sm text-slate-500 dark:text-slate-400">Private keys generated on the Register page stay in `localStorage` for this browser profile only.</p>
        </div>
      </section>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 break-all text-sm font-medium">{value}</div>
    </div>
  )
}
