import { useEffect, useState } from 'react'
import { ApiError, directoryApi, type ErrorAnalyticsResponse } from '../lib/api'
import { BarList, EmptyPanel, MetricCard, PageHeader, TimeSeriesChart } from '../components/Observability'
import { formatDateTime, formatLatency, formatNumber } from '../lib/utils'

export default function ErrorsPage() {
  const [hours, setHours] = useState(24 * 7)
  const [data, setData] = useState<ErrorAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const response = await directoryApi.getErrorAnalytics(hours)
        if (cancelled) return
        setData(response)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load error analytics')
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
        title="Errors"
        description="Failure-code distribution, noisy routes, and latency tied to error conditions."
        actions={(
          <select className="input-field w-auto min-w-28" value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            <option value={24}>24h</option>
            <option value={24 * 7}>7d</option>
            <option value={24 * 30}>30d</option>
          </select>
        )}
      />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Errors" value={loading || !data ? '—' : formatNumber(data.summary.totalErrors)} tone={data && data.summary.totalErrors > 0 ? 'warning' : 'default'} />
        <MetricCard label="Distinct codes" value={loading || !data ? '—' : formatNumber(data.summary.distinctErrorCodes)} />
        <MetricCard label="Timeouts" value={loading || !data ? '—' : formatNumber(data.summary.timeoutCount)} />
        <MetricCard label="Offline" value={loading || !data ? '—' : formatNumber(data.summary.offlineCount)} />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
        <div className="panel">
          <div className="panel-title">Error Timeline</div>
          <div className="mt-5">
            {loading || !data ? (
              <EmptyPanel label="Loading error trend…" />
            ) : (
              <TimeSeriesChart
                data={data.timeline}
                series={[
                  { key: 'total', label: 'Errors', color: '#ef4444' },
                ]}
              />
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Noisiest Routes</div>
          <div className="mt-5">
            {loading || !data ? (
              <EmptyPanel label="Loading route hotspots…" />
            ) : (
              <BarList items={data.routes.map((route) => ({ label: route.route, value: route.count }))} />
            )}
          </div>
        </div>
      </section>

      <section className="panel overflow-hidden p-0">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="panel-title">Error Codes</div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-950">
              <tr>
                <th className="table-head">Code</th>
                <th className="table-head">Count</th>
                <th className="table-head">Avg latency</th>
                <th className="table-head">Senders</th>
                <th className="table-head">Recipients</th>
                <th className="table-head">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="table-cell" colSpan={6}>Loading error codes…</td></tr>
              ) : !data || data.codes.length === 0 ? (
                <tr><td className="table-cell" colSpan={6}>No error codes in the selected window.</td></tr>
              ) : (
                data.codes.map((entry) => (
                  <tr key={entry.errorCode} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="table-cell font-medium">{entry.errorCode}</td>
                    <td className="table-cell">{formatNumber(entry.count)}</td>
                    <td className="table-cell">{formatLatency(entry.avgLatencyMs)}</td>
                    <td className="table-cell">{formatNumber(entry.affectedSenders)}</td>
                    <td className="table-cell">{formatNumber(entry.affectedRecipients)}</td>
                    <td className="table-cell">{formatDateTime(entry.lastSeenAt)}</td>
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
