import { BellDot, RefreshCw, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import {
  ApiError,
  directoryApi,
  type OperatorNotification,
  type OperatorNotificationSource,
  type OperatorNotificationStatus,
} from '../lib/api'
import { formatDateTime, formatRelativeTime } from '../lib/utils'

const STATUS_OPTIONS: Array<{ value: '' | OperatorNotificationStatus; label: string }> = [
  { value: '', label: 'All signals' },
  { value: 'new', label: 'New' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'acted', label: 'Acted' },
]

const SOURCE_OPTIONS: Array<{ value: '' | OperatorNotificationSource; label: string }> = [
  { value: '', label: 'All sources' },
  { value: 'beta_request', label: 'Beta requests' },
  { value: 'critical_alert', label: 'Critical failures' },
]

export default function OperatorInboxPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [notifications, setNotifications] = useState<OperatorNotification[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<{
    total: number
    byStatus: Record<OperatorNotificationStatus, number>
    bySource: Record<OperatorNotificationSource, number>
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const query = searchParams.get('q') ?? ''
  const status = (searchParams.get('status') ?? '') as '' | OperatorNotificationStatus
  const source = (searchParams.get('source') ?? '') as '' | OperatorNotificationSource

  function updateSearchParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (!value) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    setSearchParams(next, { replace: true })
  }

  async function load() {
    try {
      setLoading(true)
      const response = await directoryApi.listOperatorNotifications({
        q: query || undefined,
        status: status || undefined,
        source: source || undefined,
        limit: 200,
      })
      setNotifications(response.notifications)
      setTotal(response.total)
      setSummary(response.summary)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load operator inbox')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [query, source, status])

  async function updateSignal(id: number, nextStatus: OperatorNotificationStatus) {
    try {
      setSavingId(id)
      setNotice(null)
      const response = await directoryApi.updateOperatorNotification(id, { status: nextStatus })
      setNotifications((current) => current.map((entry) => (
        entry.id === response.notification.id ? response.notification : entry
      )))
      setNotice(`Signal marked ${nextStatus}.`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update operator signal')
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operator Inbox"
        description="New hosted beta requests and critical demo or evaluation failures land here until someone acknowledges or acts on them."
        actions={(
          <button className="btn-secondary" onClick={() => void load()} type="button">
            <RefreshCw size={16} />
            <span>Refresh</span>
          </button>
        )}
      />

      {summary ? (
        <section className="grid gap-4 md:grid-cols-5">
          <MetricCard label="Total signals" value={String(summary.total)} hint="All visible operator signals in the current filter." />
          <MetricCard label="New" value={String(summary.byStatus.new)} hint="Not yet triaged." tone={summary.byStatus.new > 0 ? 'warning' : 'default'} />
          <MetricCard label="Acknowledged" value={String(summary.byStatus.acknowledged)} hint="Seen and assigned, but not finished." />
          <MetricCard label="Acted" value={String(summary.byStatus.acted)} hint="A concrete next step has been recorded." tone="success" />
          <MetricCard label="Critical failures" value={String(summary.bySource.critical_alert)} hint="Signals tied to critical alerts." tone={summary.bySource.critical_alert > 0 ? 'critical' : 'default'} />
        </section>
      ) : null}

      <section className="panel">
        <div className="grid gap-3 lg:grid-cols-[1.8fr,1fr,1fr]">
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="input-field pl-10"
              placeholder="Search title, message, alert id, actor"
              value={query}
              onChange={(event) => updateSearchParam('q', event.target.value)}
            />
          </label>
          <select className="input-field" value={status} onChange={(event) => updateSearchParam('status', event.target.value)}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select className="input-field" value={source} onChange={(event) => updateSearchParam('source', event.target.value)}>
            {SOURCE_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}

      <section className="panel overflow-hidden p-0">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="panel-title">Signals</div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{total} signal(s) match the current filters.</p>
        </div>

        {loading ? (
          <div className="p-5 text-sm text-slate-500 dark:text-slate-400">Loading operator signals…</div>
        ) : notifications.length === 0 ? (
          <div className="p-5">
            <EmptyPanel label="No operator signals matched the current filters." />
          </div>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {notifications.map((notification) => (
              <div key={notification.id} className="space-y-4 px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill label={notification.status} tone={notificationTone(notification.status)} />
                  <StatusPill label={notification.sourceType === 'beta_request' ? 'beta request' : 'critical failure'} tone={notification.sourceType === 'critical_alert' ? 'critical' : 'warning'} />
                  <StatusPill label={notification.severity} tone={severityTone(notification.severity)} />
                  <span className="text-xs text-slate-500 dark:text-slate-400">{formatDateTime(notification.createdAt)}</span>
                </div>

                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{notification.title}</div>
                  <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{notification.message}</div>
                </div>

                <div className="grid gap-2 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2 lg:grid-cols-4">
                  <span>Updated {formatRelativeTime(notification.updatedAt)}</span>
                  <span>Acknowledged: {formatDateTime(notification.acknowledgedAt)}</span>
                  <span>Acted: {formatDateTime(notification.actedAt)}</span>
                  <span>Actor: {notification.actor ?? '—'}</span>
                </div>

                <div className="flex flex-wrap gap-2">
                  {notification.status !== 'acknowledged' ? (
                    <button
                      className="btn-secondary"
                      disabled={savingId === notification.id}
                      onClick={() => void updateSignal(notification.id, 'acknowledged')}
                      type="button"
                    >
                      <BellDot size={16} />
                      <span>{savingId === notification.id ? 'Saving…' : 'Acknowledge'}</span>
                    </button>
                  ) : null}
                  {notification.status !== 'acted' ? (
                    <button
                      className="btn-secondary"
                      disabled={savingId === notification.id}
                      onClick={() => void updateSignal(notification.id, 'acted')}
                      type="button"
                    >
                      <BellDot size={16} />
                      <span>{savingId === notification.id ? 'Saving…' : 'Mark acted'}</span>
                    </button>
                  ) : null}
                  {notification.status !== 'new' ? (
                    <button
                      className="btn-secondary"
                      disabled={savingId === notification.id}
                      onClick={() => void updateSignal(notification.id, 'new')}
                      type="button"
                    >
                      <BellDot size={16} />
                      <span>{savingId === notification.id ? 'Saving…' : 'Reset to new'}</span>
                    </button>
                  ) : null}
                  {notification.href ? (
                    <Link className="btn-secondary" to={notification.href}>
                      Open context
                    </Link>
                  ) : notification.betaRequestId ? (
                    <Link className="btn-secondary" to={`/beta-requests?id=${notification.betaRequestId}`}>
                      Open beta request
                    </Link>
                  ) : (
                    <Link className="btn-secondary" to="/alerts">
                      Open alerts
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function notificationTone(status: OperatorNotificationStatus | 'new'): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'acted':
      return 'success'
    case 'acknowledged':
      return 'default'
    case 'new':
    default:
      return 'warning'
  }
}

function severityTone(severity: 'info' | 'warning' | 'critical'): 'default' | 'success' | 'warning' | 'critical' {
  switch (severity) {
    case 'critical':
      return 'critical'
    case 'warning':
      return 'warning'
    default:
      return 'default'
  }
}
