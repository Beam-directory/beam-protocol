import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, directoryApi, type FunnelAnalyticsResponse } from '../lib/api'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import { formatDateTime, formatNumber, formatPercent, formatRelativeTime } from '../lib/utils'

const WINDOW_OPTIONS = [7, 14, 30, 90]

export default function FunnelPage() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<FunnelAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load(currentDays: number) {
    try {
      setLoading(true)
      const response = await directoryApi.getFunnelAnalytics(currentDays)
      setData(response)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load funnel analytics')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(days)
  }, [days])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Funnel"
        description="First-party buyer funnel analytics plus operator-side design-partner motion, stalls, and overdue follow-up."
        actions={(
          <select className="input-field w-auto min-w-28" value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {WINDOW_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}d
              </option>
            ))}
          </select>
        )}
      />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <section className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-950/80 dark:text-slate-300">
        <div className="font-medium text-slate-900 dark:text-slate-100">What this measures</div>
        <div className="mt-1">
          Beam records only first-party funnel events with an anonymous session id. No third-party scripts, no ad profiling,
          and no form contents are stored here. The goal is simple: see whether people move from landing to pilot request and proof.
        </div>
        <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Generated {formatDateTime(data?.generatedAt)} for the last {days} days.
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Anonymous sessions" value={loading ? '—' : formatNumber(data?.summary.anonymousSessions ?? 0)} />
        <MetricCard label="Landing sessions" value={loading ? '—' : formatNumber(data?.summary.landingSessions ?? 0)} />
        <MetricCard label="Guided eval" value={loading ? '—' : formatNumber(data?.summary.guidedSessions ?? 0)} tone={(data?.summary.guidedSessions ?? 0) > 0 ? 'success' : 'default'} />
        <MetricCard label="Hosted beta views" value={loading ? '—' : formatNumber(data?.summary.hostedBetaSessions ?? 0)} />
        <MetricCard label="Requests" value={loading ? '—' : formatNumber(data?.summary.requestSessions ?? 0)} tone={(data?.summary.requestSessions ?? 0) > 0 ? 'warning' : 'default'} />
        <MetricCard label="Demo proof" value={loading ? '—' : formatNumber(data?.summary.demoSessions ?? 0)} tone={(data?.summary.demoSessions ?? 0) > 0 ? 'success' : 'default'} />
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard label="Landing → guided eval" value={formatPercent(data?.summary.landingToGuidedRate ?? null, 0)} hint="Unique-session conversion from landing view to guided evaluation." />
        <MetricCard label="Landing → request" value={formatPercent(data?.summary.landingToRequestRate ?? null, 0)} hint="Unique-session conversion from landing view to hosted-beta request." />
        <MetricCard label="Request → demo proof" value={formatPercent(data?.summary.requestToDemoRate ?? null, 0)} hint="How many request sessions also reached a demo milestone in the same window." />
      </section>

      <section className="space-y-4">
        <div className="panel">
          <div className="panel-title">Design partner motion</div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            This is the operator-side weekly read: how many hosted beta requests qualify, get scheduled, complete a pilot, and still have a named next step.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-8">
          <MetricCard label="Requests" value={loading ? '—' : formatNumber(data?.partnerMotion.summary.requests ?? 0)} />
          <MetricCard label="Qualified" value={loading ? '—' : formatNumber(data?.partnerMotion.summary.qualified ?? 0)} tone={(data?.partnerMotion.summary.qualified ?? 0) > 0 ? 'success' : 'default'} />
          <MetricCard label="Scheduled" value={loading ? '—' : formatNumber(data?.partnerMotion.summary.scheduled ?? 0)} tone={(data?.partnerMotion.summary.scheduled ?? 0) > 0 ? 'success' : 'default'} />
          <MetricCard label="Pilot complete" value={loading ? '—' : formatNumber(data?.partnerMotion.summary.pilotComplete ?? 0)} tone={(data?.partnerMotion.summary.pilotComplete ?? 0) > 0 ? 'success' : 'default'} />
          <MetricCard label="Next step ready" value={loading ? '—' : formatNumber(data?.partnerMotion.summary.nextStepReady ?? 0)} tone={(data?.partnerMotion.summary.nextStepReady ?? 0) > 0 ? 'warning' : 'default'} />
          <MetricCard label="Overdue follow-up" value={loading ? '—' : formatNumber(data?.partnerMotion.summary.overdueFollowUps ?? 0)} tone={(data?.partnerMotion.summary.overdueFollowUps ?? 0) > 0 ? 'critical' : 'default'} />
          <MetricCard label="Stalled" value={loading ? '—' : formatNumber(data?.partnerMotion.summary.stalledRequests ?? 0)} tone={(data?.partnerMotion.summary.stalledRequests ?? 0) > 0 ? 'critical' : 'default'} />
          <MetricCard label="Unowned" value={loading ? '—' : formatNumber(data?.partnerMotion.summary.unowned ?? 0)} tone={(data?.partnerMotion.summary.unowned ?? 0) > 0 ? 'critical' : 'default'} />
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Qualify rate" value={formatPercent(data?.partnerMotion.summary.qualificationRate ?? null, 0)} hint="Requests in the current window that moved beyond the raw intake stage." />
          <MetricCard label="Schedule rate" value={formatPercent(data?.partnerMotion.summary.schedulingRate ?? null, 0)} hint="Requests with a scheduled working session or a later stage." />
          <MetricCard label="Pilot-complete rate" value={formatPercent(data?.partnerMotion.summary.pilotCompleteRate ?? null, 0)} hint="Requests that closed or already have a linked proof trace." />
          <MetricCard label="Next-step rate" value={formatPercent(data?.partnerMotion.summary.nextStepRate ?? null, 0)} hint="Requests with a concrete next action, meeting, or reminder." />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
        <div className="panel overflow-hidden p-0">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <div className="panel-title">Stage aging</div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Where requests accumulate time, overdue follow-up, or unowned work.</p>
          </div>
          {loading ? (
            <div className="p-5">
              <EmptyPanel label="Loading design-partner stage metrics…" />
            </div>
          ) : !data || data.partnerMotion.byStage.length === 0 ? (
            <div className="p-5">
              <EmptyPanel label="No hosted beta requests were created in the selected window." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-950">
                  <tr>
                    <th className="table-head">Stage</th>
                    <th className="table-head">Count</th>
                    <th className="table-head">Avg age</th>
                    <th className="table-head">Oldest</th>
                    <th className="table-head">Overdue</th>
                    <th className="table-head">Stale</th>
                    <th className="table-head">Unowned</th>
                    <th className="table-head">Proof linked</th>
                  </tr>
                </thead>
                <tbody>
                  {data.partnerMotion.byStage.map((entry) => (
                    <tr key={entry.stage} className="border-t border-slate-200 dark:border-slate-800">
                      <td className="table-cell">{formatPartnerStage(entry.stage)}</td>
                      <td className="table-cell">{formatNumber(entry.count)}</td>
                      <td className="table-cell">{entry.averageAgeHours == null ? '—' : `${entry.averageAgeHours}h`}</td>
                      <td className="table-cell">{entry.oldestAgeHours == null ? '—' : `${entry.oldestAgeHours}h`}</td>
                      <td className="table-cell">{formatNumber(entry.followUpDue)}</td>
                      <td className="table-cell">{formatNumber(entry.stale)}</td>
                      <td className="table-cell">{formatNumber(entry.unowned)}</td>
                      <td className="table-cell">{formatNumber(entry.proofLinked)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">Current stalls</div>
          <div className="mt-4 space-y-3">
            {loading ? (
              <EmptyPanel label="Loading stalled requests…" />
            ) : !data || data.partnerMotion.stalled.length === 0 ? (
              <EmptyPanel label="No stalled or overdue requests were detected in the selected window." />
            ) : (
              data.partnerMotion.stalled.map((entry) => (
                <div key={entry.id} className="rounded-xl border border-slate-200 px-4 py-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{entry.company ?? entry.email}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{entry.email}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <StatusPill label={entry.stage} tone={entry.followUpDue || entry.stale ? 'warning' : 'default'} />
                      {entry.attentionFlags.map((flag) => (
                        <StatusPill key={`${entry.id}-${flag}`} label={formatAttention(flag)} tone={flag === 'unowned' ? 'critical' : 'warning'} />
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2">
                    <span>Owner: {entry.owner ?? 'unassigned'}</span>
                    <span>Stage age: {entry.stageAgeLabel}</span>
                    <span>Last contact: {entry.lastContactAt ? formatRelativeTime(entry.lastContactAt) : 'not recorded'}</span>
                    <span>Next meeting: {entry.nextMeetingAt ? formatRelativeTime(entry.nextMeetingAt) : 'not scheduled'}</span>
                  </div>
                  <div className="mt-3 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">
                    {entry.followUpReason ?? entry.staleReason ?? entry.nextAction ?? 'No next action is recorded yet.'}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/beta-requests?id=${entry.id}`}>
                      Open request
                    </Link>
                    {entry.proofIntentNonce ? (
                      <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/intents/${encodeURIComponent(entry.proofIntentNonce)}`}>
                        Open proof trace
                      </Link>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr,1fr]">
        <div className="panel">
          <div className="panel-title">Weekly partner motion</div>
          <div className="mt-4 space-y-3">
            {loading ? (
              <EmptyPanel label="Loading weekly partner motion…" />
            ) : !data || data.partnerMotion.weekly.length === 0 ? (
              <EmptyPanel label="No hosted beta requests were created in the selected window." />
            ) : (
              data.partnerMotion.weekly.map((entry) => (
                <div key={entry.weekStart} className="rounded-xl border border-slate-200 px-4 py-4 text-sm dark:border-slate-800">
                  <div className="flex items-center justify-between gap-4">
                    <div className="font-medium text-slate-900 dark:text-slate-100">Week of {entry.weekStart}</div>
                    <div className="text-slate-500 dark:text-slate-400">{formatNumber(entry.requests)} requests</div>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2">
                    <span>Qualified: {formatNumber(entry.qualified)}</span>
                    <span>Scheduled: {formatNumber(entry.scheduled)}</span>
                    <span>Pilot complete: {formatNumber(entry.pilotComplete)}</span>
                    <span>Next step ready: {formatNumber(entry.nextStepReady)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Workflow stall breakdown</div>
          <div className="mt-4 space-y-3">
            {loading ? (
              <EmptyPanel label="Loading workflow breakdown…" />
            ) : !data || data.partnerMotion.workflows.length === 0 ? (
              <EmptyPanel label="No hosted beta workflow data was recorded." />
            ) : (
              data.partnerMotion.workflows.map((entry) => (
                <div key={entry.workflowType} className="rounded-xl border border-slate-200 px-4 py-4 text-sm dark:border-slate-800">
                  <div className="flex items-center justify-between gap-4">
                    <div className="font-medium text-slate-900 dark:text-slate-100">{entry.workflowType}</div>
                    <StatusPill label={`${entry.overdue} overdue`} tone={entry.overdue > 0 ? 'warning' : 'default'} />
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2">
                    <span>Requests: {formatNumber(entry.requests)}</span>
                    <span>Qualified: {formatNumber(entry.qualified)}</span>
                    <span>Scheduled: {formatNumber(entry.scheduled)}</span>
                    <span>Pilot complete: {formatNumber(entry.pilotComplete)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel overflow-hidden p-0">
          <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
            <div className="panel-title">Milestone progression</div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">This is the go or no-go read for the public funnel.</p>
          </div>

          {loading ? (
            <div className="p-5">
              <EmptyPanel label="Loading funnel milestones…" />
            </div>
          ) : !data || data.milestones.length === 0 ? (
            <div className="p-5">
              <EmptyPanel label="No funnel milestones were recorded in the selected window." />
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {data.milestones.map((milestone) => (
                <div key={milestone.key} className="px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{milestone.label}</div>
                      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{milestone.events} event(s)</div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">{formatNumber(milestone.sessions)}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">unique sessions</div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <StatusPill label={`from previous ${formatPercent(milestone.conversionFromPrevious ?? null, 0)}`} tone="default" />
                    <StatusPill label={`from landing ${formatPercent(milestone.conversionFromLanding ?? null, 0)}`} tone="warning" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="panel">
            <div className="panel-title">Top entry pages</div>
            <div className="mt-4 space-y-3">
              {loading ? (
                <EmptyPanel label="Loading entry pages…" />
              ) : !data || data.entryPages.length === 0 ? (
                <EmptyPanel label="No page-view data was recorded." />
              ) : (
                data.entryPages.slice(0, 6).map((entry) => (
                  <div key={entry.pageKey} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-3 py-3 text-sm dark:border-slate-800">
                    <div className="font-medium text-slate-900 dark:text-slate-100">{entry.pageKey}</div>
                    <div className="text-right text-slate-500 dark:text-slate-400">
                      <div>{formatNumber(entry.sessions)} sessions</div>
                      <div>{formatNumber(entry.events)} views</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">CTA clicks</div>
            <div className="mt-4 space-y-3">
              {loading ? (
                <EmptyPanel label="Loading CTA clicks…" />
              ) : !data || data.ctaClicks.length === 0 ? (
                <EmptyPanel label="No tracked CTA clicks were recorded." />
              ) : (
                data.ctaClicks.slice(0, 8).map((entry) => (
                  <div key={entry.ctaKey} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-3 py-3 text-sm dark:border-slate-800">
                    <div>
                      <div className="font-medium text-slate-900 dark:text-slate-100">{entry.ctaKey}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">target {entry.targetPage ?? '—'}</div>
                    </div>
                    <div className="text-right text-slate-500 dark:text-slate-400">
                      <div>{formatNumber(entry.sessions)} sessions</div>
                      <div>{formatNumber(entry.events)} clicks</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr,1fr]">
        <div className="panel">
          <div className="panel-title">Demo milestones</div>
          <div className="mt-4 space-y-3">
            {loading ? (
              <EmptyPanel label="Loading demo milestones…" />
            ) : !data || data.demoMilestones.length === 0 ? (
              <EmptyPanel label="No demo milestones were recorded." />
            ) : (
              data.demoMilestones.map((entry) => (
                <div key={entry.milestoneKey} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-3 py-3 text-sm dark:border-slate-800">
                  <div className="font-medium text-slate-900 dark:text-slate-100">{entry.milestoneKey}</div>
                  <div className="text-right text-slate-500 dark:text-slate-400">
                    <div>{formatNumber(entry.sessions)} sessions</div>
                    <div>{formatNumber(entry.events)} events</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Request workflows</div>
          <div className="mt-4 space-y-3">
            {loading ? (
              <EmptyPanel label="Loading request workflows…" />
            ) : !data || data.workflows.length === 0 ? (
              <EmptyPanel label="No hosted-beta requests were recorded." />
            ) : (
              data.workflows.map((entry) => (
                <div key={entry.workflowType} className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 px-3 py-3 text-sm dark:border-slate-800">
                  <div className="font-medium text-slate-900 dark:text-slate-100">{entry.workflowType}</div>
                  <div className="text-right text-slate-500 dark:text-slate-400">
                    <div>{formatNumber(entry.sessions)} sessions</div>
                    <div>{formatNumber(entry.events)} requests</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="panel overflow-hidden p-0">
        <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="panel-title">Recent tracked events</div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Anonymous only. Useful for validating that the public surfaces are instrumented correctly.</p>
        </div>
        {loading ? (
          <div className="p-5">
            <EmptyPanel label="Loading recent events…" />
          </div>
        ) : !data || data.recentEvents.length === 0 ? (
          <div className="p-5">
            <EmptyPanel label="No recent events were recorded." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-950">
                <tr>
                  <th className="table-head">Time</th>
                  <th className="table-head">Page</th>
                  <th className="table-head">Category</th>
                  <th className="table-head">Key</th>
                  <th className="table-head">Origin</th>
                </tr>
              </thead>
              <tbody>
                {data.recentEvents.map((entry) => (
                  <tr key={entry.id} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="table-cell">{formatDateTime(entry.createdAt)}</td>
                    <td className="table-cell">{entry.pageKey}</td>
                    <td className="table-cell">{entry.eventCategory}</td>
                    <td className="table-cell">{entry.ctaKey ?? entry.milestoneKey ?? entry.workflowType ?? 'page_view'}</td>
                    <td className="table-cell">{entry.origin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function formatPartnerStage(stage: string): string {
  return stage
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatAttention(flag: string): string {
  switch (flag) {
    case 'follow_up_due':
      return 'follow-up due'
    case 'unowned':
      return 'unowned'
    case 'stale':
      return 'stale'
    default:
      return flag
  }
}
