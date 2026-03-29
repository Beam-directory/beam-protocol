import { useEffect, useMemo, useState } from 'react'
import { ApiError, DIRECTORY_URL, clearStoredAdminKey, directoryApi, getStoredAdminKey, hasStoredAdminKey, setStoredAdminKey, type DirectoryHealth, type RetentionResponse } from '../lib/api'

const PRIVATE_KEY_PREFIX = 'beam-dashboard-private-key:'

export default function SettingsPage() {
  const [health, setHealth] = useState<DirectoryHealth | null>(null)
  const [retention, setRetention] = useState<RetentionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adminKey, setAdminKey] = useState(() => getStoredAdminKey())
  const [adminStatus, setAdminStatus] = useState<string | null>(hasStoredAdminKey() ? 'Admin key stored locally.' : null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [healthResponse, retentionResponse] = await Promise.allSettled([
          directoryApi.getHealth(),
          directoryApi.getRetention(),
        ])

        if (cancelled) return

        if (healthResponse.status === 'fulfilled') {
          setHealth(healthResponse.value)
          setError(null)
        } else if (healthResponse.reason instanceof ApiError) {
          setError(healthResponse.reason.message)
        }

        if (retentionResponse.status === 'fulfilled') {
          setRetention(retentionResponse.value)
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

  async function validateAdminKey() {
    try {
      setStoredAdminKey(adminKey)
      await directoryApi.getObservabilityOverview(24)
      setAdminStatus('Admin key validated against observability endpoints.')
    } catch (err) {
      setAdminStatus(err instanceof ApiError ? err.message : 'Admin validation failed')
    }
  }

  function clearAdminKey() {
    clearStoredAdminKey()
    setAdminKey('')
    setAdminStatus('Admin key removed from local storage.')
  }

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Connection health, admin auth, and browser-stored credentials for observability access.</p>
      </section>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

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
          <div className="panel-title">Observability retention</div>
          <InfoRow label="Default days" value={retention ? String(retention.defaultDays) : '—'} />
          <InfoRow label="Datasets" value={retention?.datasets.join(', ') ?? '—'} />
          <p className="text-sm text-slate-500 dark:text-slate-400">Retention controls in the Alerts page call the prune endpoint directly and do not rely on local cache.</p>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel space-y-4">
          <div className="panel-title">Admin access</div>
          <input
            className="input-field"
            placeholder="Paste BEAM_ADMIN_KEY"
            type="password"
            value={adminKey}
            onChange={(event) => setAdminKey(event.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <button className="btn-primary" onClick={() => void validateAdminKey()} type="button">
              Save & Validate
            </button>
            <button className="btn-secondary" onClick={clearAdminKey} type="button">
              Clear
            </button>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            The admin key is stored in `localStorage` and attached to `/observability/*` requests as `X-Admin-Key`.
          </p>
          {adminStatus ? <p className="text-sm text-slate-600 dark:text-slate-300">{adminStatus}</p> : null}
        </div>

        <div className="panel space-y-3">
          <div className="panel-title">Browser storage</div>
          <InfoRow label="Stored private keys" value={String(storedKeys.length)} />
          <InfoRow label="Admin key" value={hasStoredAdminKey() ? 'Stored' : 'Not stored'} />
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
