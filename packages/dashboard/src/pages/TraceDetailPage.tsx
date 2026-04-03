import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, ShieldAlert, ShieldCheck, Waypoints } from 'lucide-react'
import { ApiError, directoryApi, type IntentTraceResponse } from '../lib/api'
import { EmptyPanel, PageHeader, StatusPill } from '../components/Observability'
import { alertSeverityColor, cn, formatDateTime, formatLatency, formatRelativeTime, intentStatusColor, truncateBeamId } from '../lib/utils'
import { classifyIntentLifecycle, formatIntentLifecycleLabel, intentLifecycleDotColor, intentLifecycleTone } from '../lib/intent-lifecycle'

function getOperatorGuidance(status: string): {
  title: string
  body: string
  actions: Array<{ to: string; label: string }>
} {
  switch (status) {
    case 'delivered':
      return {
        title: 'Delivery accepted, terminal completion still pending',
        body: 'Beam handed this nonce to the target successfully, but no terminal acknowledgement has been recorded yet. Treat it as in flight. If it remains here longer than expected, inspect alerts, queue health, or the dead-letter view.',
        actions: [
          { to: '/alerts', label: 'Open alerts' },
          { to: '/dead-letter', label: 'Inspect dead letters' },
        ],
      }
    case 'queued':
      return {
        title: 'Queued for retry',
        body: 'A retryable delivery failure pushed this nonce back into the queue. Operators should check whether the target is offline, rate limited, or otherwise temporarily unavailable.',
        actions: [
          { to: '/alerts', label: 'Open alerts' },
          { to: '/dead-letter', label: 'Inspect dead letters' },
        ],
      }
    case 'dead_letter':
      return {
        title: 'Retry budget exhausted',
        body: 'Beam stopped retrying this nonce. Use the dead-letter view to inspect the terminal failure and requeue only after the downstream condition has been corrected.',
        actions: [
          { to: '/dead-letter', label: 'Open dead letters' },
          { to: '/audit', label: 'Open audit log' },
        ],
      }
    case 'failed':
      return {
        title: 'Terminal failure recorded',
        body: 'This nonce hit a terminal failure without exhausting the dead-letter recovery flow. Check audit history, sender or recipient configuration, and any matching Shield decisions.',
        actions: [
          { to: '/audit', label: 'Open audit log' },
          { to: '/errors', label: 'Open errors' },
        ],
      }
    case 'acked':
      return {
        title: 'Terminal acknowledgement recorded',
        body: 'The recipient or downstream consumer recorded a final successful outcome for this nonce. Use the trace and audit history as evidence, not as an active queue item.',
        actions: [
          { to: '/audit', label: 'Open audit log' },
          { to: '/intents', label: 'Back to intents' },
        ],
      }
    default:
      return {
        title: 'Handoff still in flight',
        body: 'Beam is still validating, routing, or waiting for transport progress on this nonce. Use the lifecycle stages below to see where it is spending time.',
        actions: [
          { to: '/alerts', label: 'Open alerts' },
          { to: '/audit', label: 'Open audit log' },
        ],
      }
  }
}

