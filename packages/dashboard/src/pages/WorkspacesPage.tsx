import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import {
  ApiError,
  directoryApi,
  type IntentLifecycleStatus,
  type WorkspaceBindingStatus,
  type WorkspaceDigestActionItem,
  type WorkspaceDigestResponse,
  type WorkspaceIdentityBinding,
  type WorkspaceIdentityLifecycleStatus,
  type WorkspaceOverviewAttentionCode,
  type WorkspaceOverviewAttentionItem,
  type WorkspaceOverviewResponse,
  type WorkspacePartnerChannel,
  type WorkspacePartnerChannelHealth,
  type WorkspacePartnerChannelStatus,
  type WorkspacePolicyResponse,
  type WorkspaceRecord,
  type WorkspaceStatus,
  type WorkspaceThread,
  type WorkspaceThreadDetailResponse,
  type WorkspaceThreadKind,
  type WorkspaceThreadStatus,
  type WorkspaceTimelineEntry,
  type WorkspaceTimelineEventKind,
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

function lifecycleTone(status: WorkspaceIdentityLifecycleStatus): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'healthy':
      return 'success'
    case 'stale':
    case 'paused':
    case 'unowned':
      return 'warning'
    case 'missing':
    case 'revoked':
      return 'critical'
    default:
      return 'default'
  }
}

function partnerHealthTone(status: WorkspacePartnerChannelHealth): 'default' | 'success' | 'warning' | 'critical' {
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

function partnerStatusTone(status: WorkspacePartnerChannelStatus): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'active':
      return 'success'
    case 'trial':
      return 'warning'
    case 'blocked':
      return 'critical'
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

function digestSeverityTone(severity: WorkspaceDigestActionItem['severity']): 'default' | 'warning' | 'critical' {
  return severity === 'critical' ? 'critical' : 'warning'
}

function timelineTone(kind: WorkspaceTimelineEventKind): 'default' | 'success' | 'warning' {
  switch (kind) {
    case 'policy':
      return 'warning'
    case 'thread':
    case 'digest':
      return 'success'
    default:
      return 'default'
  }
}

function displayName(label: string | null, beamId: string): string {
  return label || beamId
}

function parseCsvList(value: string): string[] {
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))]
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

function renderBindingRuntime(binding: WorkspaceIdentityBinding): string {
  const label = binding.runtime.label
    ? (binding.runtime.connector ? `${binding.runtime.connector} · ${binding.runtime.label}` : binding.runtime.label)
    : binding.runtime.mode

  if (binding.runtime.deliveryMode) {
    return `${label} · ${binding.runtime.deliveryMode}`
  }

  return label
}

function renderBindingTransport(binding: WorkspaceIdentityBinding): string {
  if (binding.runtime.connected && binding.runtime.httpEndpoint) {
    return 'WebSocket live · HTTP endpoint configured'
  }
  if (binding.runtime.connected) {
    return 'WebSocket live'
  }
  if (binding.runtime.httpEndpoint) {
    return 'HTTP endpoint configured'
  }
  if (binding.bindingType === 'partner') {
    return 'Partner-side delivery managed externally'
  }
  return 'No live transport currently visible'
}

function renderChannelMeta(channel: WorkspacePartnerChannel): string {
  return [
    channel.owner ? `Owner ${channel.owner}` : 'No owner',
    channel.lastSuccessAt ? `Last success ${formatRelativeTime(channel.lastSuccessAt)}` : 'No successful handoff yet',
    channel.lastFailureAt ? `Last failure ${formatRelativeTime(channel.lastFailureAt)}` : 'No recent failures',
  ].join(' · ')
}

function buildPolicyDefaultsState(policy: WorkspacePolicyResponse | null) {
  return {
    externalInitiation: policy?.policy.defaults.externalInitiation ?? 'binding',
    allowedPartners: policy?.policy.defaults.allowedPartners.join(', ') ?? '',
    notes: policy?.policy.metadata.notes ?? '',
  }
}

