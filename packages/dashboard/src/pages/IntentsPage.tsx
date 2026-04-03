import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Radio, Search } from 'lucide-react'
import { ApiError, connectIntentFeed, directoryApi, type RecentIntent } from '../lib/api'
import { EmptyPanel, PageHeader, StatusPill } from '../components/Observability'
import { cn, formatDateTime, formatLatency, formatRelativeTime, intentStatusColor, truncateBeamId } from '../lib/utils'
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

function lifecycleTone(status: RecentIntent['status']): 'default' | 'success' | 'warning' | 'critical' {
  const lifecycle = classifyIntentLifecycle(status)
  if (lifecycle === 'error') return 'critical'
  if (lifecycle === 'success') return 'success'
  if (lifecycle === 'in_flight') return 'warning'
  return 'default'
}

function FeedStat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-[24px] border border-slate-200/80 bg-white/45 px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.26em] text-slate-400">{label}</div>
      <div className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{value}</div>
      {hint ? <div className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</div> : null}
    </div>
  )
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
  const activeFilterCount = [query ? 1 : 0, status !== 'all' ? 1 : 0, hours !== 24 ? 1 : 0, alertId ? 1 : 0].reduce((sum, value) => sum + value, 0)

  const summary = useMemo(() => {
    const total = intents.length
    let inFlight = 0
    let errors = 0
    let acked = 0
    const latencies = intents
      .map((intent) => intent.roundTripLatencyMs)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .sort((left, right) => left - right)

    for (const intent of intents) {
      const lifecycleClass = classifyIntentLifecycle(intent.status)
      if (lifecycleClass === 'in_flight') inFlight += 1
      if (lifecycleClass === 'error') errors += 1
      if (intent.status === 'acked') acked += 1
    }

    const p95LatencyMs = latencies.length === 0
      ? null
      : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]

    return {
      total,
      inFlight,
      errors,
      acked,
      p95LatencyMs,
      ackRate: total > 0 ? acked / total : null,
    }
  }, [intents])

  const watchlist = useMemo(
    () => intents.filter((intent) => {
      const lifecycle = classifyIntentLifecycle(intent.status)
      return lifecycle === 'error' || lifecycle === 'in_flight'
    }).slice(0, 4),
    [intents],
  )

  const recentSuccesses = useMemo(
    () => intents.filter((intent) => classifyIntentLifecycle(intent.status) === 'success').slice(0, 3),
    [intents],
  )

  const topIntentTypes = useMemo(() => {
    const counts = new Map<string, number>()
    for (const intent of intents) {
      counts.set(intent.intentType, (counts.get(intent.intentType) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
  }, [intents])

  const latestIntent = intents[0] ?? null

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
    <div data-ui-page="intents" className="space-y-8">
      <PageHeader
        eyebrow="Live Intent Feed"
        title="Intents"
        description="Search live Beam handoffs, isolate failures, and jump from the feed straight into the per-nonce trace."
        badges={(
          <>
            <StatusPill
              label={socketState === 'live' ? 'Feed live' : socketState === 'connecting' ? 'Reconnecting' : 'Feed offline'}
              tone={socketState === 'live' ? 'success' : socketState === 'connecting' ? 'warning' : 'critical'}
            />
            <StatusPill label={`${hours}h window`} />
            <StatusPill label={`${summary.total} visible`} tone={summary.total > 0 ? 'success' : 'default'} />
            {watchlist.length > 0 ? <StatusPill label={`${watchlist.length} needs attention`} tone="critical" /> : null}
            {activeFilterCount > 0 ? <StatusPill label={`${activeFilterCount} active filters`} tone="warning" /> : null}
          </>
        )}
        aside={(
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Visible</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{summary.total}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">In flight</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{summary.inFlight}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Failures</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{summary.errors}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">p95 latency</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{formatLatency(summary.p95LatencyMs)}</div>
            </div>
          </div>
        )}
        actions={(
          <div className="flex flex-wrap gap-2">
            {hasDeepLinkFilters ? (
              <button className="btn-secondary" onClick={clearFilters} type="button">
                Clear filters
              </button>
            ) : null}
            <div className="inline-flex items-center gap-2 rounded-full border border-white/60 bg-white/[0.72] px-3 py-2 text-sm text-slate-600 dark:border-white/10 dark:bg-slate-950/60 dark:text-slate-300">
              <Radio size={14} className={cn(socketState === 'live' ? 'text-emerald-500' : socketState === 'connecting' ? 'text-amber-500' : 'text-red-500')} />
              <span className="capitalize">{socketState}</span>
            </div>
          </div>
        )}
      />

      {hasDeepLinkFilters ? (
        <div className="panel border-orange-200/70 bg-white/60 px-4 py-4 text-sm text-slate-600 dark:border-orange-500/20 dark:bg-slate-950/50 dark:text-slate-300">
          {alertId ? (
            <span>Showing the filtered intent slice linked from alert <span className="font-mono">{alertId}</span>.</span>
          ) : (
            <span>Showing a filtered intent slice.</span>
          )}
          <button className="ml-2 font-medium text-orange-600 hover:text-orange-700 dark:text-orange-300" onClick={clearFilters} type="button">
            Clear filters
          </button>
        </div>
      ) : null}

      <section className="panel">
        <div className="flex flex-col gap-4">
          <div>
            <div className="panel-title">Feed filters</div>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Narrow the live stream by nonce, Beam ID, lifecycle state, or time window.
            </p>
          </div>
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
        </div>
      </section>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1.25fr,0.75fr]">
        <section className="panel">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="panel-title">Watchlist</div>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Fresh failures and long-running handoffs that need operator attention first.
              </p>
            </div>
            <StatusPill label={watchlist.length > 0 ? `${watchlist.length} active` : 'stable'} tone={watchlist.length > 0 ? 'critical' : 'success'} />
          </div>

          <div className="mt-5 space-y-3">
            {loading ? (
              <EmptyPanel label="Preparing the current watchlist…" />
            ) : watchlist.length === 0 ? (
              <EmptyPanel label="No failed or in-flight intents need attention right now." />
            ) : (
              watchlist.map((intent) => (
                <Link
                  key={intent.nonce}
                  to={`/intents/${encodeURIComponent(intent.nonce)}`}
                  className="group block rounded-[28px] border border-slate-200/80 bg-white/45 px-4 py-4 transition hover:border-orange-300 hover:bg-white/70 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-orange-500/30 dark:hover:bg-white/[0.05]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          'inline-flex h-8 w-8 items-center justify-center rounded-full border',
                          lifecycleTone(intent.status) === 'critical' && 'border-red-200 bg-red-100/80 text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300',
                          lifecycleTone(intent.status) === 'warning' && 'border-amber-200 bg-amber-100/80 text-amber-600 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300',
                          lifecycleTone(intent.status) === 'success' && 'border-emerald-200 bg-emerald-100/80 text-emerald-600 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300',
                          lifecycleTone(intent.status) === 'default' && 'border-slate-200 bg-slate-100 text-slate-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300',
                        )}>
                          {lifecycleTone(intent.status) === 'critical' ? <AlertTriangle size={16} /> : lifecycleTone(intent.status) === 'warning' ? <Clock3 size={16} /> : <CheckCircle2 size={16} />}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-950 dark:text-white">{intent.intentType}</div>
                          <div className="mt-0.5 font-mono text-xs text-orange-600 dark:text-orange-300">{truncateBeamId(intent.nonce, 28)}</div>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <StatusPill label={formatIntentLifecycleLabel(intent.status)} tone={lifecycleTone(intent.status)} />
                      <span className="text-xs text-slate-500 dark:text-slate-400">{formatRelativeTime(intent.timestamp)}</span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 text-sm text-slate-600 dark:text-slate-300 sm:grid-cols-[1fr,auto,1fr] sm:items-center">
                    <div className="truncate">{truncateBeamId(intent.from, 32)}</div>
                    <div className="inline-flex items-center justify-center text-slate-400">
                      <ArrowRight size={16} />
                    </div>
                    <div className="truncate">{truncateBeamId(intent.to, 32)}</div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>{formatLatency(intent.roundTripLatencyMs)}</span>
                    {intent.errorCode ? (
                      <>
                        <span>•</span>
                        <StatusPill label={intent.errorCode} tone="critical" />
                      </>
                    ) : null}
                    <span className="ml-auto inline-flex items-center gap-1 text-orange-600 transition group-hover:text-orange-700 dark:text-orange-300">
                      Open trace
                      <ArrowRight size={13} />
                    </span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="panel-title">Feed posture</div>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Current delivery pressure, acknowledgement mix, and the most active intent lanes.
              </p>
            </div>
            <StatusPill
              label={summary.ackRate === null ? 'No sample' : `${Math.round(summary.ackRate * 100)}% acked`}
              tone={summary.errors > 0 ? 'warning' : summary.ackRate !== null && summary.ackRate >= 0.9 ? 'success' : 'default'}
            />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <FeedStat label="Acked" value={String(summary.acked)} hint="Completed cleanly in the visible slice." />
            <FeedStat label="Socket" value={socketState === 'live' ? 'Live' : socketState === 'connecting' ? 'Syncing' : 'Offline'} hint="Realtime feed connection to the directory." />
            <FeedStat label="Failures" value={String(summary.errors)} hint="Includes failed and dead-letter outcomes." />
            <FeedStat label="p95" value={formatLatency(summary.p95LatencyMs)} hint="Round-trip latency for sampled handoffs." />
          </div>

          <div className="mt-6 space-y-4 border-t border-slate-200/70 pt-4 dark:border-slate-800/80">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.26em] text-slate-400">Most active intents</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {topIntentTypes.length === 0 ? (
                  <StatusPill label="No intent mix yet" />
                ) : (
                  topIntentTypes.map(([intentType, count]) => (
                    <StatusPill key={intentType} label={`${intentType} · ${count}`} tone="default" />
                  ))
                )}
              </div>
            </div>

            <div className="grid gap-4">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.26em] text-slate-400">Latest event</div>
                {latestIntent ? (
                  <Link
                    className="mt-3 block rounded-[24px] border border-slate-200/80 bg-white/45 px-4 py-4 transition hover:border-orange-300 hover:bg-white/70 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-orange-500/30 dark:hover:bg-white/[0.05]"
                    to={`/intents/${encodeURIComponent(latestIntent.nonce)}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-950 dark:text-white">{latestIntent.intentType}</div>
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{formatRelativeTime(latestIntent.timestamp)}</div>
                      </div>
                      <StatusPill label={formatIntentLifecycleLabel(latestIntent.status)} tone={lifecycleTone(latestIntent.status)} />
                    </div>
                  </Link>
                ) : (
                  <EmptyPanel label="No recent feed entry yet." />
                )}
              </div>

              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.26em] text-slate-400">Latest clean acks</div>
                <div className="mt-3 space-y-2">
                  {recentSuccesses.length === 0 ? (
                    <EmptyPanel label="No acked intents in the current filter window." />
                  ) : (
                    recentSuccesses.map((intent) => (
                      <Link
                        key={intent.nonce}
                        className="flex items-center justify-between gap-3 rounded-[20px] border border-slate-200/80 bg-white/40 px-3 py-3 transition hover:border-emerald-300 hover:bg-white/60 dark:border-white/10 dark:bg-white/[0.03] dark:hover:border-emerald-500/30 dark:hover:bg-white/[0.05]"
                        to={`/intents/${encodeURIComponent(intent.nonce)}`}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-950 dark:text-white">{intent.intentType}</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{truncateBeamId(intent.to, 28)}</div>
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{formatLatency(intent.roundTripLatencyMs)}</div>
                      </Link>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      </section>

      <section className="panel overflow-hidden p-0">
        <div className="border-b border-slate-200/70 px-5 py-4 dark:border-slate-800/80">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="panel-title">Intent stream</div>
              <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Live feed on desktop table, compact cards on smaller screens.
              </div>
            </div>
            <StatusPill label={watchlist.length > 0 ? `${watchlist.length} watchlist items` : 'healthy feed'} tone={watchlist.length > 0 ? 'warning' : 'success'} />
          </div>
        </div>

        <div className="space-y-3 p-4 lg:hidden">
          {loading ? (
            <div className="rounded-[24px] border border-slate-200/80 px-4 py-4 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
              Loading intent history…
            </div>
          ) : intents.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-slate-300/80 px-4 py-6 text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
              No intent activity matched the current filters.
            </div>
          ) : (
            intents.map((intent) => (
              <Link
                key={intent.nonce}
                to={`/intents/${encodeURIComponent(intent.nonce)}`}
                className="block rounded-[24px] border border-slate-200/80 bg-white/40 px-4 py-4 transition hover:border-orange-300 hover:bg-white/60 dark:border-slate-800 dark:bg-white/[0.02] dark:hover:border-orange-500/30 dark:hover:bg-white/[0.04]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-950 dark:text-white">{intent.intentType}</div>
                    <div className="mt-1 font-mono text-xs text-orange-600 dark:text-orange-300">{truncateBeamId(intent.nonce, 22)}</div>
                  </div>
                  <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium capitalize', intentStatusColor(intent.status))}>
                    {formatIntentLifecycleLabel(intent.status)}
                  </span>
                </div>

                <div className="mt-4 grid gap-2 text-sm text-slate-600 dark:text-slate-300">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">From</div>
                    <div className="mt-1">{truncateBeamId(intent.from, 34)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">To</div>
                    <div className="mt-1">{truncateBeamId(intent.to, 34)}</div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span>{formatLatency(intent.roundTripLatencyMs)}</span>
                  <span>•</span>
                  <span>{formatRelativeTime(intent.timestamp)}</span>
                  {intent.errorCode ? (
                    <>
                      <span>•</span>
                      <StatusPill label={intent.errorCode} tone="critical" />
                    </>
                  ) : null}
                </div>
              </Link>
            ))
          )}
        </div>

        <div className="hidden overflow-x-auto lg:block">
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
                    <td className="table-cell">
                      <div>{formatDateTime(intent.timestamp)}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{formatRelativeTime(intent.timestamp)}</div>
                    </td>
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
