import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import {
  ApiError,
  directoryApi,
  type IntentLifecycleStatus,
  type WorkspaceOverviewAttentionCode,
  type WorkspaceOverviewAttentionItem,
  type WorkspaceOverviewResponse,
  type WorkspaceRecord,
  type WorkspaceStatus,
} from '../lib/api'
import { formatDateTime, formatLatency, formatNumber, formatRelativeTime } from '../lib/utils'

function workspaceStatusTone(status: WorkspaceStatus): 'default' | 'success' | 'warning' {
  switch (status) {
    case 'active':
      return 'success'
    case 'paused':
      return 'warning'
    default:
      return 'default'
  }
}

function handoffStatusTone(status: IntentLifecycleStatus): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'acked':
      return 'success'
    case 'failed':
    case 'dead_letter':
      return 'critical'
    case 'delivered':
    case 'dispatched':
    case 'queued':
    case 'validated':
      return 'warning'
    default:
      return 'default'
  }
}

function attentionTone(code: WorkspaceOverviewAttentionCode): 'default' | 'warning' | 'critical' {
  switch (code) {
    case 'identity_missing':
    case 'workspace_handoffs_disabled':
      return 'critical'
    case 'binding_paused':
    case 'stale_check_in':
    case 'manual_review_required':
      return 'warning'
    default:
      return 'default'
  }
}

function attentionLabel(code: WorkspaceOverviewAttentionCode): string {
  switch (code) {
    case 'identity_missing':
      return 'Missing identity'
    case 'stale_check_in':
      return 'Stale check-in'
    case 'binding_paused':
      return 'Paused'
    case 'workspace_handoffs_disabled':
      return 'Workspace blocked'
    case 'manual_review_required':
      return 'Manual review'
    default:
      return 'Attention'
  }
}

function displayName(label: string | null, beamId: string): string {
  return label || beamId
}

function renderAttentionMeta(item: WorkspaceOverviewAttentionItem): string {
  const parts = [
    item.binding.owner ? `Owner ${item.binding.owner}` : 'No owner',
    item.binding.identity.lastSeen ? `Last seen ${formatRelativeTime(item.binding.identity.lastSeen)}` : 'No heartbeat yet',
  ]

  if (item.lastSeenAgeHours !== null) {
    parts.push(`${Math.round(item.lastSeenAgeHours)}h old`)
  }

  return parts.join(' · ')
}

