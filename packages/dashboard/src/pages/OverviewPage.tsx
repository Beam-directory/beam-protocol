import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, directoryApi, type ObservabilityOverview } from '../lib/api'
import { alertSeverityColor, cn, formatLatency, formatNumber, formatPercent } from '../lib/utils'
import { BarList, EmptyPanel, MetricCard, PageHeader, StatusPill, TimeSeriesChart } from '../components/Observability'

const WINDOW_OPTIONS = [
  { value: 24, label: '24h' },
  { value: 24 * 7, label: '7d' },
]

export default function OverviewPage() {
  const [hours, setHours] = useState(24)
  const [overview, setOverview] = useState<ObservabilityOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const response = await directoryApi.getObservabilityOverview(hours)
        if (cancelled) return
        setOverview(response)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load observability overview')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [hours])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Network health, throughput, latency, and alert pressure across the Beam directory."
        actions={(
          <select className="input-field w-auto min-w-28" value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            {WINDOW_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        )}
      />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Total intents" value={loading || !overview ? '—' : formatNumber(overview.summary.totalIntents)} hint={`${hours}h window`} />
        <MetricCard label="Success rate" value={loading || !overview ? '—' : formatPercent(overview.summary.successRate)} tone={overview && overview.summary.successRate < 0.9 ? 'warning' : 'success'} />
        <MetricCard label="p95 latency" value={loading || !overview ? '—' : formatLatency(overview.summary.p95LatencyMs)} tone={overview && (overview.summary.p95LatencyMs ?? 0) >= 2000 ? 'warning' : 'default'} />
        <MetricCard label="Live agents" value={loading || !overview ? '—' : formatNumber(overview.summary.liveAgents)} hint={`${overview ? formatNumber(overview.summary.totalAgents) : '—'} total`} />
        <MetricCard label="Open alerts" value={loading || !overview ? '—' : formatNumber(overview.alerts.length)} tone={overview && overview.alerts.length > 0 ? 'critical' : 'default'} />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.4fr,0.8fr]">
        <div className="panel">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="panel-title">Intent Timeline</div>
              <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">Throughput, failures, and in-flight pressure over time.</div>
            </div>
            <StatusPill
              label={overview && overview.summary.inFlightOlderThan15m > 0 ? `${overview.summary.inFlightOlderThan15m} stuck` : 'healthy'}
              tone={overview && overview.summary.inFlightOlderThan15m > 0 ? 'warning' : 'success'}
            />
          </div>
          <div className="mt-5">
            {loading || !overview ? (
              <EmptyPanel label="Loading timeseries…" />
            ) : (
              <TimeSeriesChart
                data={overview.timeline}
                series={[
                  { key: 'total', label: 'Total', color: '#f97316' },
                  { key: 'error', label: 'Errors', color: '#ef4444' },
                  { key: 'inFlight', label: 'In flight', color: '#f59e0b' },
                ]}
              />
            )}
          </div>
        </div>

        <div className="panel">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="panel-title">Top Intents</div>
              <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">Most active intent types in the selected window.</div>
            </div>
            <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to="/intents">
              Open feed
            </Link>
          </div>
          <div className="mt-5">
            {loading || !overview ? (
              <EmptyPanel label="Loading intent mix…" />
            ) : (
              <BarList items={overview.topIntents.map((entry) => ({ label: entry.intentType, value: entry.total }))} />
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
        <div className="panel">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="panel-title">Error Pressure</div>
              <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">Most frequent failure codes right now.</div>
            </div>
            <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to="/errors">
              Error dashboard
            </Link>
          </div>
          <div className="mt-4 space-y-3">
            {loading || !overview ? (
              <EmptyPanel label="Loading error data…" />
            ) : overview.topErrors.length === 0 ? (
              <EmptyPanel label="No error codes in the selected window." />
            ) : (
              overview.topErrors.map((entry) => (
                <div key={entry.errorCode} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{entry.errorCode}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{entry.lastSeenAt}</div>
                    </div>
                    <div className="text-lg font-semibold">{formatNumber(entry.count)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="panel-title">Alert Feed</div>
              <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">Computed network warnings from errors, latency, backlog, and federation drift.</div>
            </div>
            <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to="/alerts">
              View all alerts
            </Link>
          </div>
          <div className="mt-4 space-y-3">
            {loading || !overview ? (
              <EmptyPanel label="Loading alerts…" />
            ) : overview.alerts.length === 0 ? (
              <EmptyPanel label="No active alerts in the selected window." />
            ) : (
              overview.alerts.map((alert) => (
                <div key={alert.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em]', alertSeverityColor(alert.severity))}>
                      {alert.severity}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{alert.scope}</span>
                  </div>
                  <div className="mt-2 text-sm font-medium">{alert.title}</div>
                  <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{alert.message}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
