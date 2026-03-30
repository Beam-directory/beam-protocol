import { Link } from 'react-router-dom'
import type { AlertItem } from '../lib/api'
import { formatIntentLifecycleLabel } from '../lib/intent-lifecycle'
import {
  alertSeverityColor,
  cn,
  formatDateTime,
  formatLatency,
  formatNumber,
  formatPercent,
  truncateBeamId,
} from '../lib/utils'
import { StatusPill } from './Observability'

function formatAlertMetric(alert: AlertItem, value: number) {
  switch (alert.valueUnit) {
    case 'ratio':
      return formatPercent(value, 0)
    case 'ms':
      return formatLatency(value)
    default:
      return formatNumber(value)
  }
}

export default function AlertCard({
  alert,
  compact = false,
}: {
  alert: AlertItem
  compact?: boolean
}) {
  const visibleLinks = alert.links.slice(0, compact ? 2 : 3)
  const visibleSamples = alert.sampleTraces.slice(0, compact ? 1 : 3)

  return (
    <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em]', alertSeverityColor(alert.severity))}>
          {alert.severity}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">{alert.scope}</span>
        <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(alert.startedAt)}</span>
      </div>

      <div className="mt-2 text-sm font-medium">{alert.title}</div>
      <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{alert.message}</div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-slate-50 px-3 py-3 dark:bg-slate-950">
          <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Current value</div>
          <div className="mt-1 text-lg font-semibold">{formatAlertMetric(alert, alert.value)}</div>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-3 dark:bg-slate-950">
          <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Threshold</div>
          <div className="mt-1 text-lg font-semibold">{formatAlertMetric(alert, alert.threshold)}</div>
        </div>
      </div>

      <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">{alert.thresholdExplanation}</div>
      <div className="mt-1 text-xs font-medium text-slate-700 dark:text-slate-200">{alert.severityReason}</div>

      {visibleSamples.length > 0 ? (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Recent traces</div>
          <div className="mt-2 space-y-2">
            {visibleSamples.map((sample) => (
              <div key={sample.nonce} className="rounded-xl border border-slate-200 px-3 py-3 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <Link className="font-mono text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/intents/${encodeURIComponent(sample.nonce)}?alert=${encodeURIComponent(alert.id)}`}>
                    {truncateBeamId(sample.nonce, compact ? 22 : 28)}
                  </Link>
                  <StatusPill label={formatIntentLifecycleLabel(sample.status)} />
                  {sample.errorCode ? <StatusPill label={sample.errorCode} tone="critical" /> : null}
                </div>
                {!compact ? (
                  <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    {sample.intentType} · {truncateBeamId(sample.from, 26)} → {truncateBeamId(sample.to, 26)} · {formatDateTime(sample.requestedAt)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {visibleLinks.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {visibleLinks.map((link) => (
            <Link
              key={`${alert.id}-${link.label}-${link.href}`}
              className={cn(
                'rounded-full border px-3 py-1.5 text-sm transition-colors',
                link.surface === 'trace' && 'border-orange-200 text-orange-700 hover:border-orange-300 hover:bg-orange-50 dark:border-orange-500/30 dark:text-orange-300 dark:hover:bg-orange-500/10',
                link.surface !== 'trace' && 'border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-900',
              )}
              to={link.href}
            >
              {link.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}
