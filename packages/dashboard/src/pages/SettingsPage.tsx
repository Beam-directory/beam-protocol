import { useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  BUS_DEFAULT_URL,
  DIRECTORY_URL,
  busApi,
  clearStoredBusConfig,
  directoryApi,
  getBusBaseUrl,
  getStoredBusApiKey,
  getStoredBusUrl,
  hasStoredAdminSessionToken,
  hasStoredBusApiKey,
  setStoredBusApiKey,
  setStoredBusUrl,
  type BusHealth,
  type BusStats,
  type DirectoryHealth,
  type RetentionResponse,
} from '../lib/api'
import { useAdminAuth } from '../lib/admin-auth'

const PRIVATE_KEY_PREFIX = 'beam-dashboard-private-key:'

export default function SettingsPage() {
  const { session, config, logout } = useAdminAuth()
  const [health, setHealth] = useState<DirectoryHealth | null>(null)
  const [busHealth, setBusHealth] = useState<BusHealth | null>(null)
  const [busStats, setBusStats] = useState<BusStats | null>(null)
  const [retention, setRetention] = useState<RetentionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busUrl, setBusUrl] = useState(() => getStoredBusUrl() || BUS_DEFAULT_URL)
  const [busApiKey, setBusApiKey] = useState(() => getStoredBusApiKey())
  const [busStatus, setBusStatus] = useState<string | null>(hasStoredBusApiKey() || getStoredBusUrl() ? 'Bus configuration stored locally.' : null)

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

        const [busHealthResponse, busStatsResponse] = await Promise.allSettled([
          busApi.getHealth(),
          busApi.getStats(),
        ])

        if (cancelled) return

        if (busHealthResponse.status === 'fulfilled') {
          setBusHealth(busHealthResponse.value)
        }

        if (busStatsResponse.status === 'fulfilled') {
          setBusStats(busStatsResponse.value)
        } else if (busStatsResponse.reason instanceof ApiError) {
          setBusStatus(busStatsResponse.reason.message)
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

  async function validateBusConfig() {
    try {
      setStoredBusUrl(busUrl)
      setStoredBusApiKey(busApiKey)
      const [healthResponse, statsResponse] = await Promise.all([
        busApi.getHealth(),
        busApi.getStats(),
      ])
      setBusHealth(healthResponse)
      setBusStats(statsResponse)
      setBusStatus('Message bus connection validated.')
    } catch (err) {
      setBusStatus(err instanceof ApiError ? err.message : 'Message bus validation failed')
    }
  }

  function clearBusSettings() {
    clearStoredBusConfig()
    setBusUrl(BUS_DEFAULT_URL)
    setBusApiKey('')
    setBusHealth(null)
    setBusStats(null)
    setBusStatus('Message bus URL and API key removed from local storage.')
  }

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Connection health, admin session state, and browser-stored credentials for observability access.</p>
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
          <div className="panel-title">Message bus</div>
          <InfoRow label="Bus URL" value={getBusBaseUrl()} />
          <InfoRow label="Health status" value={busHealth?.status ?? 'Unavailable'} />
          <InfoRow label="Service" value={busHealth?.service ?? '—'} />
          <InfoRow label="Dead letters" value={busStats ? String(busStats.dead_letter) : '—'} />
          <InfoRow label="Pending retries" value={busStats ? String(busStats.pending) : '—'} />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel space-y-4">
          <div className="panel-title">Admin access</div>
          <InfoRow label="Signed in as" value={session?.email ?? 'No active session'} />
          <InfoRow label="Role" value={session?.role ?? '—'} />
          <InfoRow label="Session expires" value={session?.expiresAt ?? '—'} />
          <InfoRow label="Authorized admins configured" value={config?.configured ? 'Yes' : 'No'} />
          <InfoRow label="Magic-link delivery" value={config?.emailDelivery ? 'Email provider configured' : 'Local dev / bootstrap only'} />
          <div className="flex flex-wrap gap-3">
            <button className="btn-secondary" onClick={() => void logout()} type="button">
              Sign out
            </button>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Observability requests now use an authenticated admin session instead of a pasted static browser key.
          </p>
        </div>

        <div className="panel space-y-4">
          <div className="panel-title">Message bus access</div>
          <input
            className="input-field"
            placeholder={BUS_DEFAULT_URL}
            type="text"
            value={busUrl}
            onChange={(event) => setBusUrl(event.target.value)}
          />
          <input
            className="input-field"
            placeholder="Paste BEAM_BUS_API_KEY"
            type="password"
            value={busApiKey}
            onChange={(event) => setBusApiKey(event.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <button className="btn-primary" onClick={() => void validateBusConfig()} type="button">
              Save & Validate
            </button>
            <button className="btn-secondary" onClick={clearBusSettings} type="button">
              Clear
            </button>
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Dead-letter requests use the configured URL and attach the bus API key as `Authorization: Bearer ...`.
          </p>
          {busStatus ? <p className="text-sm text-slate-600 dark:text-slate-300">{busStatus}</p> : null}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel space-y-3">
          <div className="panel-title">Observability retention</div>
          <InfoRow label="Default days" value={retention ? String(retention.defaultDays) : '—'} />
          <InfoRow label="Datasets" value={retention?.datasets.join(', ') ?? '—'} />
          <p className="text-sm text-slate-500 dark:text-slate-400">Retention controls in the Alerts page call the prune endpoint directly and do not rely on local cache.</p>
        </div>

        <div className="panel space-y-3">
          <div className="panel-title">Browser storage</div>
          <InfoRow label="Stored private keys" value={String(storedKeys.length)} />
          <InfoRow label="Admin session token" value={hasStoredAdminSessionToken() ? 'Stored' : 'Not stored'} />
          <InfoRow label="Bus API key" value={hasStoredBusApiKey() ? 'Stored' : 'Not stored'} />
          <InfoRow label="Bus URL" value={getStoredBusUrl() || BUS_DEFAULT_URL} />
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
