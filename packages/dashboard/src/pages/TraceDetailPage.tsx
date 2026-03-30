import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ApiError, directoryApi, type IntentTraceResponse } from '../lib/api'
import { EmptyPanel, PageHeader, StatusPill } from '../components/Observability'
import { alertSeverityColor, cn, formatDateTime, formatLatency, intentStatusColor, truncateBeamId } from '../lib/utils'
import { formatIntentLifecycleLabel, intentLifecycleDotColor, intentLifecycleTone } from '../lib/intent-lifecycle'

export default function TraceDetailPage() {
  const { nonce } = useParams<{ nonce: string }>()
  const [searchParams] = useSearchParams()
  const resolvedNonce = nonce ? decodeURIComponent(nonce) : null
  const [trace, setTrace] = useState<IntentTraceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const alertId = searchParams.get('alert')

  useEffect(() => {
    if (!resolvedNonce) return
    const nonceToLoad = resolvedNonce
    let cancelled = false

    async function load() {
      try {
        setLoading(true)
        const response = await directoryApi.getIntentTrace(nonceToLoad)
        if (cancelled) return
        setTrace(response)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Failed to load intent trace')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [resolvedNonce])

  if (loading) {
    return <div className="panel">Loading trace…</div>
  }

  if (error || !trace) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
        {error ?? 'Trace not found'}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trace"
        description={`Nonce ${trace.intent.nonce}`}
        actions={(
          <div className="flex flex-wrap gap-2">
            <Link className="btn-secondary" to="/intents">Back to intents</Link>
            <Link className="btn-secondary" to={`/audit?target=${encodeURIComponent(trace.intent.nonce)}${alertId ? `&alert=${encodeURIComponent(alertId)}` : ''}`}>
              Open audit log
            </Link>
          </div>
        )}
      />

      {alertId ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
          This trace was opened from alert <span className="font-mono">{alertId}</span>. Use the audit button above for the matching control-plane history.
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel space-y-3">
          <div className="panel-title">Intent Summary</div>
          <InfoRow label="Intent type" value={trace.intent.intentType} />
          <InfoRow label="From" value={trace.intent.from} mono />
          <InfoRow label="To" value={trace.intent.to} mono />
          <InfoRow label="Requested" value={formatDateTime(trace.intent.timestamp)} />
          <InfoRow label="Completed" value={formatDateTime(trace.intent.completedAt)} />
          <InfoRow label="Latency" value={formatLatency(trace.intent.roundTripLatencyMs)} />
          <div className="pt-1">
            <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium capitalize', intentStatusColor(trace.intent.status))}>
              {formatIntentLifecycleLabel(trace.intent.status)}
            </span>
            {trace.intent.errorCode ? <span className="ml-2 text-sm text-red-600 dark:text-red-400">{trace.intent.errorCode}</span> : null}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Linked Entities</div>
          <div className="mt-4 space-y-4 text-sm">
            <div>
              <div className="text-slate-500 dark:text-slate-400">Source agent</div>
              <Link className="font-medium text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/agents/${encodeURIComponent(trace.intent.from)}`}>
                {truncateBeamId(trace.intent.from, 44)}
              </Link>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Target agent</div>
              <Link className="font-medium text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/agents/${encodeURIComponent(trace.intent.to)}`}>
                {truncateBeamId(trace.intent.to, 44)}
              </Link>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Trace stages</div>
              <div className="mt-1 text-lg font-semibold">{trace.stages.length}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">Lifecycle</div>
        <div className="mt-5 space-y-4">
          {trace.stages.length === 0 ? (
            <EmptyPanel label="No structured trace events were recorded for this nonce." />
          ) : (
            trace.stages.map((stage, index) => (
              <div key={`${stage.id}-${stage.stage}-${index}`} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className={cn('h-3 w-3 rounded-full', intentLifecycleDotColor(stage.status))} />
                  {index < trace.stages.length - 1 ? <div className="mt-2 h-full w-px bg-slate-200 dark:bg-slate-800" /> : null}
                </div>
                <div className="min-w-0 flex-1 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-medium capitalize">{formatIntentLifecycleLabel(stage.stage)}</div>
                    <StatusPill label={formatIntentLifecycleLabel(stage.status)} tone={intentLifecycleTone(stage.status)} />
                    <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(stage.timestamp)}</span>
                  </div>
                  {stage.details ? (
                    <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                      {JSON.stringify(stage.details, null, 2)}
                    </pre>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr,1fr]">
        <div className="panel">
          <div className="panel-title">Audit Context</div>
          <div className="mt-4 space-y-3">
            {trace.audit.length === 0 ? (
              <EmptyPanel label="No related audit entries were matched to this nonce." />
            ) : (
              trace.audit.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill label={entry.action} />
                    <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(entry.timestamp)}</span>
                  </div>
                  <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                    {entry.actor} → {entry.target}
                  </div>
                  {entry.details ? (
                    <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                      {JSON.stringify(entry.details, null, 2)}
                    </pre>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Shield Context</div>
          <div className="mt-4 space-y-3">
            {trace.shield.length === 0 ? (
              <EmptyPanel label="No shield audit entries were recorded for this nonce." />
            ) : (
              trace.shield.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em]', alertSeverityColor((entry.riskScore ?? 0) >= 0.8 ? 'critical' : (entry.riskScore ?? 0) >= 0.65 ? 'warning' : 'info'))}>
                      {entry.decision ?? 'unknown'}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(entry.createdAt)}</span>
                  </div>
                  <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                    Risk {entry.riskScore?.toFixed(2) ?? '—'} · {entry.intentType ?? 'unknown'} · {entry.payloadHash ?? 'no-hash'}
                  </div>
                  {entry.anomalyFlags.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {entry.anomalyFlags.map((flag) => (
                        <StatusPill key={flag} label={flag} tone="warning" />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div className={cn('mt-1 break-all text-sm font-medium', mono && 'font-mono')}>{value}</div>
    </div>
  )
}
