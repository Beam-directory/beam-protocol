import { Clock3, Download, RefreshCw, Search, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import { useAdminAuth } from '../lib/admin-auth'
import {
  ApiError,
  directoryApi,
  type BetaRequest,
  type BetaRequestAttention,
  type BetaRequestStatus,
  type OperatorNotificationStatus,
} from '../lib/api'
import { downloadBlob, formatDateTime, formatRelativeTime } from '../lib/utils'

const STATUS_OPTIONS: Array<{ value: '' | BetaRequestStatus; label: string }> = [
  { value: '', label: 'All stages' },
  { value: 'new', label: 'New' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'active', label: 'Active' },
  { value: 'closed', label: 'Closed' },
]

const ATTENTION_OPTIONS: Array<{ value: '' | BetaRequestAttention; label: string }> = [
  { value: '', label: 'All requests' },
  { value: 'unowned', label: 'Unowned' },
  { value: 'stale', label: 'Stale' },
]

const SORT_OPTIONS = [
  { value: 'attention', label: 'Attention first' },
  { value: 'updated_desc', label: 'Recently updated' },
  { value: 'last_contact_desc', label: 'Recent contact' },
  { value: 'stage', label: 'Stage' },
  { value: 'owner', label: 'Owner' },
  { value: 'created_desc', label: 'Recently created' },
] as const

type SortOption = typeof SORT_OPTIONS[number]['value']

export default function BetaRequestsPage() {
  const { session } = useAdminAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [requests, setRequests] = useState<BetaRequest[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<{
    total: number
    active: number
    unowned: number
    stale: number
    needsAttention: number
    byStatus: Record<BetaRequestStatus, number>
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const query = searchParams.get('q') ?? ''
  const status = (searchParams.get('status') ?? '') as '' | BetaRequestStatus
  const ownerFilter = searchParams.get('owner') ?? ''
  const attention = (searchParams.get('attention') ?? '') as '' | BetaRequestAttention
  const sort = (searchParams.get('sort') ?? 'attention') as SortOption
  const selectedId = Number.parseInt(searchParams.get('id') ?? '', 10)
  const canEdit = session?.role === 'admin' || session?.role === 'operator'

  const selectedRequest = useMemo(
    () => requests.find((entry) => entry.id === selectedId) ?? requests[0] ?? null,
    [requests, selectedId],
  )

  const [draftStatus, setDraftStatus] = useState<BetaRequestStatus>('new')
  const [draftOwner, setDraftOwner] = useState('')
  const [draftNextAction, setDraftNextAction] = useState('')
  const [draftLastContactAt, setDraftLastContactAt] = useState('')
  const [draftNotes, setDraftNotes] = useState('')

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
    if (!selectedRequest) {
      return
    }

    if (!selectedId || selectedId !== selectedRequest.id) {
      const next = new URLSearchParams(searchParams)
      next.set('id', String(selectedRequest.id))
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, selectedId, selectedRequest, setSearchParams])

  useEffect(() => {
    if (!selectedRequest) {
      setDraftStatus('new')
      setDraftOwner('')
      setDraftNextAction('')
      setDraftLastContactAt('')
      setDraftNotes('')
      return
    }

    setDraftStatus(selectedRequest.stage)
    setDraftOwner(selectedRequest.owner ?? '')
    setDraftNextAction(selectedRequest.nextAction ?? '')
    setDraftLastContactAt(toDateTimeLocalValue(selectedRequest.lastContactAt))
    setDraftNotes(selectedRequest.operatorNotes ?? '')
  }, [selectedRequest])

  async function load() {
    try {
      setLoading(true)
      const response = await directoryApi.listBetaRequests({
        q: query || undefined,
        status: status || undefined,
        owner: ownerFilter || undefined,
        attention: attention || undefined,
        sort,
        limit: 200,
      })
      setRequests(response.requests)
      setTotal(response.total)
      setSummary(response.summary)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load hosted beta requests')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [attention, ownerFilter, query, sort, status])

  async function saveRequest() {
    if (!selectedRequest || !canEdit) {
      return
    }

    try {
      setSaving(true)
      setNotice(null)
      const response = await directoryApi.updateBetaRequest(selectedRequest.id, {
        status: draftStatus,
        owner: draftOwner || null,
        nextAction: draftNextAction || null,
        lastContactAt: draftLastContactAt || null,
        operatorNotes: draftNotes || null,
      })
      setRequests((current) => current.map((entry) => (
        entry.id === response.request.id ? response.request : entry
      )))
      setNotice('Operator updates saved.')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save beta request')
    } finally {
      setSaving(false)
    }
  }

  async function exportRequests(format: 'json' | 'csv') {
    try {
      setNotice(null)
      const download = await directoryApi.downloadBetaRequestsExport(format, {
        q: query || undefined,
        status: status || undefined,
        owner: ownerFilter || undefined,
        attention: attention || undefined,
        sort,
        limit: 5000,
      })
      downloadBlob(download.blob, download.filename)
      setNotice(`Exported hosted beta requests as ${format.toUpperCase()}.`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to export beta requests')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Hosted Beta Requests"
        description="Run hosted beta intake as a real operator queue with stage, ownership, next action, and follow-up state."
        actions={(
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => void exportRequests('json')} type="button">
              <Download size={16} />
              <span>Export JSON</span>
            </button>
            <button className="btn-secondary" onClick={() => void exportRequests('csv')} type="button">
              <Download size={16} />
              <span>Export CSV</span>
            </button>
            <button className="btn-secondary" onClick={() => void load()} type="button">
              <RefreshCw size={16} />
              <span>Refresh</span>
            </button>
          </div>
        )}
      />

      {summary ? (
        <section className="grid gap-4 md:grid-cols-4 xl:grid-cols-5">
          <MetricCard label="Total requests" value={String(summary.total)} hint="All hosted beta requests in the current filter." />
          <MetricCard label="Need attention" value={String(summary.needsAttention)} hint="Requests that are unowned or stale." tone={summary.needsAttention > 0 ? 'warning' : 'default'} />
          <MetricCard label="Unowned" value={String(summary.unowned)} hint="Requests without an assigned operator." tone={summary.unowned > 0 ? 'critical' : 'default'} />
          <MetricCard label="Stale" value={String(summary.stale)} hint="Requests that have gone too long without contact." tone={summary.stale > 0 ? 'warning' : 'default'} />
          <MetricCard label="Active" value={String(summary.active)} hint="Everything that is not closed." tone="success" />
        </section>
      ) : null}

      <section className="panel">
        <div className="grid gap-3 xl:grid-cols-[1.6fr,0.9fr,0.9fr,0.9fr,0.9fr]">
          <label className="relative block">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="input-field pl-10"
              placeholder="Search email, company, workflow, notes"
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
          <select className="input-field" value={attention} onChange={(event) => updateSearchParam('attention', event.target.value)}>
            {ATTENTION_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            className="input-field"
            placeholder="Filter by owner"
            value={ownerFilter}
            onChange={(event) => updateSearchParam('owner', event.target.value)}
          />
          <select className="input-field" value={sort} onChange={(event) => updateSearchParam('sort', event.target.value)}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
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
            <div className="panel-title">Queue</div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{total} request(s) match the current filters.</p>
          </div>

          {loading ? (
            <div className="p-5 text-sm text-slate-500 dark:text-slate-400">Loading hosted beta requests…</div>
          ) : requests.length === 0 ? (
            <div className="p-5">
              <EmptyPanel label="No hosted beta requests matched the current filters." />
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {requests.map((entry) => {
                const active = selectedRequest?.id === entry.id

                return (
                  <button
                    key={entry.id}
                    className={`flex w-full flex-col gap-3 px-5 py-4 text-left transition ${active ? 'bg-orange-50 dark:bg-orange-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-900'}`}
                    onClick={() => updateSearchParam('id', String(entry.id))}
                    type="button"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill label={entry.stage} tone={stageTone(entry.stage)} />
                      {entry.notificationStatus ? <StatusPill label={`signal ${entry.notificationStatus}`} tone={signalTone(entry.notificationStatus)} /> : null}
                      {entry.attentionFlags.map((flag) => (
                        <StatusPill key={`${entry.id}-${flag}`} label={flag} tone={flag === 'unowned' ? 'critical' : 'warning'} />
                      ))}
                    </div>

                    <div>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{entry.company ?? entry.email}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{entry.email}</div>
                    </div>

                    <div className="text-sm text-slate-600 dark:text-slate-300">
                      {formatWorkflowType(entry.workflowType)}
                      {entry.agentCount != null ? ` · ${entry.agentCount} agent${entry.agentCount === 1 ? '' : 's'}` : ''}
                    </div>

                    <div className="grid gap-2 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2">
                      <span>Owner: {entry.owner ?? 'unassigned'}</span>
                      <span>Updated {formatRelativeTime(entry.updatedAt)}</span>
                      <span>Last contact: {entry.lastContactAt ? formatRelativeTime(entry.lastContactAt) : 'not recorded'}</span>
                      <span>Source: {entry.source ?? 'unknown'}</span>
                    </div>

                    <div className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                      {entry.nextAction ?? 'No next action is recorded yet.'}
                    </div>

                    {entry.staleReason ? (
                      <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                        <TriangleAlert size={16} className="mt-0.5 shrink-0" />
                        <span>{entry.staleReason}</span>
                      </div>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="panel space-y-4">
            <div className="panel-title">Request detail</div>
            {!selectedRequest ? (
              <EmptyPanel label="Select a hosted beta request to inspect its workflow summary and operator state." />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <InfoRow label="Company" value={selectedRequest.company ?? '—'} />
                  <InfoRow label="Email" value={selectedRequest.email} />
                  <InfoRow label="Stage" value={selectedRequest.stage} />
                  <InfoRow label="Signal" value={selectedRequest.notificationStatus ?? 'no operator signal'} />
                  <InfoRow label="Created" value={formatDateTime(selectedRequest.createdAt)} />
                  <InfoRow label="Updated" value={formatDateTime(selectedRequest.updatedAt)} />
                  <InfoRow label="Last contact" value={formatDateTime(selectedRequest.lastContactAt)} />
                  <InfoRow label="Owner" value={selectedRequest.owner ?? 'unassigned'} />
                </div>

                <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                  {selectedRequest.workflowSummary || 'No workflow summary was provided in the intake.'}
                </div>

                <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Next action</div>
                  <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    {selectedRequest.nextAction ?? 'No next action is recorded yet.'}
                  </div>
                  {selectedRequest.notificationId ? (
                    <div className="mt-3">
                      <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to="/inbox">
                        Open operator inbox signal
                      </Link>
                    </div>
                  ) : null}
                </div>

                {selectedRequest.staleReason ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    {selectedRequest.staleReason}
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="panel space-y-4">
            <div className="panel-title">Operator assignment</div>
            {!selectedRequest ? (
              <EmptyPanel label="Select a request to assign an owner, move the stage, and capture follow-up." />
            ) : (
              <>
                <label className="block space-y-2">
                  <span className="text-sm font-medium">Stage</span>
                  <select
                    className="input-field"
                    disabled={!canEdit || saving}
                    value={draftStatus}
                    onChange={(event) => setDraftStatus(event.target.value as BetaRequestStatus)}
                  >
                    {STATUS_OPTIONS.filter((option) => option.value).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium">Owner</span>
                  <input
                    className="input-field"
                    disabled={!canEdit || saving}
                    placeholder="operator@beam.directory"
                    value={draftOwner}
                    onChange={(event) => setDraftOwner(event.target.value)}
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium">Next action</span>
                  <textarea
                    className="input-field min-h-28"
                    disabled={!canEdit || saving}
                    placeholder="What exactly happens next, and who is waiting on it?"
                    value={draftNextAction}
                    onChange={(event) => setDraftNextAction(event.target.value)}
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-sm font-medium">Last contact</span>
                  <input
                    className="input-field"
                    disabled={!canEdit || saving}
                    type="datetime-local"
                    value={draftLastContactAt}
                    onChange={(event) => setDraftLastContactAt(event.target.value)}
                  />
                </label>

                <button
                  className="btn-secondary"
                  disabled={!canEdit || saving}
                  onClick={() => setDraftLastContactAt(toDateTimeLocalValue(new Date().toISOString()))}
                  type="button"
                >
                  <Clock3 size={16} />
                  <span>Mark contact now</span>
                </button>

                <label className="block space-y-2">
                  <span className="text-sm font-medium">Operator notes</span>
                  <textarea
                    className="input-field min-h-36"
                    disabled={!canEdit || saving}
                    placeholder="Capture missing context, qualification notes, blockers, or why this request is paused."
                    value={draftNotes}
                    onChange={(event) => setDraftNotes(event.target.value)}
                  />
                </label>

                <div className="flex flex-wrap gap-3">
                  <button
                    className="btn-primary disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!canEdit || saving}
                    onClick={() => void saveRequest()}
                    type="button"
                  >
                    {saving ? 'Saving…' : 'Save operator update'}
                  </button>
                  {!canEdit ? (
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                      Viewer sessions can inspect and export, but not edit.
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function formatWorkflowType(value: string | null): string {
  if (!value) {
    return 'No workflow type'
  }

  return value
    .replace(/^hosted-beta-/, '')
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function stageTone(stage: BetaRequestStatus): 'default' | 'success' | 'warning' | 'critical' {
  switch (stage) {
    case 'active':
      return 'success'
    case 'closed':
      return 'default'
    default:
      return 'warning'
  }
}

function signalTone(status: OperatorNotificationStatus): 'default' | 'success' | 'warning' | 'critical' {
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 break-words text-sm font-medium text-slate-900 dark:text-slate-100">{value}</div>
    </div>
  )
}

function toDateTimeLocalValue(value?: string | null): string {
  if (!value) {
    return ''
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const offset = date.getTimezoneOffset()
  const localDate = new Date(date.getTime() - offset * 60_000)
  return localDate.toISOString().slice(0, 16)
}
