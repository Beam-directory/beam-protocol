import { useEffect, useMemo, useState } from 'react'
import AlertCard from '../components/AlertCard'
import {
  ApiError,
  directoryApi,
  type AlertsResponse,
  type ExportDataset,
  type ExportFormat,
  type ObservabilityDatasetInfo,
  type PrunePreviewResponse,
} from '../lib/api'
import { EmptyPanel, PageHeader } from '../components/Observability'
import { useAdminAuth } from '../lib/admin-auth'
import { downloadBlob, formatDateTime, formatNumber } from '../lib/utils'

const EXPORT_FORMATS: ExportFormat[] = ['json', 'csv', 'ndjson']

export default function AlertsPage() {
  const { session } = useAdminAuth()
  const [hours, setHours] = useState(24)
  const [data, setData] = useState<AlertsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pruneDataset, setPruneDataset] = useState('intents')
  const [pruneDays, setPruneDays] = useState(30)
  const [prunePreview, setPrunePreview] = useState<PrunePreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [confirmDataset, setConfirmDataset] = useState('')
  const [confirmPhrase, setConfirmPhrase] = useState('')
  const [actionState, setActionState] = useState<string | null>(null)

  async function load(currentHours: number) {
    try {
      setLoading(true)
      const response = await directoryApi.getAlerts(currentHours)
      setData(response)
      setPruneDays(response.retention.defaultDays)
      setPruneDataset((current) => (
        response.retention.datasets.includes(current)
          ? current
          : response.retention.datasets[0] ?? 'intents'
      ))
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

  useEffect(() => {
    setPrunePreview(null)
    setConfirmDataset('')
    setConfirmPhrase('')
  }, [pruneDataset, pruneDays])

  const retentionMeta = useMemo<ObservabilityDatasetInfo | null>(() => {
    return data?.retention.details.find((entry) => entry.name === pruneDataset) ?? null
  }, [data, pruneDataset])

  const expectedPhrase = `${data?.retention.confirmPhrasePrefix ?? 'prune'} ${pruneDataset}`
  const pruneReady = session?.role === 'admin'
    && prunePreview?.dataset === pruneDataset
    && prunePreview.olderThanDays === pruneDays
    && confirmDataset === pruneDataset
    && confirmPhrase === expectedPhrase

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

  async function handlePrunePreview() {
    if (session?.role !== 'admin') {
      setActionState('Only admins can preview or prune observability datasets.')
      return
    }

    try {
      setPreviewLoading(true)
      setActionState(`Previewing ${pruneDataset} older than ${pruneDays} days…`)
      const result = await directoryApi.previewPruneObservability(pruneDataset, pruneDays)
      setPrunePreview(result)
      setActionState(`Preview ready for ${pruneDataset}.`)
    } catch (err) {
      setPrunePreview(null)
      setActionState(err instanceof ApiError ? err.message : 'Preview failed')
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handlePrune() {
    if (!pruneReady) {
      setActionState(`Preview the dataset and type "${expectedPhrase}" before pruning.`)
      return
    }

    try {
      setActionState(`Pruning ${pruneDataset} older than ${pruneDays} days…`)
      const result = await directoryApi.pruneObservability(pruneDataset, pruneDays, {
        confirmDataset,
        confirmPhrase,
      })
      setActionState(`Deleted ${result.deleted} records from ${result.dataset}`)
      setPrunePreview(null)
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
      <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-950/80 dark:text-slate-300">
        <div className="font-medium text-slate-900 dark:text-slate-100">Operator flow</div>
        <div className="mt-1">
          Alert cards now carry threshold reasoning plus investigation links into filtered intents, trace detail, and audit history.
          Exports are read-only snapshots. Prune is irreversible, so the dashboard requires an admin preview and typed confirmation phrase first.
        </div>
        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Generated {formatDateTime(data?.generatedAt)} for the last {hours} hours.
        </div>
      </div>

      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel">
          <div className="panel-title">Active Alerts</div>
          <div className="mt-4 space-y-3">
            {loading ? (
              <EmptyPanel label="Loading alerts…" />
            ) : !data || data.alerts.length === 0 ? (
              <EmptyPanel label="No active alerts for the selected window." />
            ) : (
              data.alerts.map((alert) => <AlertCard key={alert.id} alert={alert} />)
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
                    <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{entry.description}</div>
                    <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Export snapshots honor the current time window and can be shared without mutating state.
                    </div>
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
              {retentionMeta ? (
                <div className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                  <div>{retentionMeta.description}</div>
                  {retentionMeta.cascadesTo?.length ? (
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Also removes: {retentionMeta.cascadesTo.join(', ')}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <input
                className="input-field"
                min={1}
                step={1}
                type="number"
                value={pruneDays}
                onChange={(event) => setPruneDays(Number(event.target.value))}
              />
              <button
                className="btn-secondary w-full disabled:cursor-not-allowed disabled:opacity-60"
                disabled={session?.role !== 'admin' || previewLoading}
                onClick={() => void handlePrunePreview()}
                type="button"
              >
                {previewLoading ? 'Previewing…' : 'Preview prune impact'}
              </button>
              {prunePreview ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                  <div className="font-medium">Preview result</div>
                  <div className="mt-1">
                    Beam would delete {formatNumber(prunePreview.wouldDelete)} records older than {prunePreview.olderThanDays} days from {prunePreview.dataset}.
                  </div>
                  {typeof prunePreview.intents === 'number' || typeof prunePreview.traces === 'number' ? (
                    <div className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                      intents: {formatNumber(prunePreview.intents ?? 0)} · traces: {formatNumber(prunePreview.traces ?? 0)}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 px-3 py-3 text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  Run a preview before pruning. The dashboard does not enable destructive actions without a fresh preview for the current dataset and day threshold.
                </div>
              )}
              <input
                className="input-field"
                placeholder={`Type dataset: ${pruneDataset}`}
                type="text"
                value={confirmDataset}
                onChange={(event) => setConfirmDataset(event.target.value)}
              />
              <input
                className="input-field"
                placeholder={`Type phrase: ${expectedPhrase}`}
                type="text"
                value={confirmPhrase}
                onChange={(event) => setConfirmPhrase(event.target.value)}
              />
              <button
                className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!pruneReady}
                onClick={() => void handlePrune()}
                type="button"
              >
                {session?.role === 'admin' ? 'Prune dataset' : 'Admin role required'}
              </button>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Prune is irreversible. Use export first if you need a handoff snapshot, then preview, then type the dataset and phrase exactly.
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
