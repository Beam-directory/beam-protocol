import { useEffect, useState } from 'react'
import { ApiError, directoryApi, type AlertsResponse, type ExportDataset, type ExportFormat } from '../lib/api'
import { EmptyPanel, PageHeader } from '../components/Observability'
import { useAdminAuth } from '../lib/admin-auth'
import { alertSeverityColor, cn, downloadBlob, formatDateTime } from '../lib/utils'

const EXPORT_FORMATS: ExportFormat[] = ['json', 'csv', 'ndjson']

export default function AlertsPage() {
  const { session } = useAdminAuth()
  const [hours, setHours] = useState(24)
  const [data, setData] = useState<AlertsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pruneDataset, setPruneDataset] = useState('intents')
  const [pruneDays, setPruneDays] = useState(30)
  const [actionState, setActionState] = useState<string | null>(null)

  async function load(currentHours: number) {
    try {
      setLoading(true)
      const response = await directoryApi.getAlerts(currentHours)
      setData(response)
      setPruneDays(response.retention.defaultDays)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load alerts')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(hours)
  }, [hours])

  async function handleExport(dataset: ExportDataset, format: ExportFormat) {
    try {
      setActionState(`Exporting ${dataset}.${format}…`)
      const result = await directoryApi.downloadObservabilityExport(dataset, format, { hours, limit: 1000 })
      downloadBlob(result.blob, result.filename)
      setActionState(`Exported ${result.filename}`)
    } catch (err) {
      setActionState(err instanceof ApiError ? err.message : 'Export failed')
    }
  }

  async function handlePrune() {
    if (session?.role !== 'admin') {
      setActionState('Only admins can prune observability datasets.')
      return
    }

    try {
      setActionState(`Pruning ${pruneDataset} older than ${pruneDays} days…`)
      const result = await directoryApi.pruneObservability(pruneDataset, pruneDays)
      setActionState(`Deleted ${result.deleted} records from ${result.dataset}`)
      await load(hours)
    } catch (err) {
      setActionState(err instanceof ApiError ? err.message : 'Prune failed')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alerts"
        description="Heuristic alerting, export controls, and log retention actions."
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
      {actionState ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          {actionState}
        </div>
      ) : null}

      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel">
          <div className="panel-title">Active Alerts</div>
          <div className="mt-4 space-y-3">
            {loading ? (
              <EmptyPanel label="Loading alerts…" />
            ) : !data || data.alerts.length === 0 ? (
              <EmptyPanel label="No active alerts for the selected window." />
            ) : (
              data.alerts.map((alert) => (
                <div key={alert.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em]', alertSeverityColor(alert.severity))}>
                      {alert.severity}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{alert.scope}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(alert.startedAt)}</span>
                  </div>
                  <div className="mt-2 text-sm font-medium">{alert.title}</div>
                  <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{alert.message}</div>
                  <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    {alert.metric}: {alert.value} (threshold {alert.threshold})
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="panel">
            <div className="panel-title">Exports</div>
            <div className="mt-4 space-y-4">
              {loading ? (
                <EmptyPanel label="Loading export catalog…" />
              ) : !data ? (
                <EmptyPanel label="Export catalog unavailable." />
              ) : (
                data.exports.map((entry) => (
                  <div key={entry.dataset} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                    <div className="text-sm font-medium capitalize">{entry.dataset}</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {EXPORT_FORMATS.filter((format) => entry.formats.includes(format)).map((format) => (
                        <button
                          key={`${entry.dataset}-${format}`}
                          className="btn-secondary"
                          onClick={() => void handleExport(entry.dataset as ExportDataset, format)}
                          type="button"
                        >
                          {format.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">Retention</div>
            <div className="mt-4 space-y-4">
              <div className="text-sm text-slate-500 dark:text-slate-400">
                Default retention: {data?.retention.defaultDays ?? pruneDays} days.
              </div>
              <select className="input-field" value={pruneDataset} onChange={(event) => setPruneDataset(event.target.value)}>
                {data?.retention.datasets.map((dataset) => (
                  <option key={dataset} value={dataset}>{dataset}</option>
                )) ?? (
                  <>
                    <option value="intents">intents</option>
                    <option value="traces">traces</option>
                    <option value="audit">audit</option>
                    <option value="shield">shield</option>
                  </>
                )}
              </select>
              <input
                className="input-field"
                min={1}
                step={1}
                type="number"
                value={pruneDays}
                onChange={(event) => setPruneDays(Number(event.target.value))}
              />
              <button
                className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60"
                disabled={session?.role !== 'admin'}
                onClick={() => void handlePrune()}
                type="button"
              >
                {session?.role === 'admin' ? 'Prune Dataset' : 'Admin role required'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
