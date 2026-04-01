import { ArrowUpRight, Copy, Download, Mail, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import {
  ApiError,
  directoryApi,
  type PartnerDigestResponse,
  type PartnerHealthIncident,
  type PartnerHealthRequest,
  type PartnerHealthResponse,
} from '../lib/api'
import { downloadBlob, formatDateTime, formatLatency, formatNumber, formatRelativeTime } from '../lib/utils'

const WINDOW_OPTIONS = [7, 30, 90]

function getHealthTone(status: PartnerHealthRequest['healthStatus']): 'default' | 'warning' | 'critical' | 'success' {
  switch (status) {
    case 'healthy':
      return 'success'
    case 'watch':
      return 'warning'
    case 'critical':
      return 'critical'
    default:
      return 'default'
  }
}

function getIncidentTone(incident: PartnerHealthIncident): 'warning' | 'critical' {
  return incident.severity === 'critical' ? 'critical' : 'warning'
}

export default function PartnerOpsPage() {
  const [days, setDays] = useState(30)
  const [health, setHealth] = useState<PartnerHealthResponse | null>(null)
  const [digest, setDigest] = useState<PartnerDigestResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function load(currentDays = days) {
    try {
      setLoading(true)
      const [healthResponse, digestResponse] = await Promise.all([
        directoryApi.getPartnerHealth({ days: currentDays, hours: 24 }),
        directoryApi.getPartnerDigest({ days: Math.min(currentDays, 14) }),
      ])
      setHealth(healthResponse)
      setDigest(digestResponse)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load partner operations view')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(days)
  }, [days])

  async function copyDigest() {
    if (!digest) {
      return
    }

    try {
      await navigator.clipboard.writeText(digest.markdown)
      setNotice('Partner digest copied.')
      setError(null)
    } catch {
      setError('Failed to copy partner digest.')
    }
  }

  async function downloadDigest() {
    try {
      const download = await directoryApi.downloadPartnerDigest({ days: Math.min(days, 14) })
      downloadBlob(download.blob, download.filename)
      setNotice('Partner digest exported.')
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to export partner digest')
    }
  }

  async function emailDigest() {
    try {
      const response = await directoryApi.deliverPartnerDigest({ days: Math.min(days, 14) })
      setNotice(`Partner digest sent to ${response.email}.`)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to deliver partner digest')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partner Ops"
        description="Daily operating view for the first production-partner workflow: health, breach risk, incidents, and follow-through."
        actions={(
          <div className="flex flex-wrap gap-2">
            <select className="input-field w-auto min-w-24" value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {WINDOW_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}d
                </option>
              ))}
            </select>
            <button className="btn-secondary" onClick={() => void load(days)} type="button">
              <RefreshCw size={16} />
              <span>Refresh</span>
            </button>
            <button className="btn-secondary" onClick={() => void copyDigest()} type="button" disabled={!digest}>
              <Copy size={16} />
              <span>Copy digest</span>
            </button>
            <button className="btn-secondary" onClick={() => void downloadDigest()} type="button">
              <Download size={16} />
              <span>Export digest</span>
            </button>
            <button className="btn-secondary" onClick={() => void emailDigest()} type="button">
              <Mail size={16} />
              <span>Email digest</span>
            </button>
          </div>
        )}
      />

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

      <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Active partner threads" value={loading ? '—' : formatNumber(health?.summary.activeRequests ?? 0)} />
        <MetricCard label="Critical" value={loading ? '—' : formatNumber(health?.summary.critical ?? 0)} tone={(health?.summary.critical ?? 0) > 0 ? 'critical' : 'success'} />
        <MetricCard label="Watch" value={loading ? '—' : formatNumber(health?.summary.watch ?? 0)} tone={(health?.summary.watch ?? 0) > 0 ? 'warning' : 'success'} />
        <MetricCard label="Follow-up due" value={loading ? '—' : formatNumber(health?.summary.followUpDue ?? 0)} tone={(health?.summary.followUpDue ?? 0) > 0 ? 'warning' : 'default'} />
        <MetricCard label="Dead letters" value={loading ? '—' : formatNumber(health?.summary.deadLetters ?? 0)} tone={(health?.summary.deadLetters ?? 0) > 0 ? 'critical' : 'default'} />
        <MetricCard label={`Latency > ${health?.slaLatencyMs ?? 5000}ms`} value={loading ? '—' : formatNumber(health?.summary.latencyBreaches ?? 0)} tone={(health?.summary.latencyBreaches ?? 0) > 0 ? 'warning' : 'default'} />
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel overflow-hidden p-0">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <div className="panel-title">Workflow health</div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Operator view by workflow instead of by raw request count.
            </p>
          </div>
          {!health || health.workflows.length === 0 ? (
            <div className="p-5">
              <EmptyPanel label={loading ? 'Loading workflow health…' : 'No partner workflows were found in the selected window.'} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-950">
                  <tr>
                    <th className="table-head">Workflow</th>
                    <th className="table-head">Requests</th>
                    <th className="table-head">Critical</th>
                    <th className="table-head">Watch</th>
                    <th className="table-head">Follow-up due</th>
                    <th className="table-head">Dead letters</th>
                    <th className="table-head">Avg latency</th>
                  </tr>
                </thead>
                <tbody>
                  {health.workflows.map((entry) => (
                    <tr key={entry.workflowType} className="border-t border-slate-200 dark:border-slate-800">
                      <td className="table-cell">{entry.label}</td>
                      <td className="table-cell">{formatNumber(entry.requests)}</td>
                      <td className="table-cell">{formatNumber(entry.critical)}</td>
                      <td className="table-cell">{formatNumber(entry.watch)}</td>
                      <td className="table-cell">{formatNumber(entry.followUpDue)}</td>
                      <td className="table-cell">{formatNumber(entry.deadLetters)}</td>
                      <td className="table-cell">{formatLatency(entry.averageLatencyMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel overflow-hidden p-0">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <div className="panel-title">Owner load</div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Who owns the threads, where follow-up is due, and who still has open risk.
            </p>
          </div>
          {!health || health.owners.length === 0 ? (
            <div className="p-5">
              <EmptyPanel label={loading ? 'Loading owner health…' : 'No owner data is available yet.'} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-950">
                  <tr>
                    <th className="table-head">Owner</th>
                    <th className="table-head">Requests</th>
                    <th className="table-head">Critical</th>
                    <th className="table-head">Watch</th>
                    <th className="table-head">Follow-up due</th>
                    <th className="table-head">Meetings</th>
                  </tr>
                </thead>
                <tbody>
                  {health.owners.map((entry) => (
                    <tr key={entry.owner ?? 'unassigned'} className="border-t border-slate-200 dark:border-slate-800">
                      <td className="table-cell">{entry.owner ?? 'unassigned'}</td>
                      <td className="table-cell">{formatNumber(entry.requests)}</td>
                      <td className="table-cell">{formatNumber(entry.critical)}</td>
                      <td className="table-cell">{formatNumber(entry.watch)}</td>
                      <td className="table-cell">{formatNumber(entry.followUpDue)}</td>
                      <td className="table-cell">{formatNumber(entry.nextMeetingScheduled)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel">
          <div className="panel-title">Incident-worthy signals</div>
          <div className="mt-4 space-y-3">
            {!health || health.incidents.length === 0 ? (
              <EmptyPanel label={loading ? 'Loading incident signals…' : 'No partner incidents need review right now.'} />
            ) : (
              health.incidents.map((incident) => (
                <div key={incident.id} className="rounded-xl border border-slate-200 px-4 py-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{incident.company ?? `Request #${incident.requestId}`}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{incident.workflowType ?? 'workflow not set'}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <StatusPill label={incident.title} tone={getIncidentTone(incident)} />
                      {incident.deadLetter ? <StatusPill label="dead letter" tone="critical" /> : null}
                      {incident.followUpDue ? <StatusPill label="follow-up due" tone="warning" /> : null}
                    </div>
                  </div>
                  <div className="mt-3 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                    {incident.detail}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={incident.requestHref}>
                      Open partner record
                    </Link>
                    {incident.alertHref ? (
                      <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={incident.alertHref}>
                        Open alert context
                      </Link>
                    ) : null}
                    {incident.traceHref ? (
                      <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={incident.traceHref}>
                        Open trace
                      </Link>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Weekly digest preview</div>
          {!digest ? (
            <div className="mt-4">
              <EmptyPanel label={loading ? 'Loading digest preview…' : 'No digest data is available yet.'} />
            </div>
          ) : (
            <>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <MetricCard label="Owned threads" value={String(digest.summary.ownedThreads)} />
                <MetricCard label="Due now" value={String(digest.summary.dueNow)} tone={digest.summary.dueNow > 0 ? 'warning' : 'default'} />
                <MetricCard label="Meetings this week" value={String(digest.summary.meetingsThisWeek)} />
                <MetricCard label="Unowned" value={String(digest.summary.unownedThreads)} tone={digest.summary.unownedThreads > 0 ? 'critical' : 'default'} />
              </div>
              <div className="mt-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Digest markdown</div>
                <pre className="mt-3 max-h-[24rem] overflow-auto whitespace-pre-wrap text-xs leading-6 text-slate-600 dark:text-slate-300">
                  {digest.markdown}
                </pre>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="panel overflow-hidden p-0">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="panel-title">Partner follow-up queue</div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Owned threads with last contact, next action, reminder timing, meeting state, and direct jumps into the request or proof trace.
          </p>
        </div>
        {!health || health.requests.length === 0 ? (
          <div className="p-5">
            <EmptyPanel label={loading ? 'Loading partner follow-up queue…' : 'No partner requests are available yet.'} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-950">
                <tr>
                  <th className="table-head">Partner</th>
                  <th className="table-head">Health</th>
                  <th className="table-head">Owner</th>
                  <th className="table-head">Last contact</th>
                  <th className="table-head">Next meeting</th>
                  <th className="table-head">Latest proof</th>
                  <th className="table-head">Next action</th>
                  <th className="table-head">Links</th>
                </tr>
              </thead>
              <tbody>
                {health.requests.map((request) => (
                  <tr key={request.id} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="table-cell">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{request.company ?? request.email}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{request.workflowTypeLabel}</div>
                    </td>
                    <td className="table-cell">
                      <div className="flex flex-wrap gap-2">
                        <StatusPill label={request.healthStatus} tone={getHealthTone(request.healthStatus)} />
                        <StatusPill label={request.stage} tone={request.stage === 'closed' ? 'success' : request.followUpDue ? 'warning' : 'default'} />
                      </div>
                    </td>
                    <td className="table-cell">{request.owner ?? 'unassigned'}</td>
                    <td className="table-cell">
                      <div>{request.lastContactAt ? formatRelativeTime(request.lastContactAt) : 'not recorded'}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{formatDateTime(request.lastContactAt)}</div>
                    </td>
                    <td className="table-cell">
                      <div>{request.nextMeetingAt ? formatRelativeTime(request.nextMeetingAt) : 'not scheduled'}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{formatDateTime(request.nextMeetingAt)}</div>
                    </td>
                    <td className="table-cell">
                      <div>{request.latestIntentStatus ?? 'not linked'}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {request.latestLatencyMs == null ? 'n/a' : formatLatency(request.latestLatencyMs)}
                      </div>
                    </td>
                    <td className="table-cell">
                      <div className="max-w-xs text-sm text-slate-700 dark:text-slate-200">{request.nextAction ?? 'No next action recorded.'}</div>
                      {request.followUpReason || request.staleReason ? (
                        <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                          {request.followUpReason ?? request.staleReason}
                        </div>
                      ) : null}
                    </td>
                    <td className="table-cell">
                      <div className="flex flex-wrap gap-2">
                        <Link className="inline-flex items-center gap-1 text-orange-600 hover:text-orange-700 dark:text-orange-300" to={request.links.requestHref}>
                          <span>Record</span>
                          <ArrowUpRight size={14} />
                        </Link>
                        {request.links.traceHref ? (
                          <Link className="inline-flex items-center gap-1 text-orange-600 hover:text-orange-700 dark:text-orange-300" to={request.links.traceHref}>
                            <span>Trace</span>
                            <ArrowUpRight size={14} />
                          </Link>
                        ) : null}
                        {request.links.alertHref ? (
                          <Link className="inline-flex items-center gap-1 text-orange-600 hover:text-orange-700 dark:text-orange-300" to={request.links.alertHref}>
                            <span>Alert</span>
                            <ArrowUpRight size={14} />
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {health ? (
        <section className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-950/80 dark:text-slate-300">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 shrink-0 text-orange-500" size={18} />
            <div>
              <div className="font-medium text-slate-900 dark:text-slate-100">What this page is for</div>
              <div className="mt-1">
                This page is the daily production read for one external partner workflow. The goal is not deep investigation first.
                The goal is to show which partner thread is at risk, who owns it, whether the latest proof trace is healthy, and what has to happen next.
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}
