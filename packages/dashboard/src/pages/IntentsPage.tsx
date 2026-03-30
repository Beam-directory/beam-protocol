import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Radio, Search } from 'lucide-react'
import { ApiError, connectIntentFeed, directoryApi, type RecentIntent } from '../lib/api'
import { PageHeader, StatusPill } from '../components/Observability'
import { cn, formatDateTime, formatLatency, intentStatusColor, truncateBeamId } from '../lib/utils'
import { classifyIntentLifecycle, formatIntentLifecycleLabel } from '../lib/intent-lifecycle'

const WINDOW_OPTIONS = [
  { value: 24, label: '24h' },
  { value: 24 * 7, label: '7d' },
]

const STATUS_OPTIONS = [
  { value: 'all', label: 'All lifecycle states' },
  { value: 'error', label: 'Failed or dead letter' },
  { value: 'success', label: 'Acked' },
  { value: 'in_flight', label: 'In flight' },
  { value: 'received', label: 'Received' },
  { value: 'validated', label: 'Validated' },
  { value: 'queued', label: 'Queued' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'acked', label: 'Acked' },
  { value: 'failed', label: 'Failed' },
  { value: 'dead_letter', label: 'Dead letter' },
]

function matchesFilters(intent: RecentIntent, filters: {
  query: string
  status: string
  hours: number
}) {
  const lifecycleClass = classifyIntentLifecycle(intent.status)
  const matchesStatus = filters.status === 'all'
    || (filters.status === 'in_flight' ? lifecycleClass === 'in_flight' : false)
    || (filters.status === 'error' ? lifecycleClass === 'error' : false)
    || (filters.status === 'success' ? lifecycleClass === 'success' : false)
    || intent.status === filters.status
  const matchesQuery = !filters.query || [
    intent.nonce,
    intent.from,
    intent.to,
    intent.intentType,
    intent.errorCode ?? '',
  ].join(' ').toLowerCase().includes(filters.query.toLowerCase())

  if (!matchesStatus || !matchesQuery) {
    return false
  }

  const threshold = Date.now() - filters.hours * 60 * 60 * 1000
  return new Date(intent.timestamp).getTime() >= threshold
}

export default function IntentsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [intents, setIntents] = useState<RecentIntent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [socketState, setSocketState] = useState<'connecting' | 'live' | 'offline'>('connecting')
  const socketRef = useRef<WebSocket | null>(null)
  const query = searchParams.get('q') ?? ''
  const status = searchParams.get('status') ?? 'all'
  const hours = Number.parseInt(searchParams.get('hours') ?? '24', 10) || 24
  const alertId = searchParams.get('alert')
  const hasDeepLinkFilters = Boolean(alertId || query || status !== 'all' || hours !== 24)

  function updateSearchParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (!value || (key === 'status' && value === 'all') || (key === 'hours' && value === '24')) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    setSearchParams(next, { replace: true })
  }

  function clearFilters() {
    setSearchParams({}, { replace: true })
  }

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const response = await directoryApi.searchObservabilityIntents({
          limit: 150,
          q: query || undefined,
          status: status === 'all' ? undefined : status,
          hours,
        })

        if (cancelled) return
        setIntents(response.intents)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load intents')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [hours, query, status])

  useEffect(() => {
    let cancelled = false
    let reconnectTimer: number | null = null

    function connect() {
      setSocketState('connecting')
      socketRef.current?.close()
      socketRef.current = connectIntentFeed({
        onOpen: () => setSocketState('live'),
        onClose: () => {
          setSocketState('offline')
          if (!cancelled) {
            reconnectTimer = window.setTimeout(connect, 2500)
          }
        },
        onError: () => setSocketState('offline'),
        onMessage: (message) => {
          if (message.type !== 'intent_feed' || !message.entry) return
          if (!matchesFilters(message.entry, { query, status, hours })) {
            return
          }

          setIntents((current) => {
            const next = current.filter((entry) => entry.nonce !== message.entry?.nonce)
            return [message.entry as RecentIntent, ...next]
              .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
              .slice(0, 150)
          })
        },
      })
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer)
      }
      socketRef.current?.close()
    }
  }, [hours, query, status])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Intents"
        description="Search the live intent stream and drill into per-nonce traces."
        actions={(
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1.5 text-sm dark:border-slate-800">
            <Radio size={14} className={cn(socketState === 'live' ? 'text-emerald-500' : socketState === 'connecting' ? 'text-amber-500' : 'text-red-500')} />
            <span className="capitalize">{socketState}</span>
          </div>
        )}
      />

      {hasDeepLinkFilters ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
          {alertId ? (
            <span>Showing the filtered intent slice linked from alert <span className="font-mono">{alertId}</span>.</span>
          ) : (
            <span>Showing a filtered intent slice.</span>
          )}
          <button className="ml-2 text-orange-600 hover:text-orange-700 dark:text-orange-300" onClick={clearFilters} type="button">
            Clear filters
          </button>
        </div>
      ) : null}

      <section className="panel">
        <div className="grid gap-3 lg:grid-cols-[1.6fr,0.8fr,0.8fr]">
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="input-field pl-10"
              placeholder="Search nonce, Beam ID, intent type, error code"
              value={query}
              onChange={(event) => updateSearchParam('q', event.target.value)}
            />
          </label>
          <select className="input-field" value={status} onChange={(event) => updateSearchParam('status', event.target.value)}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select className="input-field" value={hours} onChange={(event) => updateSearchParam('hours', event.target.value)}>
            {WINDOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </section>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="panel overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-950">
              <tr>
                <th className="table-head">Intent</th>
                <th className="table-head">Nonce</th>
                <th className="table-head">From</th>
                <th className="table-head">To</th>
                <th className="table-head">Status</th>
                <th className="table-head">Latency</th>
                <th className="table-head">Requested</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="table-cell" colSpan={7}>Loading intent history…</td></tr>
              ) : intents.length === 0 ? (
                <tr><td className="table-cell" colSpan={7}>No intent activity matched the current filters.</td></tr>
              ) : (
                intents.map((intent) => (
                  <tr key={intent.nonce} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="table-cell font-medium">{intent.intentType}</td>
                    <td className="table-cell">
                      <Link className="font-mono text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/intents/${encodeURIComponent(intent.nonce)}`}>
                        {truncateBeamId(intent.nonce, 18)}
                      </Link>
                    </td>
                    <td className="table-cell">{truncateBeamId(intent.from, 28)}</td>
                    <td className="table-cell">{truncateBeamId(intent.to, 28)}</td>
                    <td className="table-cell">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn('rounded-full px-2 py-1 text-xs font-medium capitalize', intentStatusColor(intent.status))}>
                          {formatIntentLifecycleLabel(intent.status)}
                        </span>
                        {intent.errorCode ? <StatusPill label={intent.errorCode} tone="critical" /> : null}
                      </div>
                    </td>
                    <td className="table-cell">{formatLatency(intent.roundTripLatencyMs)}</td>
                    <td className="table-cell">{formatDateTime(intent.timestamp)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