function TraceSignal({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'success' | 'warning' | 'critical'
}) {
  return (
    <div className={cn(
      'rounded-[24px] border px-4 py-4',
      tone === 'default' && 'border-slate-200/80 bg-white/45 dark:border-white/10 dark:bg-white/[0.03]',
      tone === 'success' && 'border-emerald-200 bg-emerald-50/90 dark:border-emerald-500/20 dark:bg-emerald-500/10',
      tone === 'warning' && 'border-amber-200 bg-amber-50/90 dark:border-amber-500/20 dark:bg-amber-500/10',
      tone === 'critical' && 'border-red-200 bg-red-50/90 dark:border-red-500/20 dark:bg-red-500/10',
    )}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">{label}</div>
      <div className="mt-3 text-xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{value}</div>
      {hint ? <div className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{hint}</div> : null}
    </div>
  )
}

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
    return (
      <div data-ui-page="trace-detail" data-ui-state="loading" className="space-y-8">
        <PageHeader
          eyebrow="Intent Trace"
          title="Trace"
          description={resolvedNonce ? `Nonce ${resolvedNonce}` : 'Loading trace'}
        />
        <div className="panel">Loading trace…</div>
      </div>
    )
  }

  if (error || !trace) {
    return (
      <div data-ui-page="trace-detail" data-ui-state="error" className="space-y-8">
        <PageHeader
          eyebrow="Intent Trace"
          title="Trace"
          description={resolvedNonce ? `Nonce ${resolvedNonce}` : 'Trace lookup failed'}
        />
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error ?? 'Trace not found'}
        </div>
      </div>
    )
  }

  const guidance = getOperatorGuidance(trace.intent.status)
  const latestStage = trace.stages.length > 0 ? trace.stages[trace.stages.length - 1] ?? null : null
  const deliveryStage = trace.stages.find((stage) => stage.stage === 'delivered' || stage.status === 'delivered') ?? null
  const terminalStage = [...trace.stages].reverse().find((stage) => {
    const lifecycle = classifyIntentLifecycle(stage.status)
    return lifecycle === 'success' || lifecycle === 'error'
  }) ?? null
  const firstErrorStage = trace.stages.find((stage) => classifyIntentLifecycle(stage.status) === 'error') ?? null
  const latestAudit = trace.audit[0] ?? null
  const highRiskShield = trace.shield.find((entry) => (entry.riskScore ?? 0) >= 0.8) ?? null
  const shieldFlagCount = trace.shield.reduce((count, entry) => count + entry.anomalyFlags.length, 0)
  const postureTone = intentLifecycleTone(trace.intent.status)
  const routePath = `${trace.intent.from} -> ${trace.intent.to}`

  const operatorChecklist = useMemo(() => {
    const items: string[] = []
    if (firstErrorStage) {
      items.push(`Failure entered at ${formatIntentLifecycleLabel(firstErrorStage.stage)}.`)
    }
    if (!terminalStage && deliveryStage) {
      items.push('Transport accepted the handoff, but terminal completion has not been recorded yet.')
    }
    if (!deliveryStage && trace.intent.status !== 'received' && trace.intent.status !== 'validated') {
      items.push('No delivery evidence exists yet. Check queue health, routing, or downstream availability.')
    }
    if (highRiskShield) {
      items.push(`Shield recorded a critical review (${highRiskShield.decision ?? 'unknown decision'}).`)
    } else if (shieldFlagCount > 0) {
      items.push(`Shield flagged ${shieldFlagCount} anomaly signal${shieldFlagCount === 1 ? '' : 's'} across this nonce.`)
    }
    if (items.length === 0) {
      items.push('Trace looks internally consistent. Use audit and lifecycle history as operator evidence.')
    }
    return items
  }, [deliveryStage, firstErrorStage, highRiskShield, shieldFlagCount, terminalStage, trace.intent.status])

  return (
    <div data-ui-page="trace-detail" data-ui-state="ready" className="space-y-8">
      <PageHeader
        eyebrow="Intent Trace"
        title="Trace"
        description={`Nonce ${trace.intent.nonce}`}
        badges={(
          <>
            <StatusPill label={formatIntentLifecycleLabel(trace.intent.status)} tone={intentLifecycleTone(trace.intent.status)} />
            {trace.intent.errorCode ? <StatusPill label={trace.intent.errorCode} tone="critical" /> : null}
            {alertId ? <StatusPill label={`Alert ${alertId}`} tone="warning" /> : null}
          </>
        )}
        aside={(
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Latency</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{formatLatency(trace.intent.roundTripLatencyMs)}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Stages</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{trace.stages.length}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Audit hits</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{trace.audit.length}</div>
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Shield hits</div>
              <div className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white">{trace.shield.length}</div>
            </div>
          </div>
        )}
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
        <div className="panel border-slate-200/70 bg-white/55 px-4 py-3 text-sm text-slate-600 dark:border-white/10 dark:bg-slate-950/45 dark:text-slate-300">
          This trace was opened from alert <span className="font-mono">{alertId}</span>. Use the audit button above for the matching control-plane history.
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1.1fr,0.9fr]">
        <section className="panel">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="panel-title">Operator posture</div>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Current stance, path, and the next action an operator should take on this nonce.
              </p>
            </div>
            <StatusPill label={formatIntentLifecycleLabel(trace.intent.status)} tone={postureTone} />
          </div>

          <div className="mt-5 rounded-[28px] border border-slate-200/80 bg-white/45 p-5 dark:border-white/10 dark:bg-white/[0.03]">
            <div className="flex items-start gap-3">
              <span className={cn(
                'mt-1 inline-flex h-9 w-9 items-center justify-center rounded-full border',
                postureTone === 'success' && 'border-emerald-200 bg-emerald-100/80 text-emerald-600 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300',
                postureTone === 'warning' && 'border-amber-200 bg-amber-100/80 text-amber-600 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300',
                postureTone === 'critical' && 'border-red-200 bg-red-100/80 text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300',
                postureTone === 'default' && 'border-slate-200 bg-slate-100 text-slate-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300',
              )}>
                {postureTone === 'success' ? <CheckCircle2 size={18} /> : postureTone === 'critical' ? <ShieldAlert size={18} /> : postureTone === 'warning' ? <Clock3 size={18} /> : <Waypoints size={18} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-lg font-semibold tracking-[-0.03em] text-slate-950 dark:text-white">{guidance.title}</div>
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{guidance.body}</p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-[22px] border border-slate-200/80 bg-white/55 px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Route</div>
                <div className="mt-3 break-all font-mono text-sm text-slate-700 dark:text-slate-200">{routePath}</div>
              </div>
              <div className="rounded-[22px] border border-slate-200/80 bg-white/55 px-4 py-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Latest evidence</div>
                <div className="mt-3 text-sm font-medium text-slate-900 dark:text-white">
                  {latestStage ? formatIntentLifecycleLabel(latestStage.stage) : 'No structured stage'}
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {latestStage ? formatRelativeTime(latestStage.timestamp) : 'No stage timestamp'}
                </div>
              </div>
            </div>

            <div className="mt-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Operator checklist</div>
              <div className="mt-3 space-y-2">
                {operatorChecklist.map((item) => (
                  <div key={item} className="flex items-start gap-2 rounded-[18px] border border-slate-200/70 bg-white/55 px-3 py-3 text-sm text-slate-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-slate-300">
                    <span className="mt-1 inline-flex h-2 w-2 rounded-full bg-orange-500" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {guidance.actions.map((action) => (
                <Link key={`${action.to}-${action.label}`} className="btn-secondary" to={action.to}>
                  {action.label}
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="panel-title">Evidence lanes</div>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Delivery, audit, and Shield signals that prove where this handoff stands right now.
              </p>
            </div>
            <StatusPill label={highRiskShield ? 'critical review' : shieldFlagCount > 0 ? 'shield signals' : 'clean controls'} tone={highRiskShield ? 'critical' : shieldFlagCount > 0 ? 'warning' : 'success'} />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <TraceSignal
              label="Delivery"
              value={deliveryStage ? 'Accepted' : 'Not yet'}
              hint={deliveryStage ? `Reached ${formatIntentLifecycleLabel(deliveryStage.stage)} ${formatRelativeTime(deliveryStage.timestamp)}.` : 'No delivered stage recorded yet.'}
              tone={deliveryStage ? 'success' : postureTone === 'critical' ? 'critical' : 'warning'}
            />
            <TraceSignal
              label="Terminal"
              value={terminalStage ? formatIntentLifecycleLabel(terminalStage.status) : 'Open'}
              hint={terminalStage ? formatDateTime(terminalStage.timestamp) : 'No terminal acknowledgement or failure yet.'}
              tone={terminalStage ? intentLifecycleTone(terminalStage.status) : 'warning'}
            />
            <TraceSignal
              label="Audit trail"
              value={String(trace.audit.length)}
              hint={latestAudit ? `${latestAudit.action} ${formatRelativeTime(latestAudit.timestamp)}.` : 'No matched audit entries.'}
              tone={trace.audit.length > 0 ? 'success' : 'default'}
            />
            <TraceSignal
              label="Shield"
              value={highRiskShield ? `Risk ${highRiskShield.riskScore?.toFixed(2) ?? '—'}` : shieldFlagCount > 0 ? `${shieldFlagCount} flags` : 'No flags'}
              hint={highRiskShield ? `${highRiskShield.decision ?? 'unknown'} review recorded.` : shieldFlagCount > 0 ? 'Shield emitted anomaly signals for this nonce.' : 'No shield anomalies recorded.'}
              tone={highRiskShield ? 'critical' : shieldFlagCount > 0 ? 'warning' : 'success'}
            />
          </div>
        </section>
      </section>

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
                <div className={cn(
                  'min-w-0 flex-1 rounded-[24px] border p-4 dark:border-slate-800',
                  classifyIntentLifecycle(stage.status) === 'error' && 'border-red-200 bg-red-50/80 dark:border-red-500/20 dark:bg-red-500/10',
                  classifyIntentLifecycle(stage.status) === 'success' && 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-500/20 dark:bg-emerald-500/10',
                  classifyIntentLifecycle(stage.status) === 'in_flight' && 'border-slate-200 bg-white/45 dark:border-white/10 dark:bg-white/[0.03]',
                )}>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Stage {index + 1} of {trace.stages.length}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="font-medium capitalize text-slate-950 dark:text-white">{formatIntentLifecycleLabel(stage.stage)}</div>
                    <StatusPill label={formatIntentLifecycleLabel(stage.status)} tone={intentLifecycleTone(stage.status)} />
                    <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(stage.timestamp)}</span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{formatRelativeTime(stage.timestamp)}</span>
                  </div>
                  {stage.details ? (
                    <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                      {JSON.stringify(stage.details, null, 2)}
                    </pre>
                  ) : (
                    <div className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                      No structured payload was captured for this stage.
                    </div>
                  )}
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
