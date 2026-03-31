import { ArrowUpRight, CalendarClock, CheckCircle2, Clock3, Copy, Download, RefreshCw, Search, TriangleAlert, UserRoundPlus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import { useAdminAuth } from '../lib/admin-auth'
import {
  ApiError,
  directoryApi,
  type BetaRequestActivityEntry,
  type BetaRequestDetailResponse,
  type BetaRequestProofSummary,
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
  { value: 'follow_up_due', label: 'Follow-up due' },
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

const ONBOARDING_PACK_URL = 'https://docs.beam.directory/guide/design-partner-onboarding'
const GUIDED_EVALUATION_URL = 'https://beam.directory/guided-evaluation.html'

export default function BetaRequestsPage() {
  const { session } = useAdminAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [requests, setRequests] = useState<BetaRequest[]>([])
  const [selectedDetail, setSelectedDetail] = useState<BetaRequestDetailResponse | null>(null)
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<{
    total: number
    active: number
    unowned: number
    stale: number
    followUpDue: number
    needsAttention: number
    byStatus: Record<BetaRequestStatus, number>
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [copyNotice, setCopyNotice] = useState<string | null>(null)

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
  const detailRequest = selectedDetail?.request ?? selectedRequest
  const activity = selectedDetail?.activity ?? []
  const proofSummary = selectedDetail?.proofSummary ?? null

  const [draftStatus, setDraftStatus] = useState<BetaRequestStatus>('new')
  const [draftOwner, setDraftOwner] = useState('')
  const [draftNextAction, setDraftNextAction] = useState('')
  const [draftLastContactAt, setDraftLastContactAt] = useState('')
  const [draftNextMeetingAt, setDraftNextMeetingAt] = useState('')
  const [draftReminderAt, setDraftReminderAt] = useState('')
  const [draftProofIntentNonce, setDraftProofIntentNonce] = useState('')
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
    if (!detailRequest) {
      setDraftStatus('new')
      setDraftOwner('')
      setDraftNextAction('')
      setDraftLastContactAt('')
      setDraftNextMeetingAt('')
      setDraftReminderAt('')
      setDraftProofIntentNonce('')
      setDraftNotes('')
      return
    }

    setDraftStatus(detailRequest.stage)
    setDraftOwner(detailRequest.owner ?? '')
    setDraftNextAction(detailRequest.nextAction ?? '')
    setDraftLastContactAt(toDateTimeLocalValue(detailRequest.lastContactAt))
    setDraftNextMeetingAt(toDateTimeLocalValue(detailRequest.nextMeetingAt))
    setDraftReminderAt(toDateTimeLocalValue(detailRequest.reminderAt))
    setDraftProofIntentNonce(detailRequest.proofIntentNonce ?? '')
    setDraftNotes(detailRequest.operatorNotes ?? '')
  }, [detailRequest])

  async function loadRequestDetail(id: number) {
    try {
      setDetailLoading(true)
      setCopyNotice(null)
      const response = await directoryApi.getBetaRequest(id)
      setSelectedDetail(response)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load request detail')
    } finally {
      setDetailLoading(false)
    }
  }

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

  useEffect(() => {
    if (!selectedRequest) {
      setSelectedDetail(null)
      setDetailLoading(false)
      return
    }

    void loadRequestDetail(selectedRequest.id)
  }, [selectedRequest?.id])

  async function saveRequest() {
    if (!detailRequest || !canEdit) {
      return
    }

    try {
      setSaving(true)
      setNotice(null)
      setCopyNotice(null)
      const response = await directoryApi.updateBetaRequest(detailRequest.id, {
        status: draftStatus,
        owner: draftOwner || null,
        nextAction: draftNextAction || null,
        lastContactAt: draftLastContactAt || null,
        nextMeetingAt: draftNextMeetingAt || null,
        reminderAt: draftReminderAt || null,
        proofIntentNonce: draftProofIntentNonce || null,
        operatorNotes: draftNotes || null,
      })
      setRequests((current) => current.map((entry) => (
        entry.id === response.request.id ? response.request : entry
      )))
      setNotice('Operator updates saved.')
      await Promise.all([load(), loadRequestDetail(response.request.id)])
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

  async function copyProofMarkdown(summary: BetaRequestProofSummary) {
    try {
      await navigator.clipboard.writeText(summary.markdown)
      setCopyNotice('Pilot proof summary copied.')
      setError(null)
    } catch {
      setError('Failed to copy the pilot proof summary.')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Hosted Beta Requests"
        description="Run hosted beta intake as a real operator queue with stage, ownership, next action, meeting state, and follow-up timing."
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
        <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard label="Total requests" value={String(summary.total)} hint="All hosted beta requests in the current filter." />
          <MetricCard label="Need attention" value={String(summary.needsAttention)} hint="Requests that are unowned, stale, or due for follow-up." tone={summary.needsAttention > 0 ? 'warning' : 'default'} />
          <MetricCard label="Unowned" value={String(summary.unowned)} hint="Requests without an assigned operator." tone={summary.unowned > 0 ? 'critical' : 'default'} />
          <MetricCard label="Stale" value={String(summary.stale)} hint="Requests that have gone too long without contact." tone={summary.stale > 0 ? 'warning' : 'default'} />
          <MetricCard label="Follow-up due" value={String(summary.followUpDue)} hint="Requests with a due reminder or missing next meeting state." tone={summary.followUpDue > 0 ? 'warning' : 'default'} />
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

      {copyNotice ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
          {copyNotice}
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
                        <StatusPill key={`${entry.id}-${flag}`} label={formatAttentionFlag(flag)} tone={flag === 'unowned' ? 'critical' : 'warning'} />
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
                      <span>Stage age: {entry.stageAgeLabel}</span>
                      <span>Last contact: {entry.lastContactAt ? formatRelativeTime(entry.lastContactAt) : 'not recorded'}</span>
                      <span>Next meeting: {entry.nextMeetingAt ? formatRelativeTime(entry.nextMeetingAt) : 'not scheduled'}</span>
                      <span>Reminder: {entry.reminderAt ? formatRelativeTime(entry.reminderAt) : 'not set'}</span>
                      <span>Source: {entry.source ?? 'unknown'}</span>
                    </div>

                    <div className="rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                      {entry.nextAction ?? 'No next action is recorded yet.'}
                    </div>

                    {entry.staleReason || entry.followUpReason ? (
                      <div className="space-y-2">
                        {[entry.followUpReason, entry.staleReason].filter(Boolean).map((message) => (
                          <div key={message} className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                            <TriangleAlert size={16} className="mt-0.5 shrink-0" />
                            <span>{message}</span>
                          </div>
                        ))}
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
            {!detailRequest ? (
              <EmptyPanel label="Select a hosted beta request to inspect its workflow summary and operator state." />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <InfoRow label="Company" value={detailRequest.company ?? '—'} />
                  <InfoRow label="Email" value={detailRequest.email} />
                  <InfoRow label="Stage" value={detailRequest.stage} />
                  <InfoRow label="Signal" value={detailRequest.notificationStatus ?? 'no operator signal'} />
                  <InfoRow label="Created" value={formatDateTime(detailRequest.createdAt)} />
                  <InfoRow label="Updated" value={formatDateTime(detailRequest.updatedAt)} />
                  <InfoRow label="Stage entered" value={formatDateTime(detailRequest.stageEnteredAt)} />
                  <InfoRow label="Stage age" value={detailRequest.stageAgeLabel} />
                  <InfoRow label="Last contact" value={formatDateTime(detailRequest.lastContactAt)} />
                  <InfoRow label="Next meeting" value={formatDateTime(detailRequest.nextMeetingAt)} />
                  <InfoRow label="Reminder" value={formatDateTime(detailRequest.reminderAt)} />
                  <InfoRow label="Owner" value={detailRequest.owner ?? 'unassigned'} />
                </div>

                <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                  {detailRequest.workflowSummary || 'No workflow summary was provided in the intake.'}
                </div>

                <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Next action</div>
                  <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                    {detailRequest.nextAction ?? 'No next action is recorded yet.'}
                  </div>
                  {detailRequest.notificationId ? (
                    <div className="mt-3">
                      <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/inbox?id=${detailRequest.notificationId}`}>
                        Open operator inbox signal
                      </Link>
                    </div>
                  ) : null}
                </div>

                {detailRequest.staleReason || detailRequest.followUpReason ? (
                  <div className="space-y-3">
                    {[detailRequest.followUpReason, detailRequest.staleReason].filter(Boolean).map((message) => (
                      <div key={message} className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                        {message}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>

          <div className="panel space-y-4">
            <div className="panel-title">Pilot proof summary</div>
            {!detailRequest ? (
              <EmptyPanel label="Select a request to generate a buyer-friendly proof summary from a live pilot trace." />
            ) : !proofSummary ? (
              <EmptyPanel label={detailRequest.proofIntentNonce
                ? 'Beam could not generate a proof summary for the linked nonce yet.'
                : 'Link a pilot trace nonce to this request to generate a shareable proof summary.'}
              />
            ) : (
              <>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
                  <div className="font-medium">{proofSummary.headline}</div>
                  <div className="mt-2">{proofSummary.summary}</div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <InfoRow label="Proof nonce" value={proofSummary.proofIntentNonce} />
                  <InfoRow label="Intent" value={proofSummary.delivery.intentType} />
                  <InfoRow label="Delivery status" value={proofSummary.delivery.status} />
                  <InfoRow label="Latency" value={proofSummary.delivery.latencyMs == null ? 'n/a' : `${proofSummary.delivery.latencyMs}ms`} />
                  <InfoRow label="Sender" value={proofSummary.identity.sender.displayName} />
                  <InfoRow label="Recipient" value={proofSummary.identity.recipient.displayName} />
                  <InfoRow label="Sender trust" value={formatTrustScore(proofSummary.identity.sender.trustScore)} />
                  <InfoRow label="Recipient trust" value={formatTrustScore(proofSummary.identity.recipient.trustScore)} />
                  <InfoRow label="Signal status" value={proofSummary.operatorVisibility.signalStatus} />
                  <InfoRow label="Live agents (24h)" value={String(proofSummary.operatorVisibility.liveAgents)} />
                </div>

                <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Recommended next step</div>
                  <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{proofSummary.recommendation}</div>
                </div>

                <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Shareable markdown</div>
                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-slate-600 dark:text-slate-300">{proofSummary.markdown}</pre>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button className="btn-secondary" onClick={() => void copyProofMarkdown(proofSummary)} type="button">
                    <Copy size={16} />
                    <span>Copy summary</span>
                  </button>
                  <Link className="btn-secondary" to={proofSummary.operatorVisibility.traceHref}>
                    <span>Open trace</span>
                  </Link>
                  {proofSummary.operatorVisibility.signalHref ? (
                    <Link className="btn-secondary" to={proofSummary.operatorVisibility.signalHref}>
                      <span>Open signal</span>
                    </Link>
                  ) : null}
                </div>
              </>
            )}
          </div>

          <div className="panel space-y-4">
            <div className="panel-title">Activity timeline</div>
            {!detailRequest ? (
              <EmptyPanel label="Select a request to inspect the partner activity timeline and the next planned follow-up." />
            ) : detailLoading ? (
              <div className="text-sm text-slate-500 dark:text-slate-400">Loading recent partner activity…</div>
            ) : activity.length === 0 ? (
              <EmptyPanel label="No partner activity has been recorded for this request yet." />
            ) : (
              <>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Recent operator movement plus the next scheduled touchpoints for this design-partner thread.
                </p>
                <div className="space-y-3">
                  {activity.map((entry) => (
                    <div key={entry.key} className={`rounded-xl border px-4 py-4 ${activityToneClasses(entry.tone)}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-medium">{entry.title}</div>
                        <div className="text-xs opacity-80">{formatDateTime(entry.timestamp)}</div>
                      </div>
                      <div className="mt-2 text-sm opacity-90">{entry.detail}</div>
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs opacity-80">
                        <span>{formatActivityKind(entry.kind)}</span>
                        <span>{entry.actor ? `Actor: ${entry.actor}` : 'Actor: system'}</span>
                        {entry.upcoming ? <span>Upcoming</span> : null}
                        {entry.href ? (
                          <Link className="inline-flex items-center gap-1 text-orange-700 hover:text-orange-800 dark:text-orange-300 dark:hover:text-orange-200" to={entry.href}>
                            <span>Open linked surface</span>
                            <ArrowUpRight size={14} />
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-3">
                  {detailRequest.notificationId ? (
                    <Link className="btn-secondary" to={`/inbox?id=${detailRequest.notificationId}`}>
                      <span>Open operator signal</span>
                    </Link>
                  ) : null}
                  <Link className="btn-secondary" to="/inbox?source=beta_request">
                    <span>Open beta inbox</span>
                  </Link>
                </div>
              </>
            )}
          </div>

          <div className="panel space-y-4">
            <div className="panel-title">Operator assignment</div>
            {!detailRequest ? (
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

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block space-y-2">
                    <span className="text-sm font-medium">Next meeting</span>
                    <input
                      className="input-field"
                      disabled={!canEdit || saving}
                      type="datetime-local"
                      value={draftNextMeetingAt}
                      onChange={(event) => setDraftNextMeetingAt(event.target.value)}
                    />
                  </label>

                  <label className="block space-y-2">
                    <span className="text-sm font-medium">Reminder</span>
                    <input
                      className="input-field"
                      disabled={!canEdit || saving}
                      type="datetime-local"
                      value={draftReminderAt}
                      onChange={(event) => setDraftReminderAt(event.target.value)}
                    />
                  </label>
                </div>

                <label className="block space-y-2">
                  <span className="text-sm font-medium">Proof trace nonce</span>
                  <input
                    className="input-field"
                    disabled={!canEdit || saving}
                    placeholder="beam-proof-123456"
                    value={draftProofIntentNonce}
                    onChange={(event) => setDraftProofIntentNonce(event.target.value)}
                  />
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Link the exact pilot trace that should back the buyer-facing proof summary.
                  </span>
                </label>

                <div className="flex flex-wrap gap-3">
                  {session?.email ? (
                    <button
                      className="btn-secondary"
                      disabled={!canEdit || saving}
                      onClick={() => setDraftOwner(session.email)}
                      type="button"
                    >
                      <UserRoundPlus size={16} />
                      <span>Assign to me</span>
                    </button>
                  ) : null}
                  <button
                    className="btn-secondary"
                    disabled={!canEdit || saving}
                    onClick={() => setDraftLastContactAt(toDateTimeLocalValue(new Date().toISOString()))}
                    type="button"
                  >
                    <Clock3 size={16} />
                    <span>Mark contact now</span>
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={!canEdit || saving}
                    onClick={() => setDraftNextMeetingAt(futureDateTimeLocalValue({ days: 3 }))}
                    type="button"
                  >
                    <Clock3 size={16} />
                    <span>Set meeting +3 days</span>
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={!canEdit || saving}
                    onClick={() => setDraftReminderAt(futureDateTimeLocalValue({ days: 1 }))}
                    type="button"
                  >
                    <Clock3 size={16} />
                    <span>Set reminder +1 day</span>
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={!canEdit || saving}
                    onClick={() => {
                      setDraftStatus('scheduled')
                      setDraftNextMeetingAt(futureDateTimeLocalValue({ days: 3 }))
                      if (!draftReminderAt) {
                        setDraftReminderAt(futureDateTimeLocalValue({ days: 1 }))
                      }
                    }}
                    type="button"
                  >
                    <CalendarClock size={16} />
                    <span>Queue walkthrough</span>
                  </button>
                  <button
                    className="btn-secondary"
                    disabled={!canEdit || saving}
                    onClick={() => {
                      setDraftStatus('active')
                      setDraftLastContactAt(toDateTimeLocalValue(new Date().toISOString()))
                      if (!draftReminderAt) {
                        setDraftReminderAt(futureDateTimeLocalValue({ days: 2 }))
                      }
                    }}
                    type="button"
                  >
                    <CheckCircle2 size={16} />
                    <span>Mark follow-up active</span>
                  </button>
                </div>

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

          <div className="panel space-y-4">
            <div className="panel-title">Onboarding pack</div>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Keep external evaluations on the same script: public proof first, then the onboarding pack, then the stage-specific follow-up template.
            </p>
            <div className="grid gap-3">
              <a
                className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-900 transition hover:border-orange-300 hover:bg-orange-50 dark:border-slate-800 dark:text-slate-100 dark:hover:border-orange-400/40 dark:hover:bg-orange-500/10"
                href={GUIDED_EVALUATION_URL}
                rel="noreferrer"
                target="_blank"
              >
                Open guided evaluation
              </a>
              <a
                className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-900 transition hover:border-orange-300 hover:bg-orange-50 dark:border-slate-800 dark:text-slate-100 dark:hover:border-orange-400/40 dark:hover:bg-orange-500/10"
                href={ONBOARDING_PACK_URL}
                rel="noreferrer"
                target="_blank"
              >
                Open onboarding pack
              </a>
              {detailRequest ? (
                <a
                  className="rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-900 transition hover:border-orange-300 hover:bg-orange-50 dark:border-slate-800 dark:text-slate-100 dark:hover:border-orange-400/40 dark:hover:bg-orange-500/10"
                  href={`${ONBOARDING_PACK_URL}${templateAnchorForStage(detailRequest.stage)}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open template for {detailRequest.stage}
                </a>
              ) : null}
            </div>
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

function formatTrustScore(value: number | null): string {
  if (value == null) {
    return 'n/a'
  }

  return `${Math.round(value * 100)}%`
}

function formatAttentionFlag(flag: BetaRequestAttention): string {
  switch (flag) {
    case 'follow_up_due':
      return 'follow-up due'
    case 'unowned':
      return 'unowned'
    case 'stale':
    default:
      return 'stale'
  }
}

function formatActivityKind(kind: BetaRequestActivityEntry['kind']): string {
  switch (kind) {
    case 'request_created':
      return 'Intake'
    case 'stage_changed':
      return 'Stage'
    case 'contact_logged':
      return 'Contact'
    case 'meeting_scheduled':
      return 'Meeting'
    case 'reminder':
      return 'Reminder'
    case 'notification':
      return 'Signal'
    case 'request_updated':
    default:
      return 'Update'
  }
}

function activityToneClasses(tone: BetaRequestActivityEntry['tone']): string {
  switch (tone) {
    case 'success':
      return 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
    case 'warning':
      return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
    case 'default':
    default:
      return 'border-slate-200 bg-white text-slate-900 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100'
  }
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

function futureDateTimeLocalValue(input: { days?: number; hours?: number }): string {
  const days = input.days ?? 0
  const hours = input.hours ?? 0
  return toDateTimeLocalValue(new Date(Date.now() + (days * 24 + hours) * 60 * 60 * 1000).toISOString())
}

function templateAnchorForStage(stage: BetaRequestStatus): string {
  switch (stage) {
    case 'reviewing':
      return '#template-reviewing'
    case 'contacted':
      return '#template-contacted'
    case 'scheduled':
      return '#template-scheduled'
    case 'active':
      return '#template-active'
    case 'closed':
      return '#template-closed'
    case 'new':
    default:
      return '#template-new'
  }
}