export default function WorkspacesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [overview, setOverview] = useState<WorkspaceOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedSlug = searchParams.get('workspace') ?? ''
  const selectedWorkspace = useMemo(
    () => workspaces.find((entry) => entry.slug === selectedSlug) ?? workspaces[0] ?? null,
    [selectedSlug, workspaces],
  )

  async function loadWorkspaces() {
    try {
      setLoading(true)
      const response = await directoryApi.listWorkspaces()
      setWorkspaces(response.workspaces)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load Beam workspaces')
    } finally {
      setLoading(false)
    }
  }

  async function loadOverview(slug: string) {
    try {
      setOverviewLoading(true)
      const response = await directoryApi.getWorkspaceOverview(slug)
      setOverview(response)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load workspace overview')
    } finally {
      setOverviewLoading(false)
    }
  }

  useEffect(() => {
    void loadWorkspaces()
  }, [])

  useEffect(() => {
    if (!selectedWorkspace) {
      return
    }

    if (selectedWorkspace.slug !== selectedSlug) {
      const next = new URLSearchParams(searchParams)
      next.set('workspace', selectedWorkspace.slug)
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, selectedSlug, selectedWorkspace, setSearchParams])

  useEffect(() => {
    if (!selectedWorkspace) {
      setOverview(null)
      return
    }

    void loadOverview(selectedWorkspace.slug)
  }, [selectedWorkspace?.slug])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspaces"
        description="Identity home, external handoff controls, and operator attention for Beam workspaces."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {workspaces.length > 0 ? (
              <select
                className="input-field min-w-56"
                value={selectedWorkspace?.slug ?? ''}
                onChange={(event) => {
                  const next = new URLSearchParams(searchParams)
                  next.set('workspace', event.target.value)
                  setSearchParams(next, { replace: true })
                }}
              >
                {workspaces.map((workspace) => (
                  <option key={workspace.slug} value={workspace.slug}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            ) : null}
            <Link className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800" to="/beta-requests">
              Beta requests
            </Link>
            <button
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
              type="button"
              onClick={() => {
                void loadWorkspaces()
                if (selectedWorkspace) {
                  void loadOverview(selectedWorkspace.slug)
                }
              }}
            >
              Refresh
            </button>
          </div>
        )}
      />

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {!loading && workspaces.length === 0 ? (
        <EmptyPanel label="No Beam workspaces exist yet. Create one from the admin API first, then this surface will show identity health and external motion." />
      ) : null}

      {selectedWorkspace ? (
        <>
          <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="Active identities" value={overviewLoading || !overview ? '—' : formatNumber(overview.summary.activeIdentities)} hint={`${overview ? formatNumber(overview.summary.totalIdentities) : '—'} total bound identities`} />
            <MetricCard label="External ready" value={overviewLoading || !overview ? '—' : formatNumber(overview.summary.externalReadyIdentities)} tone={(overview?.summary.externalReadyIdentities ?? 0) > 0 ? 'success' : 'default'} />
            <MetricCard label="Stale identities" value={overviewLoading || !overview ? '—' : formatNumber(overview.summary.staleIdentities)} tone={(overview?.summary.staleIdentities ?? 0) > 0 ? 'warning' : 'default'} />
            <MetricCard label="Manual review" value={overviewLoading || !overview ? '—' : formatNumber(overview.summary.pendingApprovals)} tone={(overview?.summary.pendingApprovals ?? 0) > 0 ? 'warning' : 'default'} />
            <MetricCard label="Blocked motion" value={overviewLoading || !overview ? '—' : formatNumber(overview.summary.blockedExternalMotion)} tone={(overview?.summary.blockedExternalMotion ?? 0) > 0 ? 'critical' : 'default'} />
            <MetricCard label="Recent external handoffs" value={overviewLoading || !overview ? '—' : formatNumber(overview.summary.recentExternalHandoffs)} hint={`Stale after ${overview?.staleAfterHours ?? 24}h`} />
          </section>

          <section className="grid gap-6 xl:grid-cols-[0.78fr,1.22fr]">
            <div className="panel">
              <div className="panel-title">Workspace roster</div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Choose the workspace whose identity surface and outbound readiness you want to inspect.
              </p>
              <div className="mt-4 space-y-3">
                {loading ? (
                  <EmptyPanel label="Loading workspaces…" />
                ) : (
                  workspaces.map((workspace) => {
                    const selected = workspace.slug === selectedWorkspace.slug
                    return (
                      <button
                        key={workspace.slug}
                        type="button"
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                          selected
                            ? 'border-orange-300 bg-orange-50/80 dark:border-orange-500/40 dark:bg-orange-500/10'
                            : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-900'
                        }`}
                        onClick={() => {
                          const next = new URLSearchParams(searchParams)
                          next.set('workspace', workspace.slug)
                          setSearchParams(next, { replace: true })
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{workspace.name}</div>
                            <div className="truncate text-xs text-slate-500 dark:text-slate-400">{workspace.slug}</div>
                          </div>
                          <StatusPill label={workspace.status} tone={workspaceStatusTone(workspace.status)} />
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <div>{formatNumber(workspace.summary.identities)} identities</div>
                          <div>{formatNumber(workspace.summary.externalInitiators)} initiators</div>
                          <div>{formatNumber(workspace.summary.partnerChannels)} partner channels</div>
                          <div>{workspace.externalHandoffsEnabled ? 'External on' : 'External off'}</div>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </div>

            <div className="panel">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="panel-title">{selectedWorkspace.name}</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {selectedWorkspace.description || 'Beam Workspace control plane for identities, internal work, and partner-facing motion.'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusPill label={selectedWorkspace.status} tone={workspaceStatusTone(selectedWorkspace.status)} />
                  <StatusPill
                    label={selectedWorkspace.externalHandoffsEnabled ? 'External handoffs enabled' : 'External handoffs disabled'}
                    tone={selectedWorkspace.externalHandoffsEnabled ? 'success' : 'warning'}
                  />
                  <StatusPill label={selectedWorkspace.policyConfigured ? 'Policy configured' : 'Policy missing'} tone={selectedWorkspace.policyConfigured ? 'success' : 'warning'} />
                </div>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Local identities" value={overviewLoading || !overview ? '—' : formatNumber(overview.summary.localIdentities)} />
                <MetricCard label="Partner identities" value={overviewLoading || !overview ? '—' : formatNumber(overview.summary.partnerIdentities)} />
                <MetricCard label="Workspace members" value={formatNumber(selectedWorkspace.summary.members)} />
                <MetricCard label="Updated" value={formatRelativeTime(selectedWorkspace.updatedAt)} hint={formatDateTime(selectedWorkspace.updatedAt)} />
              </div>

              <div className="mt-5 rounded-2xl border border-slate-200 px-4 py-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                <div className="font-medium text-slate-900 dark:text-slate-100">What this page is telling you</div>
                <div className="mt-1">
                  Beam marks a workspace as risky when identities stop checking in, when outbound motion is paused or still manual,
                  or when recent partner-facing traces are failing. Trace links below jump into the existing intent feed. Beta requests stay the
                  operator surface for partner follow-up and proof-pack motion.
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Stale identities</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Local identities that are missing or have not checked in within {overview?.staleAfterHours ?? 24} hours.
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {overviewLoading || !overview ? (
                  <EmptyPanel label="Loading stale identity signals…" />
                ) : overview.staleBindings.length === 0 ? (
                  <EmptyPanel label="No stale workspace identities right now." />
                ) : (
                  overview.staleBindings.map((item) => (
                    <div key={`${item.binding.id}-${item.reasonCode}`} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {displayName(item.binding.identity.displayName, item.binding.beamId)}
                          </div>
                          <div className="truncate text-xs text-slate-500 dark:text-slate-400">{item.binding.beamId}</div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <StatusPill label={attentionLabel(item.reasonCode)} tone={attentionTone(item.reasonCode)} />
                          <StatusPill label={item.binding.bindingType} />
                        </div>
                      </div>
                      <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">{item.reason}</div>
                      <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{renderAttentionMeta(item)}</div>
                      {item.binding.identity.existsLocally ? (
                        <div className="mt-3">
                          <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/agents/${encodeURIComponent(item.binding.beamId)}`}>
                            Open agent profile
                          </Link>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Blocked external motion</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Identities that cannot currently start partner-facing work from this workspace.
                  </p>
                </div>
                <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to="/beta-requests">
                  Open beta requests
                </Link>
              </div>
              <div className="mt-4 space-y-3">
                {overviewLoading || !overview ? (
                  <EmptyPanel label="Loading blocked motion…" />
                ) : overview.blockedExternalMotion.length === 0 ? (
                  <EmptyPanel label="No outbound blockers are registered for this workspace." />
                ) : (
                  overview.blockedExternalMotion.map((item) => (
                    <div key={`${item.binding.id}-${item.reasonCode}`} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {displayName(item.binding.identity.displayName, item.binding.beamId)}
                          </div>
                          <div className="truncate text-xs text-slate-500 dark:text-slate-400">{item.binding.beamId}</div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <StatusPill label={attentionLabel(item.reasonCode)} tone={attentionTone(item.reasonCode)} />
                          <StatusPill label={item.binding.status} tone={item.binding.status === 'paused' ? 'warning' : 'default'} />
                        </div>
                      </div>
                      <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">{item.reason}</div>
                      <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{renderAttentionMeta(item)}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="panel-title">Recent external handoffs</div>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  The latest partner-facing or outside-in traces touching this workspace. Use these links to jump straight into the intent feed.
                </p>
              </div>
              <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to="/intents">
                Open intent feed
              </Link>
            </div>
            <div className="mt-4 space-y-3">
              {overviewLoading || !overview ? (
                <EmptyPanel label="Loading external handoffs…" />
              ) : overview.recentExternalHandoffs.length === 0 ? (
                <EmptyPanel label="No external handoffs were recorded for this workspace yet." />
              ) : (
                overview.recentExternalHandoffs.map((handoff) => (
                  <div key={handoff.nonce} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">
                          {displayName(handoff.workspaceSide.displayName, handoff.workspaceSide.beamId)}
                          <span className="mx-2 text-slate-400">→</span>
                          {displayName(handoff.counterparty.displayName, handoff.counterparty.beamId)}
                        </div>
                        <div className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
                          {handoff.fromBeamId} → {handoff.toBeamId}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <StatusPill label={handoff.direction} tone={handoff.direction === 'outbound' ? 'success' : 'warning'} />
                        <StatusPill label={handoff.status} tone={handoffStatusTone(handoff.status)} />
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 text-sm text-slate-600 dark:text-slate-300 md:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400">Intent</div>
                        <div>{handoff.intentType}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400">Requested</div>
                        <div>{formatRelativeTime(handoff.requestedAt)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400">Latency</div>
                        <div>{formatLatency(handoff.latencyMs)}</div>
                      </div>
                      <div>
                        <div className="text-xs uppercase tracking-wide text-slate-400">Counterparty</div>
                        <div>{handoff.counterparty.inWorkspace ? 'Bound partner identity' : 'Outside workspace'}</div>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                      <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/intents/${encodeURIComponent(handoff.nonce)}`}>
                        Open trace
                      </Link>
                      {handoff.errorCode ? <span className="text-red-600 dark:text-red-300">{handoff.errorCode}</span> : null}
                      <span className="text-slate-500 dark:text-slate-400">{formatDateTime(handoff.requestedAt)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}