export default function WorkspacesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [overview, setOverview] = useState<WorkspaceOverviewResponse | null>(null)
  const [bindings, setBindings] = useState<WorkspaceIdentityBinding[]>([])
  const [channels, setChannels] = useState<WorkspacePartnerChannel[]>([])
  const [threads, setThreads] = useState<WorkspaceThread[]>([])
  const [threadDetail, setThreadDetail] = useState<WorkspaceThreadDetailResponse | null>(null)
  const [policy, setPolicy] = useState<WorkspacePolicyResponse | null>(null)
  const [timeline, setTimeline] = useState<WorkspaceTimelineEntry[]>([])
  const [digest, setDigest] = useState<WorkspaceDigestResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [surfaceLoading, setSurfaceLoading] = useState(false)
  const [threadDetailLoading, setThreadDetailLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [policyDefaults, setPolicyDefaults] = useState(buildPolicyDefaultsState(null))
  const [workflowForm, setWorkflowForm] = useState({
    workflowType: '',
    requireApproval: true,
    allowedPartners: '',
    approvers: '',
  })
  const [partnerForm, setPartnerForm] = useState({
    partnerBeamId: '',
    label: '',
    owner: '',
    status: 'trial' as WorkspacePartnerChannelStatus,
    notes: '',
  })
  const [threadForm, setThreadForm] = useState({
    kind: 'internal' as WorkspaceThreadKind,
    title: '',
    summary: '',
    message: '',
    language: 'en',
    owner: '',
    workflowType: '',
    localBindingId: '',
    partnerChannelId: '',
    linkedIntentNonce: '',
  })

  const selectedSlug = searchParams.get('workspace') ?? ''
  const selectedThreadId = useMemo(() => {
    const raw = searchParams.get('thread')
    if (!raw) return null
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
  const localBindings = useMemo(
    () => bindings.filter((binding) => binding.bindingType !== 'partner'),
    [bindings],
  )

  async function loadWorkspaces() {
    const response = await directoryApi.listWorkspaces()
    setWorkspaces(response.workspaces)
  }

  async function loadWorkspaceSurface(slug: string) {
    const [
      overviewResponse,
      identitiesResponse,
      partnerChannelsResponse,
      threadsResponse,
      policyResponse,
      timelineResponse,
      digestResponse,
    ] = await Promise.all([
      directoryApi.getWorkspaceOverview(slug),
      directoryApi.listWorkspaceIdentities(slug),
      directoryApi.listWorkspacePartnerChannels(slug),
      directoryApi.listWorkspaceThreads(slug),
      directoryApi.getWorkspacePolicy(slug),
      directoryApi.getWorkspaceTimeline(slug, 60),
      directoryApi.getWorkspaceDigest(slug, { days: 7 }),
    ])

    setOverview(overviewResponse)
    setBindings(identitiesResponse.bindings)
    setChannels(partnerChannelsResponse.channels)
    setThreads(threadsResponse.threads)
    setPolicy(policyResponse)
    setTimeline(timelineResponse.entries)
    setDigest(digestResponse)
    setPolicyDefaults(buildPolicyDefaultsState(policyResponse))
  }

  async function loadThreadDetail(slug: string, threadId: number) {
    const response = await directoryApi.getWorkspaceThread(slug, threadId)
    setThreadDetail(response)
  }

  async function refreshAll(targetWorkspaceSlug?: string, targetThreadId?: number | null) {
    try {
      setSurfaceLoading(true)
      setError(null)
      const slug = targetWorkspaceSlug ?? selectedWorkspace?.slug ?? null
      await loadWorkspaces()
      if (slug) {
        await loadWorkspaceSurface(slug)
        const effectiveThreadId = targetThreadId ?? selectedThread?.id ?? null
        if (effectiveThreadId) {
          await loadThreadDetail(slug, effectiveThreadId)
        } else {
          setThreadDetail(null)
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load workspace control plane')
    } finally {
      setSurfaceLoading(false)
      setLoading(false)
    }
  }

  async function runAction(actionKey: string, fn: () => Promise<void>, successMessage: string) {
    try {
      setActionBusy(actionKey)
      setNotice(null)
      setError(null)
      await fn()
      setNotice(successMessage)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Workspace action failed')
    } finally {
      setActionBusy(null)
    }
  }

  useEffect(() => {
    void refreshAll()
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
      setBindings([])
      setChannels([])
      setThreads([])
      setThreadDetail(null)
      setPolicy(null)
      setTimeline([])
      setDigest(null)
      return
    }

    void (async () => {
      try {
        setSurfaceLoading(true)
        setError(null)
        await loadWorkspaceSurface(selectedWorkspace.slug)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load workspace surface')
      } finally {
        setSurfaceLoading(false)
      }
    })()
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

    void (async () => {
      try {
        setThreadDetailLoading(true)
        setError(null)
        await loadThreadDetail(selectedWorkspace.slug, selectedThread.id)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load workspace thread detail')
      } finally {
        setThreadDetailLoading(false)
      }
    })()
  }, [selectedWorkspace?.slug, selectedThread?.id])

  async function handlePolicyDefaultsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedWorkspace) return

    await runAction('policy-defaults', async () => {
      const response = await directoryApi.updateWorkspacePolicy(selectedWorkspace.slug, {
        defaults: {
          externalInitiation: policyDefaults.externalInitiation,
          allowedPartners: parseCsvList(policyDefaults.allowedPartners),
        },
        metadata: {
          notes: policyDefaults.notes.trim() || null,
        },
      })
      setPolicy(response)
      setPolicyDefaults(buildPolicyDefaultsState(response))
      await loadWorkspaceSurface(selectedWorkspace.slug)
    }, 'Workspace policy defaults updated.')
  }

  async function handleWorkflowRuleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedWorkspace || !policy || !workflowForm.workflowType.trim()) return

    const nextRule = {
      workflowType: workflowForm.workflowType.trim(),
      requireApproval: workflowForm.requireApproval,
      allowedPartners: parseCsvList(workflowForm.allowedPartners),
      approvers: parseCsvList(workflowForm.approvers),
    }

    await runAction(`workflow-${nextRule.workflowType}`, async () => {
      const response = await directoryApi.updateWorkspacePolicy(selectedWorkspace.slug, {
        workflowRules: [
          ...policy.policy.workflowRules.filter((rule) => rule.workflowType !== nextRule.workflowType),
          nextRule,
        ],
      })
      setPolicy(response)
      await loadWorkspaceSurface(selectedWorkspace.slug)
      setWorkflowForm({
        workflowType: '',
        requireApproval: true,
        allowedPartners: '',
        approvers: '',
      })
    }, `Workflow rule ${nextRule.workflowType} updated.`)
  }

  async function handleWorkflowRuleDelete(workflowType: string) {
    if (!selectedWorkspace || !policy) return

    await runAction(`workflow-delete-${workflowType}`, async () => {
      const response = await directoryApi.updateWorkspacePolicy(selectedWorkspace.slug, {
        workflowRules: policy.policy.workflowRules.filter((rule) => rule.workflowType !== workflowType),
      })
      setPolicy(response)
      await loadWorkspaceSurface(selectedWorkspace.slug)
    }, `Workflow rule ${workflowType} removed.`)
  }

  async function handleBindingToggle(binding: WorkspaceIdentityBinding, patch: Partial<Pick<WorkspaceIdentityBinding, 'status' | 'canInitiateExternal'>>) {
    if (!selectedWorkspace) return
    await runAction(`binding-${binding.id}`, async () => {
      await directoryApi.updateWorkspaceIdentity(selectedWorkspace.slug, binding.id, patch)
      await loadWorkspaceSurface(selectedWorkspace.slug)
    }, `${binding.beamId} updated.`)
  }

  async function handlePartnerChannelSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedWorkspace || !partnerForm.partnerBeamId.trim()) return

    await runAction('partner-channel-create', async () => {
      await directoryApi.createWorkspacePartnerChannel(selectedWorkspace.slug, {
        partnerBeamId: partnerForm.partnerBeamId.trim(),
        label: partnerForm.label.trim() || null,
        owner: partnerForm.owner.trim() || null,
        status: partnerForm.status,
        notes: partnerForm.notes.trim() || null,
      })
      await loadWorkspaceSurface(selectedWorkspace.slug)
      setPartnerForm({
        partnerBeamId: '',
        label: '',
        owner: '',
        status: 'trial',
        notes: '',
      })
    }, `Partner channel ${partnerForm.partnerBeamId.trim()} created.`)
  }

  async function handlePartnerChannelAction(channel: WorkspacePartnerChannel, status: WorkspacePartnerChannelStatus) {
    if (!selectedWorkspace) return
    await runAction(`partner-channel-${channel.id}`, async () => {
      await directoryApi.updateWorkspacePartnerChannel(selectedWorkspace.slug, channel.id, { status })
      await loadWorkspaceSurface(selectedWorkspace.slug)
    }, `${channel.label || channel.partnerBeamId} moved to ${status}.`)
  }

  async function handleThreadComposerSubmit(mode: 'create' | 'dispatch') {
    if (!selectedWorkspace || !threadForm.title.trim()) return

    const localBinding = localBindings.find((binding) => binding.id === Number.parseInt(threadForm.localBindingId, 10))
    const partnerChannel = channels.find((channel) => channel.id === Number.parseInt(threadForm.partnerChannelId, 10))
    const partnerBinding = bindings.find((binding) => binding.beamId === partnerChannel?.partnerBeamId)
    const participants: Array<{
      principalId: string
      principalType: 'human' | 'agent' | 'service' | 'partner'
      displayName?: string | null
      beamId?: string | null
      workspaceBindingId?: number | null
      role?: 'owner' | 'participant' | 'observer' | 'approver'
    }> = []

    if (threadForm.owner.trim()) {
      participants.push({
        principalId: threadForm.owner.trim(),
        principalType: 'human',
        displayName: threadForm.owner.trim(),
        role: 'owner',
      })
    }

    if (localBinding) {
      participants.push({
        principalId: localBinding.beamId,
        principalType: localBinding.bindingType === 'service' ? 'service' : 'agent',
        beamId: localBinding.beamId,
        workspaceBindingId: localBinding.id,
        displayName: localBinding.identity.displayName,
        role: threadForm.kind === 'handoff' ? 'owner' : 'participant',
      })
    }

    if (threadForm.kind === 'handoff' && partnerChannel) {
      participants.push({
        principalId: partnerChannel.partnerBeamId,
        principalType: 'partner',
        beamId: partnerChannel.partnerBeamId,
        workspaceBindingId: partnerBinding?.id ?? null,
        displayName: partnerChannel.label || partnerChannel.partner.displayName,
        role: 'participant',
      })
    }

    const linkedIntentNonce = threadForm.linkedIntentNonce.trim()
    const shouldDispatch = mode === 'dispatch' && threadForm.kind === 'handoff' && linkedIntentNonce.length === 0
    const dispatchMessage = threadForm.message.trim() || threadForm.summary.trim() || threadForm.title.trim()
    let createdThreadId: number | null = null

    try {
      setActionBusy(shouldDispatch ? 'thread-composer-dispatch' : 'thread-composer-create')
      setNotice(null)
      setError(null)

      const response = await directoryApi.createWorkspaceThread(selectedWorkspace.slug, {
        kind: threadForm.kind,
        title: threadForm.title.trim(),
        summary: threadForm.summary.trim() || null,
        owner: threadForm.owner.trim() || null,
        workflowType: threadForm.workflowType.trim() || null,
        linkedIntentNonce: linkedIntentNonce || null,
        status: threadForm.kind === 'handoff' && !linkedIntentNonce ? 'blocked' : 'open',
        participants,
      })

      createdThreadId = response.thread.id
      let activeThreadId = response.thread.id
      let noticeMessage = 'Workspace thread created.'
      if (shouldDispatch) {
        const dispatchResponse = await directoryApi.dispatchWorkspaceThread(selectedWorkspace.slug, response.thread.id, {
          message: dispatchMessage,
          language: threadForm.language.trim() || null,
        })
        activeThreadId = dispatchResponse.thread.id
        noticeMessage = dispatchResponse.dispatch.success
          ? 'Workspace handoff dispatched through Beam.'
          : `Workspace handoff dispatched with a failed Beam response${dispatchResponse.dispatch.errorCode ? ` (${dispatchResponse.dispatch.errorCode})` : ''}.`
      } else if (mode === 'dispatch' && linkedIntentNonce) {
        noticeMessage = 'Workspace thread linked to an existing Beam trace.'
      }

      await loadWorkspaceSurface(selectedWorkspace.slug)
      await loadThreadDetail(selectedWorkspace.slug, activeThreadId)
      setThreadForm({
        kind: 'internal',
        title: '',
        summary: '',
        message: '',
        language: 'en',
        owner: '',
        workflowType: '',
        localBindingId: '',
        partnerChannelId: '',
        linkedIntentNonce: '',
      })

      const next = new URLSearchParams(searchParams)
      next.set('workspace', selectedWorkspace.slug)
      next.set('thread', String(activeThreadId))
      setSearchParams(next, { replace: true })
      setNotice(noticeMessage)
    } catch (err) {
      if (createdThreadId) {
        try {
          await loadWorkspaceSurface(selectedWorkspace.slug)
          await loadThreadDetail(selectedWorkspace.slug, createdThreadId)
        } catch {
          // Ignore secondary refresh errors and surface the original failure below.
        }
      }
      setError(err instanceof ApiError ? err.message : 'Workspace thread action failed')
    } finally {
      setActionBusy(null)
    }
  }

  async function handleThreadDispatch(thread: WorkspaceThread) {
    if (!selectedWorkspace) return

    try {
      setActionBusy(`thread-dispatch-${thread.id}`)
      setNotice(null)
      setError(null)

      const response = await directoryApi.dispatchWorkspaceThread(selectedWorkspace.slug, thread.id, {
        message: thread.summary || thread.title,
        language: 'en',
      })
      await loadWorkspaceSurface(selectedWorkspace.slug)
      await loadThreadDetail(selectedWorkspace.slug, thread.id)
      setNotice(
        response.dispatch.success
          ? 'Workspace handoff dispatched through Beam.'
          : `Workspace handoff dispatched with a failed Beam response${response.dispatch.errorCode ? ` (${response.dispatch.errorCode})` : ''}.`,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Workspace handoff dispatch failed')
    } finally {
      setActionBusy(null)
    }
  }

  async function handleDeliverDigest() {
    if (!selectedWorkspace) return

    await runAction('workspace-digest-deliver', async () => {
      await directoryApi.deliverWorkspaceDigest(selectedWorkspace.slug, { days: 7 })
      await loadWorkspaceSurface(selectedWorkspace.slug)
    }, 'Workspace digest delivered to your operator mailbox.')
  }

  async function handleCopyDigest() {
    if (!digest) return
    try {
      await navigator.clipboard.writeText(digest.markdown)
      setNotice('Workspace digest copied to the clipboard.')
    } catch {
      setError('Clipboard access is not available in this browser context.')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspaces"
        description="Identity home, policy control, outbound approvals, partner channels, thread drafts, and audit proof for Beam workspaces."
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
            <Link className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800" to="/partner-ops">
              Partner ops
            </Link>
            <button
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
              type="button"
              disabled={surfaceLoading}
              onClick={() => {
                void refreshAll(selectedWorkspace?.slug, selectedThread?.id ?? null)
              }}
            >
              {surfaceLoading ? 'Refreshing…' : 'Refresh'}
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

      {!loading && workspaces.length === 0 ? (
        <EmptyPanel label="No Beam workspaces exist yet. Create one from the admin API first, then this surface will show control-plane state." />
      ) : null}

      {selectedWorkspace ? (
        <>
          <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="Active identities" value={!overview ? '—' : formatNumber(overview.summary.activeIdentities)} hint={`${overview ? formatNumber(overview.summary.totalIdentities) : '—'} total`} />
            <MetricCard label="External ready" value={!overview ? '—' : formatNumber(overview.summary.externalReadyIdentities)} tone={(overview?.summary.externalReadyIdentities ?? 0) > 0 ? 'success' : 'default'} />
            <MetricCard label="Stale identities" value={!overview ? '—' : formatNumber(overview.summary.staleIdentities)} tone={(overview?.summary.staleIdentities ?? 0) > 0 ? 'warning' : 'default'} />
            <MetricCard label="Manual review" value={!overview ? '—' : formatNumber(overview.summary.pendingApprovals)} tone={(overview?.summary.pendingApprovals ?? 0) > 0 ? 'warning' : 'default'} />
            <MetricCard label="Partner channels" value={formatNumber(channels.length)} tone={channels.some((channel) => channel.healthStatus === 'critical') ? 'critical' : channels.some((channel) => channel.healthStatus === 'watch') ? 'warning' : 'success'} />
            <MetricCard label="Digest escalations" value={!digest ? '—' : formatNumber(digest.summary.escalations)} tone={(digest?.summary.escalations ?? 0) > 0 ? 'critical' : 'default'} />
          </section>

          <section className="grid gap-6 xl:grid-cols-[0.74fr,1.26fr]">
            <div className="panel">
              <div className="panel-title">Workspace roster</div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Pick the workspace whose control plane you want to inspect.
              </p>
              <div className="mt-4 space-y-3">
                {workspaces.map((workspace) => {
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
                        <div>{formatNumber(workspace.summary.partnerChannels)} partner channels</div>
                        <div>{formatNumber(workspace.summary.externalInitiators)} initiators</div>
                        <div>{workspace.externalHandoffsEnabled ? 'External on' : 'External off'}</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="panel">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="panel-title">{selectedWorkspace.name}</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    {selectedWorkspace.description || 'Beam Workspace control plane for identities, approvals, and partner-facing motion.'}
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
                <MetricCard label="Local identities" value={!overview ? '—' : formatNumber(overview.summary.localIdentities)} />
                <MetricCard label="Partner identities" value={!overview ? '—' : formatNumber(overview.summary.partnerIdentities)} />
                <MetricCard label="Workspace members" value={formatNumber(selectedWorkspace.summary.members)} />
                <MetricCard label="Updated" value={formatRelativeTime(selectedWorkspace.updatedAt)} hint={formatDateTime(selectedWorkspace.updatedAt)} />
              </div>

              <div className="mt-5 rounded-2xl border border-slate-200 px-4 py-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                <div className="font-medium text-slate-900 dark:text-slate-100">What changed in this control plane</div>
                <div className="mt-1">
                  Operators can now execute approval-path decisions directly from one surface: resume or pause bindings, grant or remove outbound rights, manage partner channels,
                  create internal or blocked handoff threads, review workspace policy, inspect the audit timeline, and ship a digest when a workspace needs human attention.
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Identity lifecycle</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Runtime-backed identities, owners, key-state drift, and outbound controls for this workspace.
                  </p>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{formatNumber(bindings.length)} bindings</div>
              </div>

              <div className="mt-4 space-y-3">
                {bindings.length === 0 ? (
                  <EmptyPanel label="No workspace bindings exist yet." />
                ) : (
                  bindings.map((binding) => (
                    <div key={binding.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                            {displayName(binding.identity.displayName, binding.beamId)}
                          </div>
                          <div className="truncate text-xs text-slate-500 dark:text-slate-400">{binding.beamId}</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusPill label={binding.bindingType} />
                          <StatusPill label={binding.lifecycleStatus} tone={lifecycleTone(binding.lifecycleStatus)} />
                          <StatusPill label={binding.status} tone={binding.status === 'paused' ? 'warning' : 'default'} />
                        </div>
                      </div>

                      <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                        <div>{binding.owner ? `Owner ${binding.owner}` : 'No owner assigned'}</div>
                        <div>{renderBindingRuntime(binding)}</div>
                        <div>{binding.identity.lastSeen ? `Last seen ${formatRelativeTime(binding.identity.lastSeen)}` : 'No heartbeat recorded'}</div>
                        <div>{binding.canInitiateExternal ? 'Can initiate external' : 'Manual review required'}</div>
                        <div>{renderBindingTransport(binding)}</div>
                        <div>{binding.identity.capabilities.length > 0 ? `${binding.identity.capabilities.length} capabilities declared` : 'No capabilities declared'}</div>
                      </div>

                      {binding.notes ? (
                        <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">{binding.notes}</div>
                      ) : null}

                      <div className="mt-4 flex flex-wrap gap-2">
                        {binding.bindingType !== 'partner' ? (
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={actionBusy === `binding-${binding.id}`}
                            onClick={() => {
                              void handleBindingToggle(binding, {
                                canInitiateExternal: !binding.canInitiateExternal,
                              })
                            }}
                          >
                            {binding.canInitiateExternal ? 'Require manual review' : 'Allow external'}
                          </button>
                        ) : null}
                        <button
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                          type="button"
                          disabled={actionBusy === `binding-${binding.id}`}
                          onClick={() => {
                            void handleBindingToggle(binding, {
                              status: binding.status === 'paused' ? 'active' : 'paused',
                            })
                          }}
                        >
                          {binding.status === 'paused' ? 'Resume binding' : 'Pause binding'}
                        </button>
                        {binding.identity.existsLocally ? (
                          <Link className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-orange-600 transition hover:bg-slate-100 dark:border-slate-800 dark:text-orange-300 dark:hover:bg-slate-800" to={`/agents/${encodeURIComponent(binding.beamId)}`}>
                            Open agent
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Partner channels</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Trial, active, or blocked partner lanes with owner, trust context, and last known trace.
                  </p>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{formatNumber(channels.length)} channels</div>
              </div>

              <form className="mt-4 grid gap-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800 md:grid-cols-2" onSubmit={(event) => { void handlePartnerChannelSubmit(event) }}>
                <input className="input-field" placeholder="partner@northwind.beam.directory" value={partnerForm.partnerBeamId} onChange={(event) => setPartnerForm((current) => ({ ...current, partnerBeamId: event.target.value }))} />
                <input className="input-field" placeholder="Human label" value={partnerForm.label} onChange={(event) => setPartnerForm((current) => ({ ...current, label: event.target.value }))} />
                <input className="input-field" placeholder="Owner email" value={partnerForm.owner} onChange={(event) => setPartnerForm((current) => ({ ...current, owner: event.target.value }))} />
                <select className="input-field" value={partnerForm.status} onChange={(event) => setPartnerForm((current) => ({ ...current, status: event.target.value as WorkspacePartnerChannelStatus }))}>
                  <option value="trial">trial</option>
                  <option value="active">active</option>
                  <option value="blocked">blocked</option>
                </select>
                <textarea className="input-field md:col-span-2 min-h-24" placeholder="Operator notes" value={partnerForm.notes} onChange={(event) => setPartnerForm((current) => ({ ...current, notes: event.target.value }))} />
                <div className="md:col-span-2">
                  <button className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white" type="submit" disabled={actionBusy === 'partner-channel-create'}>
                    {actionBusy === 'partner-channel-create' ? 'Creating…' : 'Add partner channel'}
                  </button>
                </div>
              </form>

              <div className="mt-4 space-y-3">
                {channels.length === 0 ? (
                  <EmptyPanel label="No partner channels are configured for this workspace yet." />
                ) : (
                  channels.map((channel) => (
                    <div key={channel.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                            {channel.label || displayName(channel.partner.displayName, channel.partnerBeamId)}
                          </div>
                          <div className="truncate text-xs text-slate-500 dark:text-slate-400">{channel.partnerBeamId}</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusPill label={channel.status} tone={partnerStatusTone(channel.status)} />
                          <StatusPill label={channel.healthStatus} tone={partnerHealthTone(channel.healthStatus)} />
                        </div>
                      </div>

                      <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">{renderChannelMeta(channel)}</div>
                      <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-3">
                        <div>{formatNumber(channel.stats.totalObserved)} observed</div>
                        <div>{formatNumber(channel.stats.recentSuccesses)} recent successes</div>
                        <div>{formatNumber(channel.stats.recentFailures)} recent failures</div>
                      </div>

                      {channel.notes ? (
                        <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">{channel.notes}</div>
                      ) : null}

                      <div className="mt-4 flex flex-wrap gap-2">
                        {channel.status !== 'active' ? (
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={actionBusy === `partner-channel-${channel.id}`}
                            onClick={() => { void handlePartnerChannelAction(channel, 'active') }}
                          >
                            Promote active
                          </button>
                        ) : null}
                        {channel.status !== 'blocked' ? (
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={actionBusy === `partner-channel-${channel.id}`}
                            onClick={() => { void handlePartnerChannelAction(channel, 'blocked') }}
                          >
                            Block channel
                          </button>
                        ) : (
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={actionBusy === `partner-channel-${channel.id}`}
                            onClick={() => { void handlePartnerChannelAction(channel, 'trial') }}
                          >
                            Reopen as trial
                          </button>
                        )}
                        {channel.trace ? (
                          <Link className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-orange-600 transition hover:bg-slate-100 dark:border-slate-800 dark:text-orange-300 dark:hover:bg-slate-800" to={channel.trace.href}>
                            Open last trace
                          </Link>
                        ) : null}
                      </div>
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
                  <div className="panel-title">Thread composer</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Create internal coordination threads or dispatch a real cross-instance Beam handoff from the workspace control plane.
                  </p>
                </div>
                <StatusPill label={threadForm.kind === 'handoff' ? 'Beam handoff' : 'Internal thread'} tone={threadForm.kind === 'handoff' ? 'warning' : 'default'} />
              </div>

              <form
                className="mt-4 grid gap-3 md:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleThreadComposerSubmit('create')
                }}
              >
                <select className="input-field" value={threadForm.kind} onChange={(event) => setThreadForm((current) => ({ ...current, kind: event.target.value as WorkspaceThreadKind }))}>
                  <option value="internal">internal</option>
                  <option value="handoff">handoff</option>
                </select>
                <input className="input-field" placeholder="Owner email" value={threadForm.owner} onChange={(event) => setThreadForm((current) => ({ ...current, owner: event.target.value }))} />
                <input className="input-field md:col-span-2" placeholder="Thread title" value={threadForm.title} onChange={(event) => setThreadForm((current) => ({ ...current, title: event.target.value }))} />
                <textarea className="input-field md:col-span-2 min-h-24" placeholder={threadForm.kind === 'handoff' ? 'Operator brief or traceable summary' : 'Summary or operator brief'} value={threadForm.summary} onChange={(event) => setThreadForm((current) => ({ ...current, summary: event.target.value }))} />
                <select className="input-field" value={threadForm.localBindingId} onChange={(event) => setThreadForm((current) => ({ ...current, localBindingId: event.target.value }))}>
                  <option value="">Select local identity</option>
                  {localBindings.map((binding) => (
                    <option key={binding.id} value={binding.id}>
                      {binding.identity.displayName || binding.beamId}
                    </option>
                  ))}
                </select>
                <input className="input-field" placeholder="Workflow type (optional)" value={threadForm.workflowType} onChange={(event) => setThreadForm((current) => ({ ...current, workflowType: event.target.value }))} />
                {threadForm.kind === 'handoff' ? (
                  <>
                    <select className="input-field" value={threadForm.partnerChannelId} onChange={(event) => setThreadForm((current) => ({ ...current, partnerChannelId: event.target.value }))}>
                      <option value="">Select partner channel</option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.label || channel.partnerBeamId}
                        </option>
                      ))}
                    </select>
                    <input className="input-field" placeholder="Language hint (default en)" value={threadForm.language} onChange={(event) => setThreadForm((current) => ({ ...current, language: event.target.value }))} />
                    <textarea className="input-field md:col-span-2 min-h-24" placeholder="Message to send over Beam (defaults to summary/title if blank)" value={threadForm.message} onChange={(event) => setThreadForm((current) => ({ ...current, message: event.target.value }))} />
                    <input className="input-field" placeholder="Linked intent nonce (optional if still blocked)" value={threadForm.linkedIntentNonce} onChange={(event) => setThreadForm((current) => ({ ...current, linkedIntentNonce: event.target.value }))} />
                  </>
                ) : null}
                <div className="md:col-span-2 flex flex-wrap gap-2">
                  <button className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white" type="submit" disabled={actionBusy === 'thread-composer-create' || actionBusy === 'thread-composer-dispatch'}>
                    {actionBusy === 'thread-composer-create' ? 'Creating…' : 'Create thread'}
                  </button>
                  {threadForm.kind === 'handoff' ? (
                    <button
                      className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                      type="button"
                      disabled={actionBusy === 'thread-composer-create' || actionBusy === 'thread-composer-dispatch' || !threadForm.partnerChannelId || !threadForm.localBindingId}
                      onClick={() => { void handleThreadComposerSubmit('dispatch') }}
                    >
                      {actionBusy === 'thread-composer-dispatch'
                        ? 'Sending…'
                        : threadForm.linkedIntentNonce.trim()
                          ? 'Create and link'
                          : 'Create and send'}
                    </button>
                  ) : null}
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Handoff threads can stay blocked for review, link to an existing nonce, or be sent directly from this workspace surface.
                  </div>
                </div>
              </form>

              <div className="mt-6 space-y-3">
                {threads.length === 0 ? (
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
                          <div className="flex flex-wrap gap-2">
                            <StatusPill label={thread.kind} tone={thread.kind === 'handoff' ? 'warning' : 'default'} />
                            <StatusPill label={thread.status} tone={threadStatusTone(thread.status)} />
                            {thread.trace ? <StatusPill label={thread.trace.status} tone={handoffStatusTone(thread.trace.status)} /> : null}
                          </div>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                          <div>{thread.workflowType ? `Workflow ${thread.workflowType}` : 'Internal coordination'}</div>
                          <div>{thread.owner ? `Owner ${thread.owner}` : 'No owner assigned'}</div>
                          <div>{formatNumber(thread.participantCount)} participants</div>
                          <div>Last active {formatRelativeTime(thread.lastActivityAt)}</div>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">Thread detail</div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Participant list, linked Beam trace, and exact workflow mode for the selected thread.
              </p>

              <div className="mt-4">
                {threadDetailLoading ? (
                  <EmptyPanel label="Loading thread detail…" />
                ) : !threadDetail ? (
                  <EmptyPanel label="Select a thread to inspect participants and linked trace state." />
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{threadDetail.thread.title}</div>
                          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{threadDetail.thread.summary || 'No thread summary attached yet.'}</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusPill label={threadDetail.thread.kind} tone={threadDetail.thread.kind === 'handoff' ? 'warning' : 'default'} />
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
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Participants</div>
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
                        </div>
                      ) : (
                        <div className="mt-3 space-y-3">
                          <div className="text-sm text-slate-500 dark:text-slate-400">
                            This thread is still internal or blocked. You can now approve and send a blocked handoff directly from the workspace control plane; once Beam accepts it, the full trace appears here.
                          </div>
                          {threadDetail.thread.kind === 'handoff' && threadDetail.thread.status === 'blocked' ? (
                            <button
                              className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                              type="button"
                              disabled={actionBusy === `thread-dispatch-${threadDetail.thread.id}`}
                              onClick={() => { void handleThreadDispatch(threadDetail.thread) }}
                            >
                              {actionBusy === `thread-dispatch-${threadDetail.thread.id}` ? 'Sending…' : 'Approve and send'}
                            </button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Policy actions</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Update default outbound policy and attach workflow-specific approval rules without leaving the dashboard.
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

              <form className="mt-4 grid gap-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800" onSubmit={(event) => { void handlePolicyDefaultsSubmit(event) }}>
                <label className="text-xs font-medium uppercase tracking-wide text-slate-400">Default external initiation</label>
                <select className="input-field" value={policyDefaults.externalInitiation} onChange={(event) => setPolicyDefaults((current) => ({ ...current, externalInitiation: event.target.value as 'binding' | 'deny' }))}>
                  <option value="binding">binding</option>
                  <option value="deny">deny</option>
                </select>
                <label className="text-xs font-medium uppercase tracking-wide text-slate-400">Default allowed partners</label>
                <input className="input-field" placeholder="partner-a.*, partner-b@northwind.beam.directory" value={policyDefaults.allowedPartners} onChange={(event) => setPolicyDefaults((current) => ({ ...current, allowedPartners: event.target.value }))} />
                <label className="text-xs font-medium uppercase tracking-wide text-slate-400">Operator note</label>
                <textarea className="input-field min-h-24" placeholder="Why this workspace is configured this way" value={policyDefaults.notes} onChange={(event) => setPolicyDefaults((current) => ({ ...current, notes: event.target.value }))} />
                <div>
                  <button className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white" type="submit" disabled={actionBusy === 'policy-defaults'}>
                    {actionBusy === 'policy-defaults' ? 'Saving…' : 'Save defaults'}
                  </button>
                </div>
              </form>

              <form className="mt-4 grid gap-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-800" onSubmit={(event) => { void handleWorkflowRuleSubmit(event) }}>
                <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Workflow rule</div>
                <input className="input-field" placeholder="invoice.review" value={workflowForm.workflowType} onChange={(event) => setWorkflowForm((current) => ({ ...current, workflowType: event.target.value }))} />
                <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                  <input checked={workflowForm.requireApproval} onChange={(event) => setWorkflowForm((current) => ({ ...current, requireApproval: event.target.checked }))} type="checkbox" />
                  Require approval before outbound motion
                </label>
                <input className="input-field" placeholder="Allowed partners (comma separated)" value={workflowForm.allowedPartners} onChange={(event) => setWorkflowForm((current) => ({ ...current, allowedPartners: event.target.value }))} />
                <input className="input-field" placeholder="Approvers (comma separated)" value={workflowForm.approvers} onChange={(event) => setWorkflowForm((current) => ({ ...current, approvers: event.target.value }))} />
                <div>
                  <button className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800" type="submit" disabled={actionBusy?.startsWith('workflow-')}>
                    Save workflow rule
                  </button>
                </div>
              </form>
            </div>

            <div className="panel">
              <div className="panel-title">Workflow approvals</div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Current workflow rules and the live binding previews they produce.
              </p>

              <div className="mt-4 space-y-4">
                {!policy || policy.previews.workflows.length === 0 ? (
                  <EmptyPanel label="No workflow-specific approval rules are configured for this workspace yet." />
                ) : (
                  policy.previews.workflows.map((workflow) => (
                    <div key={workflow.workflowType} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{workflow.workflowType}</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{formatNumber(workflow.bindings.length)} binding previews</div>
                        </div>
                        <div className="flex gap-2">
                          <StatusPill
                            label={workflow.bindings.some((binding) => binding.approvalRequired) ? 'Approval path present' : 'Direct path only'}
                            tone={workflow.bindings.some((binding) => binding.approvalRequired) ? 'warning' : 'success'}
                          />
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={actionBusy === `workflow-delete-${workflow.workflowType}`}
                            onClick={() => { void handleWorkflowRuleDelete(workflow.workflowType) }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>

                      <div className="mt-3 space-y-3">
                        {workflow.bindings.map((binding) => (
                          <div key={`${workflow.workflowType}-${binding.beamId}`} className="rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{binding.beamId}</div>
                                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                                  {binding.policyProfile ? `Profile ${binding.policyProfile}` : 'No policy profile'} · {binding.matchedBindingRules} binding rule matches
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <StatusPill label={binding.externalInitiation} tone={binding.externalInitiation === 'allow' ? 'success' : 'warning'} />
                                <StatusPill label={binding.approvalRequired ? 'Approval required' : 'No approval'} tone={binding.approvalRequired ? 'warning' : 'success'} />
                              </div>
                            </div>
                            <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                              <div>{summarizeList(binding.allowedPartners, 'No additional workflow-scoped partner allowlist.')}</div>
                              {binding.approvalRequired ? (
                                <div className="mt-2">Approvers: {summarizeList(binding.approvers, 'No approvers listed')}</div>
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

          <section className="grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Workspace timeline</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Audit proof across policy changes, binding updates, partner-channel decisions, thread creation, and digest delivery.
                  </p>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{formatNumber(timeline.length)} entries</div>
              </div>

              <div className="mt-4 space-y-3">
                {timeline.length === 0 ? (
                  <EmptyPanel label="No workspace audit entries were recorded yet." />
                ) : (
                  timeline.map((entry) => (
                    <div key={entry.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{entry.summary}</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{entry.actor} · {formatRelativeTime(entry.timestamp)}</div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusPill label={entry.kind} tone={timelineTone(entry.kind)} />
                          <StatusPill label={entry.action} />
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-4 text-sm">
                        {entry.href ? (
                          <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={entry.href}>
                            Open workspace surface
                          </Link>
                        ) : null}
                        {entry.traceHref ? (
                          <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={entry.traceHref}>
                            Open trace
                          </Link>
                        ) : null}
                        <span className="text-slate-500 dark:text-slate-400">{formatDateTime(entry.timestamp)}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="panel">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="panel-title">Workspace digest</div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Recurring operator digest and escalation loop for this workspace.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                    type="button"
                    disabled={actionBusy === 'workspace-digest-deliver'}
                    onClick={() => { void handleDeliverDigest() }}
                  >
                    {actionBusy === 'workspace-digest-deliver' ? 'Delivering…' : 'Deliver digest'}
                  </button>
                  <button
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                    type="button"
                    disabled={!digest}
                    onClick={() => { void handleCopyDigest() }}
                  >
                    Copy markdown
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <MetricCard label="Action items" value={!digest ? '—' : formatNumber(digest.summary.actionItems)} tone={(digest?.summary.actionItems ?? 0) > 0 ? 'warning' : 'default'} />
                <MetricCard label="Escalations" value={!digest ? '—' : formatNumber(digest.summary.escalations)} tone={(digest?.summary.escalations ?? 0) > 0 ? 'critical' : 'default'} />
                <MetricCard label="Open threads" value={!digest ? '—' : formatNumber(digest.summary.openThreads)} />
                <MetricCard label="Blocked motion" value={!digest ? '—' : formatNumber(digest.summary.blockedExternalMotion)} tone={(digest?.summary.blockedExternalMotion ?? 0) > 0 ? 'critical' : 'default'} />
              </div>

              <div className="mt-4 space-y-3">
                {!digest || digest.actionItems.length === 0 ? (
                  <EmptyPanel label="No workspace action items are in the digest right now." />
                ) : (
                  digest.actionItems.slice(0, 8).map((item) => (
                    <div key={item.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.title}</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{item.category} · {item.owner ? `Owner ${item.owner}` : 'No owner'}</div>
                        </div>
                        <StatusPill label={item.severity} tone={digestSeverityTone(item.severity)} />
                      </div>
                      <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">{item.detail}</div>
                      <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">Next action: {item.nextAction}</div>
                      {item.href ? (
                        <div className="mt-3">
                          <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={item.href}>
                            Open surface
                          </Link>
                        </div>
                      ) : null}
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
                  Latest partner-facing or outside-in traces touching this workspace.
                </p>
              </div>
              <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to="/intents">
                Open intent feed
              </Link>
            </div>

            <div className="mt-4 space-y-3">
              {!overview || overview.recentExternalHandoffs.length === 0 ? (
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
