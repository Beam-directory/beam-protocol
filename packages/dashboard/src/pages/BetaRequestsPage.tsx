import { useEffect, useMemo, useState } from 'react'
import { Download, RefreshCw, Search } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import { useAdminAuth } from '../lib/admin-auth'
import {
  ApiError,
  directoryApi,
  type BetaRequest,
  type BetaRequestStatus,
} from '../lib/api'
import { downloadBlob, formatDateTime, formatRelativeTime } from '../lib/utils'

const STATUS_OPTIONS: Array<{ value: '' | BetaRequestStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'new', label: 'New' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'active', label: 'Active' },
  { value: 'closed', label: 'Closed' },
]

export default function BetaRequestsPage() {
  const { session } = useAdminAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [requests, setRequests] = useState<BetaRequest[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<{
    total: number
    active: number
    unowned: number
    byStatus: Record<BetaRequestStatus, number>
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const query = searchParams.get('q') ?? ''
  const status = (searchParams.get('status') ?? '') as '' | BetaRequestStatus
  const ownerFilter = searchParams.get('owner') ?? ''
  const selectedId = Number.parseInt(searchParams.get('id') ?? '', 10)
  const canEdit = session?.role === 'admin' || session?.role === 'operator'

  const selectedRequest = useMemo(
    () => requests.find((entry) => entry.id === selectedId) ?? requests[0] ?? null,
    [requests, selectedId],
  )

  const [draftStatus, setDraftStatus] = useState<BetaRequestStatus>('new')
  const [draftOwner, setDraftOwner] = useState('')
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
      setDraftNotes('')
      return
    }

    setDraftStatus(selectedRequest.requestStatus)
    setDraftOwner(selectedRequest.owner ?? '')
    setDraftNotes(selectedRequest.operatorNotes ?? '')
  }, [selectedRequest])

  async function load() {
    try {
      setLoading(true)
      const response = await directoryApi.listBetaRequests({
        q: query || undefined,
        status: status || undefined,
        owner: ownerFilter || undefined,
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
  }, [ownerFilter, query, status])

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
        description="Review, assign, and export incoming hosted beta workflows without touching the database."
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
        <section className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Total requests" value={String(summary.total)} hint="All hosted beta requests in the current filter." />
          <MetricCard label="Active requests" value={String(summary.active)} hint="Everything that is not closed." tone="success" />
          <MetricCard label="Unowned" value={String(summary.unowned)} hint="Requests without an assigned operator." tone={summary.unowned > 0 ? 'warning' : 'default'} />
          <MetricCard label="New" value={String(summary.byStatus.new)} hint="Fresh requests that still need first review." tone={summary.byStatus.new > 0 ? 'warning' : 'default'} />
        </section>
      ) : null}

      <section className="panel">
        <div className="grid gap-3 lg:grid-cols-[1.5fr,0.8fr,0.8fr]">
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
          <input
            className="input-field"
            placeholder="Filter by owner"
            value={ownerFilter}
            onChange={(event) => updateSearchParam('owner', event.target.value)}
          />
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
                    className={`flex w-full flex-col gap-2 px-5 py-4 text-left transition ${active ? 'bg-orange-50 dark:bg-orange-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-900'}`}
                    onClick={() => updateSearchParam('id', String(entry.id))}
                    type="button"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill label={entry.requestStatus} tone={statusTone(entry.requestStatus)} />
                      <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{entry.company ?? entry.email}</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">{entry.email}</span>
                    </div>
                    <div className="text-sm text-slate-600 dark:text-slate-300">
                      {formatWorkflowType(entry.workflowType)}
                      {entry.agentCount != null ? ` · ${entry.agentCount} agent${entry.agentCount === 1 ? '' : 's'}` : ''}
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
                      <span>Owner: {entry.owner ?? 'unassigned'}</span>
                      <span>Updated {formatRelativeTime(entry.updatedAt)}</span>
                      <span>Source: {entry.source ?? 'unknown'}</span>
                    </div>
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
              <EmptyPanel label="Select a hosted beta request to inspect its workflow summary and assignment state." />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <InfoRow label="Company" value={selectedRequest.company ?? '—'} />
                  <InfoRow label="Email" value={selectedRequest.email} />
                  <InfoRow label="Workflow" value={formatWorkflowType(selectedRequest.workflowType)} />
                  <InfoRow label="Source" value={selectedRequest.source ?? '—'} />
                  <InfoRow label="Created" value={formatDateTime(selectedRequest.createdAt)} />
                  <InfoRow label="Updated" value={formatDateTime(selectedRequest.updatedAt)} />
                </div>

                <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                  {selectedRequest.workflowSummary || 'No workflow summary was provided in the intake.'}
                </div>
              </>
            )}
          </div>

          <div className="panel space-y-4">
            <div className="panel-title">Operator assignment</div>
            {!selectedRequest ? (
              <EmptyPanel label="Select a request to assign an owner, move the status, and capture follow-up notes." />
            ) : (
              <>
                <label className="block space-y-2">
                  <span className="text-sm font-medium">Status</span>
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
                  <span className="text-sm font-medium">Operator notes</span>
                  <textarea
                    className="input-field min-h-36"
                    disabled={!canEdit || saving}
                    placeholder="Capture the next step, missing context, or why the request is blocked."
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

function statusTone(status: BetaRequestStatus): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'active':
      return 'success'
    case 'closed':
      return 'default'
    case 'new':
    case 'reviewing':
    case 'contacted':
    case 'scheduled':
      return 'warning'
    default:
      return 'default'
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
