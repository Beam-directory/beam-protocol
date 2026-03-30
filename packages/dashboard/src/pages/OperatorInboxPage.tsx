import { BellDot, RefreshCw, Search, Save } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import { useAdminAuth } from '../lib/admin-auth'
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
  const { session } = useAdminAuth()
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
  const selectedId = Number.parseInt(searchParams.get('id') ?? '', 10)
  const canEdit = session?.role === 'admin' || session?.role === 'operator'

  const selectedNotification = useMemo(
    () => notifications.find((entry) => entry.id === selectedId) ?? notifications[0] ?? null,
    [notifications, selectedId],
  )

  const [draftStatus, setDraftStatus] = useState<OperatorNotificationStatus>('new')
  const [draftOwner, setDraftOwner] = useState('')
  const [draftNextAction, setDraftNextAction] = useState('')

  function updateSearchParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (!value) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    setSearchParams(next, { replace: true })
  }

  useEffect(() => {
    if (!selectedNotification) {
      return
    }

    if (!selectedId || selectedId !== selectedNotification.id) {
      const next = new URLSearchParams(searchParams)
      next.set('id', String(selectedNotification.id))
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, selectedId, selectedNotification, setSearchParams])

  useEffect(() => {
    if (!selectedNotification) {
      setDraftStatus('new')
      setDraftOwner('')
      setDraftNextAction('')
      return
    }

    setDraftStatus(selectedNotification.status)
    setDraftOwner(selectedNotification.owner ?? '')
    setDraftNextAction(selectedNotification.nextAction ?? '')
  }, [selectedNotification])

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

  async function saveNotification(
    id: number,
    input: {
      status?: OperatorNotificationStatus
      owner?: string | null
      nextAction?: string | null
    },
    successMessage: string,
  ) {
    try {
      setSavingId(id)
      setNotice(null)
      const response = await directoryApi.updateOperatorNotification(id, input)
      setNotifications((current) => current.map((entry) => (
        entry.id === response.notification.id ? response.notification : entry
      )))
      setNotice(successMessage)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update operator signal')
    } finally {
      setSavingId(null)
    }
  }

  async function saveSelectedNotification() {
    if (!selectedNotification || !canEdit || selectedNotification.sourceType !== 'critical_alert') {
      return
    }

    await saveNotification(selectedNotification.id, {
      status: draftStatus,
      owner: draftOwner || null,
      nextAction: draftNextAction || null,
    }, 'Critical alert handoff saved.')
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operator Inbox"
        description="Critical alerts and hosted beta requests land here until someone owns them and records the next action."
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
              placeholder="Search title, message, owner, actor, alert id"
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

      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel overflow-hidden p-0">
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
              {notifications.map((notification) => {
                const active = selectedNotification?.id === notification.id

                return (
                  <div
                    key={notification.id}
                    className={`flex w-full cursor-pointer flex-col gap-3 px-5 py-4 text-left transition ${active ? 'bg-orange-50 dark:bg-orange-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-900'}`}
                    onClick={() => updateSearchParam('id', String(notification.id))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        updateSearchParam('id', String(notification.id))
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
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
                      <span>Owner: {notification.owner ?? 'unassigned'}</span>
                      <span>Updated {formatRelativeTime(notification.updatedAt)}</span>
                      <span>Actor: {notification.actor ?? '—'}</span>
                      <span>Next: {notification.nextAction ?? 'not recorded'}</span>
                    </div>

                    <div className="flex flex-wrap gap-2" onClick={(event) => event.stopPropagation()}>
                      {notification.status !== 'acknowledged' ? (
                        <button
                          className="btn-secondary"
                          disabled={savingId === notification.id}
                          onClick={() => void saveNotification(notification.id, { status: 'acknowledged' }, 'Signal marked acknowledged.')}
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
                          onClick={() => void saveNotification(notification.id, { status: 'acted' }, 'Signal marked acted.')}
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
                          onClick={() => void saveNotification(notification.id, { status: 'new' }, 'Signal reset to new.')}
                          type="button"
                        >
                          <BellDot size={16} />
                          <span>{savingId === notification.id ? 'Saving…' : 'Reset to new'}</span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">Selected Signal</div>
          {!selectedNotification ? (
            <div className="mt-4">
              <EmptyPanel label="Select a signal to assign an owner, inspect context, and record the next action." />
            </div>
          ) : (
            <div className="mt-4 space-y-5">
              <div className="space-y-3">
                <InfoRow label="Title" value={selectedNotification.title} />
                <InfoRow label="Source" value={selectedNotification.sourceType === 'beta_request' ? 'Hosted beta request' : 'Critical alert'} />
                <InfoRow label="Severity" value={selectedNotification.severity} />
                <InfoRow label="Status" value={selectedNotification.status} />
                <InfoRow label="Owner" value={selectedNotification.owner ?? 'unassigned'} />
                <InfoRow label="Updated" value={formatDateTime(selectedNotification.updatedAt)} />
                <InfoRow label="Acknowledged" value={formatDateTime(selectedNotification.acknowledgedAt)} />
                <InfoRow label="Acted" value={formatDateTime(selectedNotification.actedAt)} />
              </div>

              <div className="rounded-xl bg-slate-50 px-4 py-4 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                <div className="font-medium text-slate-900 dark:text-slate-100">Current next action</div>
                <div className="mt-2">{selectedNotification.nextAction ?? 'No next action has been recorded yet.'}</div>
              </div>

              <div className="flex flex-wrap gap-2">
                {selectedNotification.href ? (
                  <Link className="btn-secondary" to={selectedNotification.href}>
                    Open linked context
                  </Link>
                ) : null}
                {selectedNotification.betaRequestId ? (
                  <Link className="btn-secondary" to={`/beta-requests?id=${selectedNotification.betaRequestId}`}>
                    Open beta request
                  </Link>
                ) : (
                  <Link className="btn-secondary" to="/alerts">
                    Open alerts
                  </Link>
                )}
              </div>

              {selectedNotification.sourceType === 'critical_alert' ? (
                <div className="space-y-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="font-medium text-slate-900 dark:text-slate-100">Ownership and recovery</div>
                  <div className="grid gap-3">
                    <select className="input-field" value={draftStatus} onChange={(event) => setDraftStatus(event.target.value as OperatorNotificationStatus)}>
                      {STATUS_OPTIONS.filter((option) => option.value).map((option) => (
                        <option key={option.label} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input-field"
                      placeholder="Owner"
                      value={draftOwner}
                      onChange={(event) => setDraftOwner(event.target.value)}
                    />
                    <textarea
                      className="input-field min-h-28"
                      placeholder="Next action"
                      value={draftNextAction}
                      onChange={(event) => setDraftNextAction(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn-secondary"
                      disabled={!canEdit || savingId === selectedNotification.id}
                      onClick={() => void saveSelectedNotification()}
                      type="button"
                    >
                      <Save size={16} />
                      <span>{savingId === selectedNotification.id ? 'Saving…' : 'Save handoff'}</span>
                    </button>
                    <a className="btn-secondary" href="https://docs.beam.directory/guide/operator-runbook#alerts" rel="noreferrer" target="_blank">
                      Open alert runbook
                    </a>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-200 px-4 py-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                  Beta-request ownership lives in the beta request queue so the workflow stage, owner, and next action stay in one place.
                  <div className="mt-3">
                    <Link className="btn-secondary" to={`/beta-requests?id=${selectedNotification.betaRequestId ?? ''}`}>
                      Open beta request queue
                    </Link>
                  </div>
                </div>
              )}

              {selectedNotification.details ? (
                <div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Signal details</div>
                  <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                    {JSON.stringify(selectedNotification.details, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-3 text-sm last:border-b-0 last:pb-0 dark:border-slate-800">
      <div className="text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-right text-slate-900 dark:text-slate-100">{value}</div>
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
