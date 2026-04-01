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
  type WorkspacePolicyPreview,
  type WorkspacePolicyResponse,
  type WorkspaceRecord,
  type WorkspaceStatus,
  type WorkspaceThread,
  type WorkspaceThreadDetailResponse,
  type WorkspaceThreadStatus,
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

function threadStatusTone(status: WorkspaceThreadStatus): 'default' | 'success' | 'warning' {
  switch (status) {
    case 'closed':
      return 'success'
    case 'blocked':
      return 'warning'
    default:
      return 'default'
  }
}

function displayName(label: string | null, beamId: string): string {
  return label || beamId
}

function summarizeList(values: string[], fallback: string): string {
  return values.length > 0 ? values.join(', ') : fallback
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

function renderPolicyMeta(preview: WorkspacePolicyPreview): string {
  const parts = [
    preview.policyProfile ? `Profile ${preview.policyProfile}` : 'No policy profile',
    preview.matchedBindingRules > 0 ? `${preview.matchedBindingRules} binding rule${preview.matchedBindingRules === 1 ? '' : 's'}` : 'Binding defaults only',
  ]

  if (preview.matchedWorkflowRules > 0) {
    parts.push(`${preview.matchedWorkflowRules} workflow rule${preview.matchedWorkflowRules === 1 ? '' : 's'}`)
  }

  return parts.join(' · ')
}

export default function WorkspacesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [overview, setOverview] = useState<WorkspaceOverviewResponse | null>(null)
  const [threads, setThreads] = useState<WorkspaceThread[]>([])
  const [threadDetail, setThreadDetail] = useState<WorkspaceThreadDetailResponse | null>(null)
  const [policy, setPolicy] = useState<WorkspacePolicyResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [threadsLoading, setThreadsLoading] = useState(false)
  const [threadDetailLoading, setThreadDetailLoading] = useState(false)
  const [policyLoading, setPolicyLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedSlug = searchParams.get('workspace') ?? ''
  const selectedThreadId = useMemo(() => {
    const raw = searchParams.get('thread')
    if (!raw) {
      return null
    }

    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [searchParams])

  const selectedWorkspace = useMemo(
    () => workspaces.find((entry) => entry.slug === selectedSlug) ?? workspaces[0] ?? null,
    [selectedSlug, workspaces],
  )

  const selectedThread = useMemo(
    () => threads.find((entry) => entry.id === selectedThreadId) ?? threads[0] ?? null,
    [selectedThreadId, threads],
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

  async function loadThreads(slug: string) {
    try {
      setThreadsLoading(true)
      const response = await directoryApi.listWorkspaceThreads(slug)
      setThreads(response.threads)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load workspace threads')
    } finally {
      setThreadsLoading(false)
    }
  }

  async function loadThreadDetail(slug: string, threadId: number) {
    try {
      setThreadDetailLoading(true)
      const response = await directoryApi.getWorkspaceThread(slug, threadId)
      setThreadDetail(response)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load workspace thread detail')
    } finally {
      setThreadDetailLoading(false)
    }
  }

  async function loadPolicy(slug: string) {
    try {
      setPolicyLoading(true)
      const response = await directoryApi.getWorkspacePolicy(slug)
      setPolicy(response)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load workspace policy')
    } finally {
      setPolicyLoading(false)
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
      setThreads([])
      setThreadDetail(null)
      setPolicy(null)
      return
    }

    void loadOverview(selectedWorkspace.slug)
    void loadThreads(selectedWorkspace.slug)
    void loadPolicy(selectedWorkspace.slug)
  }, [selectedWorkspace?.slug])

  useEffect(() => {
    if (!selectedWorkspace) {
      return
    }

    const current = searchParams.get('thread')
    const next = new URLSearchParams(searchParams)
    if (selectedThread) {
      if (current !== String(selectedThread.id)) {
        next.set('thread', String(selectedThread.id))
        setSearchParams(next, { replace: true })
      }
      return
    }

    if (current) {
      next.delete('thread')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, selectedThread, selectedWorkspace, setSearchParams])

  useEffect(() => {
    if (!selectedWorkspace || !selectedThread) {
      setThreadDetail(null)
      return
    }

    void loadThreadDetail(selectedWorkspace.slug, selectedThread.id)
  }, [selectedWorkspace?.slug, selectedThread?.id])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspaces"
        description="Identity home, external handoff controls, thread timelines, and operator policy previews for Beam workspaces."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {workspaces.length > 0 ? (
              <select
                className="input-field min-w-56"
                value={selectedWorkspace?.slug ?? ''}
                onChange={(event) => {
                  const next = new URLSearchParams(searchParams)
                  next.set('workspace', event.target.value)
                  next.delete('thread')
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
                  void loadThreads(selectedWorkspace.slug)
                  void loadPolicy(selectedWorkspace.slug)
                  if (selectedThread) {
                    void loadThreadDetail(selectedWorkspace.slug, selectedThread.id)
                  }
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
        <EmptyPanel label="No Beam workspaces exist yet. Create one from the admin API first, then this surface will show identity health, threads, and partner policy previews." />
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
                Choose the workspace whose identity surface, thread timeline, and outbound readiness you want to inspect.
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
                          next.delete('thread')
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
                  <StatusPill label={selectedWorkspace.policyConfigured ? 'Policy configured' : 'Policy default-only'} tone={selectedWorkspace.policyConfigured ? 'success' : 'warning'} />
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
                  or when recent partner-facing traces are failing. Threads below distinguish internal prep from cross-company motion, and the policy
                  preview shows which bindings can move outward and which workflows still need explicit approval.
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

          <section className="grid gap-6 xl:grid-cols-[0.9fr,1.1fr]">
            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Workspace threads</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Internal prep stays separate from external Beam handoffs, but both live on one operator timeline.
                  </p>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {threadsLoading ? 'Loading…' : `${formatNumber(threads.length)} threads`}
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {threadsLoading ? (
                  <EmptyPanel label="Loading workspace threads…" />
                ) : threads.length === 0 ? (
                  <EmptyPanel label="No workspace threads were recorded yet." />
                ) : (
                  threads.map((thread) => {
                    const selected = thread.id === selectedThread?.id
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
                          selected
                            ? 'border-orange-300 bg-orange-50/80 dark:border-orange-500/40 dark:bg-orange-500/10'
                            : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-900'
                        }`}
                        onClick={() => {
                          const next = new URLSearchParams(searchParams)
                          next.set('workspace', selectedWorkspace.slug)
                          next.set('thread', String(thread.id))
                          setSearchParams(next, { replace: true })
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{thread.title}</div>
                            <div className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
                              {thread.summary || 'No thread summary yet.'}
                            </div>
                          </div>
                          <div className="flex flex-wrap justify-end gap-2">
                            <StatusPill label={thread.kind} tone={thread.kind === 'handoff' ? 'success' : 'default'} />
                            <StatusPill label={thread.status} tone={threadStatusTone(thread.status)} />
                            {thread.trace ? <StatusPill label={thread.trace.status} tone={handoffStatusTone(thread.trace.status)} /> : null}
                          </div>
                        </div>

                        <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                          <div>{thread.workflowType ? `Workflow ${thread.workflowType}` : 'Internal-only thread'}</div>
                          <div>{formatNumber(thread.participantCount)} participants</div>
                          <div>{thread.owner ? `Owner ${thread.owner}` : 'No owner assigned'}</div>
                          <div>Last active {formatRelativeTime(thread.lastActivityAt)}</div>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </div>

            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Thread detail</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Read the participant set, linked Beam trace, and the exact workflow mode for the selected thread.
                  </p>
                </div>
                {selectedThread ? (
                  <StatusPill label={selectedThread.kind === 'handoff' ? 'Cross-company motion' : 'Internal prep'} tone={selectedThread.kind === 'handoff' ? 'success' : 'default'} />
                ) : null}
              </div>

              <div className="mt-4">
                {threadDetailLoading ? (
                  <EmptyPanel label="Loading thread detail…" />
                ) : !threadDetail ? (
                  <EmptyPanel label="Select a workspace thread to inspect participants, trace linkage, and workflow state." />
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{threadDetail.thread.title}</div>
                          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                            {threadDetail.thread.summary || 'No thread summary is attached yet.'}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusPill label={threadDetail.thread.kind} tone={threadDetail.thread.kind === 'handoff' ? 'success' : 'default'} />
                          <StatusPill label={threadDetail.thread.status} tone={threadStatusTone(threadDetail.thread.status)} />
                          {threadDetail.thread.trace ? <StatusPill label={threadDetail.thread.trace.status} tone={handoffStatusTone(threadDetail.thread.trace.status)} /> : null}
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 text-sm text-slate-600 dark:text-slate-300 md:grid-cols-2 xl:grid-cols-4">
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-400">Workflow</div>
                          <div>{threadDetail.thread.workflowType || 'Internal coordination'}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-400">Owner</div>
                          <div>{threadDetail.thread.owner || 'Unassigned'}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-400">Participants</div>
                          <div>{formatNumber(threadDetail.thread.participantCount)}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-400">Last activity</div>
                          <div>{formatRelativeTime(threadDetail.thread.lastActivityAt)}</div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Participants</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">{formatNumber(threadDetail.participants.length)} total</div>
                      </div>
                      <div className="mt-3 space-y-3">
                        {threadDetail.participants.map((participant) => (
                          <div key={participant.id} className="rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                                  {participant.displayName || participant.beamId || participant.principalId}
                                </div>
                                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                                  {participant.beamId || participant.principalId}
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <StatusPill label={participant.role} />
                                <StatusPill label={participant.principalType} tone={participant.principalType === 'partner' ? 'warning' : 'default'} />
                              </div>
                            </div>
                            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                              {participant.identity?.lastSeen
                                ? `Last seen ${formatRelativeTime(participant.identity.lastSeen)}`
                                : participant.identity
                                  ? 'Local identity without heartbeat yet'
                                  : 'Manual participant record'}
                              {participant.workspaceBindingId ? ` · Binding #${participant.workspaceBindingId}` : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Beam trace linkage</div>
                        {threadDetail.thread.trace ? (
                          <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={threadDetail.thread.trace.href}>
                            Open trace
                          </Link>
                        ) : null}
                      </div>
                      {threadDetail.thread.trace ? (
                        <div className="mt-3 grid gap-3 text-sm text-slate-600 dark:text-slate-300 md:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Intent</div>
                            <div>{threadDetail.thread.trace.intentType}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Path</div>
                            <div>{threadDetail.thread.trace.fromBeamId} → {threadDetail.thread.trace.toBeamId}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Requested</div>
                            <div>{formatRelativeTime(threadDetail.thread.trace.requestedAt)}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Latency</div>
                            <div>{formatLatency(threadDetail.thread.trace.latencyMs)}</div>
                          </div>
                          {threadDetail.thread.trace.errorCode ? (
                            <div className="md:col-span-2 xl:col-span-4 text-red-600 dark:text-red-300">
                              {threadDetail.thread.trace.errorCode}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                          Internal threads do not need a linked Beam nonce. Use them to organize prep, approvals, and operator work before external motion starts.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-[0.95fr,1.05fr]">
            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Policy surface</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    These previews show which workspace bindings can initiate external motion and what partner scope they inherit.
                  </p>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {policyLoading ? 'Loading…' : policy?.updatedAt ? `Updated ${formatRelativeTime(policy.updatedAt)}` : 'Default policy'}
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Default external initiation" value={policyLoading || !policy ? '—' : policy.policy.defaults.externalInitiation} tone={policy?.policy.defaults.externalInitiation === 'deny' ? 'warning' : 'default'} />
                <MetricCard label="Default partner allowlist" value={policyLoading || !policy ? '—' : formatNumber(policy.policy.defaults.allowedPartners.length)} />
                <MetricCard label="Binding rules" value={policyLoading || !policy ? '—' : formatNumber(policy.policy.bindingRules.length)} />
                <MetricCard label="Workflow rules" value={policyLoading || !policy ? '—' : formatNumber(policy.policy.workflowRules.length)} hint={policy?.updatedBy ? `Updated by ${policy.updatedBy}` : 'No explicit updater yet'} />
              </div>

              <div className="mt-4 rounded-2xl border border-slate-200 px-4 py-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                <div className="font-medium text-slate-900 dark:text-slate-100">Operator note</div>
                <div className="mt-1">
                  {policyLoading || !policy
                    ? 'Loading workspace policy notes…'
                    : policy.policy.metadata.notes || 'No workspace-specific note is attached yet. The workspace is using its default policy envelope.'}
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {policyLoading || !policy ? (
                  <EmptyPanel label="Loading binding previews…" />
                ) : policy.previews.bindings.length === 0 ? (
                  <EmptyPanel label="No local bindings are available for policy preview yet." />
                ) : (
                  policy.previews.bindings.map((preview) => (
                    <div key={preview.beamId} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{preview.beamId}</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{renderPolicyMeta(preview)}</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusPill label={preview.bindingType} />
                          <StatusPill label={preview.externalInitiation} tone={preview.externalInitiation === 'allow' ? 'success' : 'warning'} />
                        </div>
                      </div>
                      <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                        {summarizeList(preview.allowedPartners, 'No explicit partner allowlist. The binding relies on workspace defaults or downstream approval rules.')}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Workflow approvals</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Workflow-level previews show when a handoff can leave the workspace immediately and when Beam should stop for named approvers.
                  </p>
                </div>
                <a
                  className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300"
                  href="https://docs.beam.directory/guide/beam-workspaces"
                  rel="noreferrer"
                  target="_blank"
                >
                  Workspace guide
                </a>
              </div>

              <div className="mt-4 space-y-4">
                {policyLoading || !policy ? (
                  <EmptyPanel label="Loading workflow previews…" />
                ) : policy.previews.workflows.length === 0 ? (
                  <EmptyPanel label="No workflow-specific approval rules are configured for this workspace yet." />
                ) : (
                  policy.previews.workflows.map((workflow) => (
                    <div key={workflow.workflowType} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{workflow.workflowType}</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {formatNumber(workflow.bindings.length)} binding previews
                          </div>
                        </div>
                        <StatusPill
                          label={workflow.bindings.some((binding) => binding.approvalRequired) ? 'Approval path present' : 'Direct path only'}
                          tone={workflow.bindings.some((binding) => binding.approvalRequired) ? 'warning' : 'success'}
                        />
                      </div>

                      <div className="mt-3 space-y-3">
                        {workflow.bindings.map((binding) => (
                          <div key={`${workflow.workflowType}-${binding.beamId}`} className="rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{binding.beamId}</div>
                                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{renderPolicyMeta(binding)}</div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <StatusPill label={binding.externalInitiation} tone={binding.externalInitiation === 'allow' ? 'success' : 'warning'} />
                                <StatusPill label={binding.approvalRequired ? 'Approval required' : 'No approval'} tone={binding.approvalRequired ? 'warning' : 'success'} />
                              </div>
                            </div>
                            <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                              <div>{summarizeList(binding.allowedPartners, 'No additional workflow-scoped partner allowlist.')}</div>
                              {binding.approvalRequired ? (
                                <div className="mt-2">
                                  Approvers: {summarizeList(binding.approvers, 'No approvers listed')}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
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
