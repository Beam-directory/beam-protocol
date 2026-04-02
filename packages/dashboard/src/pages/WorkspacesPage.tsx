import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import {
  ApiError,
  directoryApi,
  type IntentCatalogItem,
  type IntentLifecycleStatus,
  type WorkspaceApprovalQueueBindingItem,
  type WorkspaceApprovalQueueItem,
  type WorkspaceApprovalQueueResponse,
  type WorkspaceApprovalQueueThreadItem,
  type WorkspaceBindingStatus,
  type WorkspaceDigestActionItem,
  type WorkspaceDigestResponse,
  type OpenClawHostHealth,
  type OpenClawRouteRuntimeState,
  type OpenClawRouteSource,
  type WorkspaceIdentityBinding,
  type WorkspaceIdentityCredentialBundle,
  type WorkspaceIdentityLifecycleStatus,
  type WorkspaceOverviewAttentionCode,
  type WorkspaceOverviewAttentionItem,
  type WorkspaceOverviewResponse,
  type WorkspacePartnerChannel,
  type WorkspacePartnerChannelHealth,
  type WorkspacePartnerChannelStatus,
  type WorkspacePolicyResponse,
  type WorkspacePolicyRuleExternalInitiation,
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

const FALLBACK_CONVERSATION_INTENT: IntentCatalogItem = {
  id: 'conversation.message',
  description: 'Natural language message with optional language and context.',
  params: {
    message: { type: 'string', required: true },
    language: { type: 'string', default: 'en' },
    context: { type: 'object' },
  },
}

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

function approvalSeverityTone(severity: WorkspaceApprovalQueueItem['severity']): 'default' | 'warning' | 'critical' {
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

function hostHealthTone(status: OpenClawHostHealth | 'conflict' | null): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'healthy':
      return 'success'
    case 'watch':
    case 'pending':
      return 'warning'
    case 'stale':
    case 'revoked':
    case 'conflict':
      return 'critical'
    default:
      return 'default'
  }
}

function routeRuntimeTone(status: OpenClawRouteRuntimeState | null): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'live':
      return 'success'
    case 'idle':
      return 'default'
    case 'stale':
      return 'warning'
    case 'ended':
    case 'conflict':
    case 'revoked':
      return 'critical'
    default:
      return 'default'
  }
}

function routeSourceLabel(source: OpenClawRouteSource | null): string | null {
  switch (source) {
    case 'agent-folder':
      return 'Agent'
    case 'workspace-agent':
      return 'Workspace agent'
    case 'gateway-agent':
      return 'Gateway agent'
    case 'subagent-run':
      return 'Subagent'
    default:
      return null
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

function summarizeKeyState(binding: WorkspaceIdentityBinding): string {
  const keyState = binding.identity.keyState
  if (!keyState) {
    return binding.identity.existsLocally ? 'No key history recorded yet' : 'No local key material'
  }

  const active = keyState.active ? '1 active key' : 'No active key'
  const revoked = keyState.revoked.length > 0 ? `${keyState.revoked.length} revoked` : '0 revoked'
  return `${active} · ${revoked}`
}

function createBindingPolicyDraft(binding: WorkspaceIdentityBinding): {
  externalInitiation: WorkspacePolicyRuleExternalInitiation
  allowedPartners: string
} {
  return {
    externalInitiation: binding.workspacePolicy.bindingRule?.externalInitiation ?? 'inherit',
    allowedPartners: binding.workspacePolicy.bindingRule?.allowedPartners.join(', ') ?? '',
  }
}

function credentialDownloadName(bundle: WorkspaceIdentityCredentialBundle): string {
  const safeBeamId = bundle.beamId.replace(/[^a-z0-9._-]+/gi, '-')
  return `${safeBeamId}.beam-identity.json`
}

function getIntentRules(intent: IntentCatalogItem | null): Record<string, NonNullable<IntentCatalogItem['params']>[string]> {
  if (!intent) {
    return {}
  }

  return (intent.params ?? intent.payload ?? {}) as Record<string, NonNullable<IntentCatalogItem['params']>[string]>
}

function buildIntentPayloadTemplate(intent: IntentCatalogItem | null): string {
  const rules = getIntentRules(intent)
  const payload: Record<string, unknown> = {}

  for (const [key, rule] of Object.entries(rules)) {
    if (rule.default !== undefined) {
      payload[key] = rule.default
      continue
    }

    switch (rule.type) {
      case 'integer':
      case 'number':
        payload[key] = rule.required ? 1 : 0
        break
      case 'boolean':
        payload[key] = rule.required ? true : false
        break
      case 'array':
        payload[key] = []
        break
      case 'object':
        payload[key] = {}
        break
      default:
        payload[key] = ''
        break
    }
  }

  if (intent?.id === 'conversation.message') {
    payload.message = typeof payload.message === 'string' ? payload.message : ''
    payload.language = typeof payload.language === 'string' && payload.language.length > 0 ? payload.language : 'en'
  }

  return JSON.stringify(payload, null, 2)
}

function parseJsonObjectInput(value: string, label: string): Record<string, unknown> | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object.`)
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof Error && err.message.includes(label)) {
      throw err
    }
    throw new Error(`${label} must be valid JSON.`)
  }
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
  if ((binding.runtime.connector ?? '').startsWith('openclaw')) {
    const sourceLabel = binding.runtime.connector === 'openclaw-workspace'
      ? 'OpenClaw workspace agent'
      : 'OpenClaw agent'
    const runtimeLabel = binding.runtime.label || binding.beamId
    return binding.runtime.deliveryMode
      ? `${sourceLabel} · ${runtimeLabel} · ${binding.runtime.deliveryMode}`
      : `${sourceLabel} · ${runtimeLabel}`
  }

  const label = binding.runtime.label
    ? (binding.runtime.connector ? `${binding.runtime.connector} · ${binding.runtime.label}` : binding.runtime.label)
    : binding.runtime.mode

  if (binding.runtime.deliveryMode) {
    return `${label} · ${binding.runtime.deliveryMode}`
  }

  return label
}

function renderBindingTransport(binding: WorkspaceIdentityBinding): string {
  if ((binding.runtime.connector ?? '').startsWith('openclaw')) {
    if (binding.runtime.connected && binding.runtime.httpEndpoint) {
      return 'Beam receiver live · HTTP fallback configured'
    }
    if (binding.runtime.connected) {
      return 'Beam receiver live'
    }
    if (binding.runtime.httpEndpoint) {
      return 'HTTP fallback configured'
    }
    return 'Imported into Beam, but no live OpenClaw receiver is connected'
  }

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

function renderBindingHostMeta(binding: WorkspaceIdentityBinding): string {
  if (!binding.hostId && binding.runtimeSessionState !== 'conflict') {
    return 'No host route attached'
  }

  const parts = [
    binding.hostLabel ? `Host ${binding.hostLabel}` : binding.hostId ? `Host ${binding.hostId}` : 'Multiple hosts',
  ]

  const sourceLabel = routeSourceLabel(binding.routeSource)
  if (sourceLabel) {
    parts.push(sourceLabel)
  }

  if (binding.runtimeSessionState) {
    parts.push(`Route ${binding.runtimeSessionState}`)
  }

  return parts.join(' · ')
}

function renderBindingLastDelivery(binding: WorkspaceIdentityBinding): string {
  if (!binding.lastDelivery) {
    return 'No delivery receipt yet'
  }

  const parts = [
    `Last delivery ${formatRelativeTime(binding.lastDelivery.requestedAt)}`,
    binding.lastDelivery.status,
  ]

  if (binding.lastDelivery.errorCode) {
    parts.push(binding.lastDelivery.errorCode)
  }

  return parts.join(' · ')
}

function renderChannelMeta(channel: WorkspacePartnerChannel): string {
  return [
    channel.workspaceRoute ? `Routes to ${channel.workspaceRoute.workspaceName}` : 'External lane',
    channel.owner ? `Owner ${channel.owner}` : 'No owner',
    channel.lastSuccessAt ? `Last success ${formatRelativeTime(channel.lastSuccessAt)}` : 'No successful handoff yet',
    channel.lastFailureAt ? `Last failure ${formatRelativeTime(channel.lastFailureAt)}` : 'No recent failures',
  ].join(' · ')
}

function renderPartnerChannelOptionLabel(channel: WorkspacePartnerChannel): string {
  if (channel.workspaceRoute) {
    return `${channel.workspaceRoute.workspaceName} · ${displayName(channel.workspaceRoute.displayName, channel.partnerBeamId)}`
  }

  return channel.label || channel.partnerBeamId
}

function sortPartnerChannelsForComposer(channels: WorkspacePartnerChannel[]): WorkspacePartnerChannel[] {
  return [...channels].sort((left, right) => {
    const leftRoute = left.workspaceRoute ? 0 : 1
    const rightRoute = right.workspaceRoute ? 0 : 1
    if (leftRoute !== rightRoute) {
      return leftRoute - rightRoute
    }

    const statusOrder = (value: WorkspacePartnerChannelStatus) => {
      switch (value) {
        case 'active':
          return 0
        case 'trial':
          return 1
        case 'blocked':
          return 2
        default:
          return 3
      }
    }

    const statusDelta = statusOrder(left.status) - statusOrder(right.status)
    if (statusDelta !== 0) {
      return statusDelta
    }

    return renderPartnerChannelOptionLabel(left).localeCompare(renderPartnerChannelOptionLabel(right))
  })
}

function isBindingApprovalItem(item: WorkspaceApprovalQueueItem): item is WorkspaceApprovalQueueBindingItem {
  return item.kind === 'binding'
}

function isThreadApprovalItem(item: WorkspaceApprovalQueueItem): item is WorkspaceApprovalQueueThreadItem {
  return item.kind === 'thread'
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
  const [approvalQueue, setApprovalQueue] = useState<WorkspaceApprovalQueueResponse | null>(null)
  const [bindings, setBindings] = useState<WorkspaceIdentityBinding[]>([])
  const [channels, setChannels] = useState<WorkspacePartnerChannel[]>([])
  const [threads, setThreads] = useState<WorkspaceThread[]>([])
  const [threadDetail, setThreadDetail] = useState<WorkspaceThreadDetailResponse | null>(null)
  const [policy, setPolicy] = useState<WorkspacePolicyResponse | null>(null)
  const [timeline, setTimeline] = useState<WorkspaceTimelineEntry[]>([])
  const [digest, setDigest] = useState<WorkspaceDigestResponse | null>(null)
  const [intentCatalog, setIntentCatalog] = useState<IntentCatalogItem[]>([FALLBACK_CONVERSATION_INTENT])
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
    owner: '',
    workflowType: '',
    draftIntentType: FALLBACK_CONVERSATION_INTENT.id,
    draftPayloadJson: buildIntentPayloadTemplate(FALLBACK_CONVERSATION_INTENT),
    localBindingId: '',
    partnerChannelId: '',
    linkedIntentNonce: '',
  })
  const [bindingPolicyDrafts, setBindingPolicyDrafts] = useState<Record<number, {
    externalInitiation: WorkspacePolicyRuleExternalInitiation
    allowedPartners: string
  }>>({})
  const [issuedCredential, setIssuedCredential] = useState<{
    bindingId: number
    bundle: WorkspaceIdentityCredentialBundle
  } | null>(null)
  const [selectedApprovalBindingIds, setSelectedApprovalBindingIds] = useState<number[]>([])

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
  const selectedHostFilter = searchParams.get('routeHost') ?? 'all'
  const localBindings = useMemo(
    () => bindings.filter((binding) => binding.bindingType !== 'partner'),
    [bindings],
  )
  const openClawBindings = useMemo(
    () => bindings.filter((binding) => (binding.runtime.connector ?? '').startsWith('openclaw')),
    [bindings],
  )
  const openClawLiveBindings = useMemo(
    () => openClawBindings.filter((binding) => binding.runtime.connected),
    [openClawBindings],
  )
  const openClawHostOptions = useMemo(() => {
    const options = new Map<string, { value: string; label: string }>()
    for (const binding of openClawBindings) {
      if (binding.hostId) {
        options.set(String(binding.hostId), {
          value: String(binding.hostId),
          label: binding.hostLabel || `Host ${binding.hostId}`,
        })
      }
      if (binding.runtimeSessionState === 'conflict') {
        options.set('conflict', {
          value: 'conflict',
          label: 'Conflicting hosts',
        })
      }
    }
    return [...options.values()].sort((left, right) => left.label.localeCompare(right.label))
  }, [openClawBindings])
  const visibleBindings = useMemo(() => {
    if (selectedHostFilter === 'all') {
      return bindings
    }
    if (selectedHostFilter === 'conflict') {
      return bindings.filter((binding) => binding.runtimeSessionState === 'conflict')
    }
    return bindings.filter((binding) => String(binding.hostId ?? '') === selectedHostFilter)
  }, [bindings, selectedHostFilter])
  const defaultHandoffIntentId = useMemo(
    () => intentCatalog.find((entry) => entry.id === 'conversation.message')?.id ?? intentCatalog[0]?.id ?? FALLBACK_CONVERSATION_INTENT.id,
    [intentCatalog],
  )
  const selectedIntent = useMemo(
    () => intentCatalog.find((entry) => entry.id === threadForm.draftIntentType)
      ?? intentCatalog.find((entry) => entry.id === defaultHandoffIntentId)
      ?? FALLBACK_CONVERSATION_INTENT,
    [defaultHandoffIntentId, intentCatalog, threadForm.draftIntentType],
  )
  const availableHandoffChannels = useMemo(
    () => sortPartnerChannelsForComposer(channels),
    [channels],
  )
  const selectedPartnerChannel = useMemo(
    () => channels.find((channel) => channel.id === Number.parseInt(threadForm.partnerChannelId, 10)) ?? null,
    [channels, threadForm.partnerChannelId],
  )
  const approvalBindingItems = useMemo(
    () => approvalQueue?.items.filter(isBindingApprovalItem) ?? [],
    [approvalQueue],
  )
  const selectedApprovalBindingItems = useMemo(
    () => approvalBindingItems.filter((item) => selectedApprovalBindingIds.includes(item.binding.id)),
    [approvalBindingItems, selectedApprovalBindingIds],
  )
  const threadDetailWorkspaceRoute = useMemo(() => {
    if (!threadDetail) {
      return null
    }

    const partnerBeamId = threadDetail.participants.find((participant) => participant.principalType === 'partner')?.beamId
    if (!partnerBeamId) {
      return null
    }

    return channels.find((channel) => channel.partnerBeamId === partnerBeamId)?.workspaceRoute ?? null
  }, [channels, threadDetail])

  useEffect(() => {
    setBindingPolicyDrafts((current) => {
      const next: typeof current = {}
      for (const binding of bindings) {
        next[binding.id] = current[binding.id] ?? createBindingPolicyDraft(binding)
      }
      return next
    })
  }, [bindings])

  async function loadWorkspaces() {
    const response = await directoryApi.listWorkspaces()
    setWorkspaces(response.workspaces)
  }

  async function loadIntentCatalog() {
    const response = await directoryApi.getIntentCatalog()
    const intents = response.intents.length > 0 ? response.intents : [FALLBACK_CONVERSATION_INTENT]
    setIntentCatalog(intents)
  }

  async function loadWorkspaceSurface(slug: string) {
    const [
      overviewResponse,
      approvalQueueResponse,
      identitiesResponse,
      partnerChannelsResponse,
      threadsResponse,
      policyResponse,
      timelineResponse,
      digestResponse,
    ] = await Promise.all([
      directoryApi.getWorkspaceOverview(slug),
      directoryApi.getWorkspaceApprovalQueue(slug),
      directoryApi.listWorkspaceIdentities(slug),
      directoryApi.listWorkspacePartnerChannels(slug),
      directoryApi.listWorkspaceThreads(slug),
      directoryApi.getWorkspacePolicy(slug),
      directoryApi.getWorkspaceTimeline(slug, 60),
      directoryApi.getWorkspaceDigest(slug, { days: 7 }),
    ])

    setOverview(overviewResponse)
    setApprovalQueue(approvalQueueResponse)
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
    void (async () => {
      try {
        await loadIntentCatalog()
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load intent catalog')
      }
    })()
  }, [])

  useEffect(() => {
    if (threadForm.kind !== 'handoff') {
      return
    }

    if (threadForm.draftIntentType && intentCatalog.some((entry) => entry.id === threadForm.draftIntentType)) {
      return
    }

    const nextIntent = intentCatalog.find((entry) => entry.id === defaultHandoffIntentId)
      ?? intentCatalog[0]
      ?? FALLBACK_CONVERSATION_INTENT
    setThreadForm((current) => ({
      ...current,
      draftIntentType: nextIntent.id,
      draftPayloadJson: buildIntentPayloadTemplate(nextIntent),
    }))
  }, [defaultHandoffIntentId, intentCatalog, threadForm.draftIntentType, threadForm.kind])

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
      setApprovalQueue(null)
      setBindings([])
      setChannels([])
      setThreads([])
      setThreadDetail(null)
      setPolicy(null)
      setTimeline([])
      setDigest(null)
      setSelectedApprovalBindingIds([])
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
    setSelectedApprovalBindingIds([])
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
          template: policy?.policy.metadata.template ?? null,
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

  function updateBindingPolicyDraft(
    bindingId: number,
    patch: Partial<{
      externalInitiation: WorkspacePolicyRuleExternalInitiation
      allowedPartners: string
    }>,
  ) {
    setBindingPolicyDrafts((current) => ({
      ...current,
      [bindingId]: {
        ...(current[bindingId] ?? {
          externalInitiation: 'inherit',
          allowedPartners: '',
        }),
        ...patch,
      },
    }))
  }

  async function handleBindingPolicySubmit(binding: WorkspaceIdentityBinding) {
    if (!selectedWorkspace) return
    const draft = bindingPolicyDrafts[binding.id] ?? createBindingPolicyDraft(binding)
    await runAction(`binding-policy-${binding.id}`, async () => {
      const response = await directoryApi.updateWorkspaceIdentityPolicy(selectedWorkspace.slug, binding.id, {
        externalInitiation: draft.externalInitiation,
        allowedPartners: parseCsvList(draft.allowedPartners),
      })
      setBindingPolicyDrafts((current) => ({
        ...current,
        [binding.id]: createBindingPolicyDraft(response.binding),
      }))
      await loadWorkspaceSurface(selectedWorkspace.slug)
    }, `${binding.beamId} policy updated.`)
  }

  async function handleReissueCredential(binding: WorkspaceIdentityBinding) {
    if (!selectedWorkspace) return
    await runAction(`binding-credential-${binding.id}`, async () => {
      const response = await directoryApi.reissueWorkspaceIdentityCredential(selectedWorkspace.slug, binding.id)
      setIssuedCredential({
        bindingId: binding.id,
        bundle: response.credential,
      })
      await loadWorkspaceSurface(selectedWorkspace.slug)
    }, `${binding.beamId} local credential reissued.`)
  }

  async function handleCopyCredential(bundle: WorkspaceIdentityCredentialBundle) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2))
      setNotice(`Credential bundle copied for ${bundle.beamId}.`)
    } catch {
      setError('Clipboard access failed while copying the credential bundle.')
    }
  }

  function handleDownloadCredential(bundle: WorkspaceIdentityCredentialBundle) {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = credentialDownloadName(bundle)
    anchor.click()
    URL.revokeObjectURL(url)
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
    const shouldPersistDraft = threadForm.kind === 'handoff' && linkedIntentNonce.length === 0
    const shouldDispatch = mode === 'dispatch' && threadForm.kind === 'handoff' && linkedIntentNonce.length === 0
    let createdThreadId: number | null = null

    let draftIntentType: string | null = null
    let draftPayload: Record<string, unknown> | null = null
    if (shouldPersistDraft) {
      draftIntentType = threadForm.draftIntentType.trim() || defaultHandoffIntentId
      try {
        draftPayload = parseJsonObjectInput(threadForm.draftPayloadJson, 'Intent payload')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Intent payload must be valid JSON.')
        return
      }

      if (!draftPayload) {
        setError('Intent payload is required for a blocked or directly dispatched handoff.')
        return
      }
    }

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
        draftIntentType: shouldPersistDraft ? draftIntentType : null,
        draftPayload: shouldPersistDraft ? draftPayload : null,
        linkedIntentNonce: linkedIntentNonce || null,
        status: threadForm.kind === 'handoff' && !linkedIntentNonce ? 'blocked' : 'open',
        participants,
      })

      createdThreadId = response.thread.id
      let activeThreadId = response.thread.id
      let noticeMessage = 'Workspace thread created.'
      if (shouldDispatch) {
        const dispatchResponse = await directoryApi.dispatchWorkspaceThread(selectedWorkspace.slug, response.thread.id, {
          intentType: draftIntentType,
          payload: draftPayload,
        })
        activeThreadId = dispatchResponse.thread.id
        noticeMessage = dispatchResponse.dispatch.success
          ? 'Workspace handoff dispatched through Beam.'
          : `Workspace handoff dispatched with a failed Beam response${dispatchResponse.dispatch.errorCode ? ` (${dispatchResponse.dispatch.errorCode})` : ''}.`
        if (dispatchResponse.workspaceSync) {
          noticeMessage += ` Synced to ${dispatchResponse.workspaceSync.workspaceName}.`
        }
      } else if (mode === 'dispatch' && linkedIntentNonce) {
        noticeMessage = 'Workspace thread linked to an existing Beam trace.'
      }

      await loadWorkspaceSurface(selectedWorkspace.slug)
      await loadThreadDetail(selectedWorkspace.slug, activeThreadId)
      setThreadForm({
        kind: 'internal',
        title: '',
        summary: '',
        owner: '',
        workflowType: '',
        draftIntentType: defaultHandoffIntentId,
        draftPayloadJson: buildIntentPayloadTemplate(intentCatalog.find((entry) => entry.id === defaultHandoffIntentId) ?? FALLBACK_CONVERSATION_INTENT),
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
      })
      await loadWorkspaceSurface(selectedWorkspace.slug)
      await loadThreadDetail(selectedWorkspace.slug, thread.id)
      setNotice(
        response.dispatch.success
          ? 'Workspace handoff dispatched through Beam.'
          : `Workspace handoff dispatched with a failed Beam response${response.dispatch.errorCode ? ` (${response.dispatch.errorCode})` : ''}.`,
      )
      if (response.workspaceSync) {
        const syncedWorkspaceName = response.workspaceSync.workspaceName
        setNotice((current) => `${current ?? 'Workspace handoff dispatched through Beam.'} Synced to ${syncedWorkspaceName}.`)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Workspace handoff dispatch failed')
    } finally {
      setActionBusy(null)
    }
  }

  function toggleApprovalBindingSelection(bindingId: number) {
    setSelectedApprovalBindingIds((current) => (
      current.includes(bindingId)
        ? current.filter((value) => value !== bindingId)
        : [...current, bindingId]
    ))
  }

  async function approveBindingExternalMotion(
    item: WorkspaceApprovalQueueBindingItem,
    options: {
      saveDefault?: boolean
      pauseInstead?: boolean
    } = {},
  ) {
    if (!selectedWorkspace) return

    const allowPartners = options.saveDefault ? item.suggestedAllowedPartners : []
    await runAction(`approval-binding-${item.binding.id}`, async () => {
      await directoryApi.updateWorkspaceIdentity(selectedWorkspace.slug, item.binding.id, {
        status: options.pauseInstead ? 'paused' : 'active',
        canInitiateExternal: options.pauseInstead ? false : true,
      })

      if (!options.pauseInstead && options.saveDefault) {
        await directoryApi.updateWorkspaceIdentityPolicy(selectedWorkspace.slug, item.binding.id, {
          externalInitiation: 'allow',
          allowedPartners: allowPartners,
        })
      }

      await loadWorkspaceSurface(selectedWorkspace.slug)
      setSelectedApprovalBindingIds((current) => current.filter((value) => value !== item.binding.id))
    }, options.pauseInstead
      ? `${item.binding.beamId} paused and removed from outbound approval.`
      : options.saveDefault
        ? `${item.binding.beamId} approved with partner-scoped defaults.`
        : `${item.binding.beamId} approved for outbound motion.`)
  }

  async function handleBulkBindingApproval(options: {
    saveDefault?: boolean
    pauseInstead?: boolean
  } = {}) {
    if (!selectedWorkspace || selectedApprovalBindingItems.length === 0) {
      return
    }

    await runAction(
      options.pauseInstead ? 'approval-bulk-pause' : options.saveDefault ? 'approval-bulk-default' : 'approval-bulk-approve',
      async () => {
        for (const item of selectedApprovalBindingItems) {
          await directoryApi.updateWorkspaceIdentity(selectedWorkspace.slug, item.binding.id, {
            status: options.pauseInstead ? 'paused' : 'active',
            canInitiateExternal: options.pauseInstead ? false : true,
          })
          if (!options.pauseInstead && options.saveDefault) {
            await directoryApi.updateWorkspaceIdentityPolicy(selectedWorkspace.slug, item.binding.id, {
              externalInitiation: 'allow',
              allowedPartners: item.suggestedAllowedPartners,
            })
          }
        }
        await loadWorkspaceSurface(selectedWorkspace.slug)
        setSelectedApprovalBindingIds([])
      },
      options.pauseInstead
        ? `${selectedApprovalBindingItems.length} bindings paused.`
        : options.saveDefault
          ? `${selectedApprovalBindingItems.length} bindings approved with known-channel defaults.`
          : `${selectedApprovalBindingItems.length} bindings approved for outbound motion.`,
    )
  }

  async function handleApprovalThreadDispatch(
    item: WorkspaceApprovalQueueThreadItem,
    options: {
      saveDefault?: boolean
    } = {},
  ) {
    if (!selectedWorkspace) return

    await runAction(`approval-thread-${item.thread.id}-${options.saveDefault ? 'default' : 'dispatch'}`, async () => {
      if (item.senderBinding) {
        await directoryApi.updateWorkspaceIdentity(selectedWorkspace.slug, item.senderBinding.id, {
          status: 'active',
          canInitiateExternal: true,
        })
        if (options.saveDefault) {
          await directoryApi.updateWorkspaceIdentityPolicy(selectedWorkspace.slug, item.senderBinding.id, {
            externalInitiation: 'allow',
            allowedPartners: item.suggestedAllowedPartners,
          })
        }
      }

      const response = await directoryApi.dispatchWorkspaceThread(selectedWorkspace.slug, item.thread.id, {})
      await loadWorkspaceSurface(selectedWorkspace.slug)
      await loadThreadDetail(selectedWorkspace.slug, item.thread.id)
      setNotice(
        response.workspaceSync
          ? `Workspace handoff dispatched and synced to ${response.workspaceSync.workspaceName}.`
          : 'Workspace handoff dispatched through Beam.',
      )
    }, options.saveDefault
      ? `${item.thread.title} approved, default saved, and dispatched.`
      : `${item.thread.title} approved and dispatched.`)
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

          <section className="panel">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="panel-title">Approval queue</div>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  Manual-review identities and blocked handoff threads in one place, with direct approve, dispatch, and save-default actions.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                  type="button"
                  disabled={selectedApprovalBindingItems.length === 0 || actionBusy === 'approval-bulk-approve'}
                  onClick={() => { void handleBulkBindingApproval() }}
                >
                  {actionBusy === 'approval-bulk-approve' ? 'Approving…' : 'Approve selected'}
                </button>
                <button
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                  type="button"
                  disabled={selectedApprovalBindingItems.length === 0 || actionBusy === 'approval-bulk-default'}
                  onClick={() => { void handleBulkBindingApproval({ saveDefault: true }) }}
                >
                  {actionBusy === 'approval-bulk-default' ? 'Saving…' : 'Approve for known channels'}
                </button>
                <button
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                  type="button"
                  disabled={selectedApprovalBindingItems.length === 0 || actionBusy === 'approval-bulk-pause'}
                  onClick={() => { void handleBulkBindingApproval({ pauseInstead: true }) }}
                >
                  {actionBusy === 'approval-bulk-pause' ? 'Pausing…' : 'Pause selected'}
                </button>
              </div>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-4">
              <MetricCard label="Queue items" value={!approvalQueue ? '—' : formatNumber(approvalQueue.summary.total)} tone={(approvalQueue?.summary.total ?? 0) > 0 ? 'warning' : 'default'} />
              <MetricCard label="Binding approvals" value={!approvalQueue ? '—' : formatNumber(approvalQueue.summary.bindingApprovals)} tone={(approvalQueue?.summary.bindingApprovals ?? 0) > 0 ? 'warning' : 'default'} />
              <MetricCard label="Thread approvals" value={!approvalQueue ? '—' : formatNumber(approvalQueue.summary.threadApprovals)} tone={(approvalQueue?.summary.threadApprovals ?? 0) > 0 ? 'critical' : 'default'} />
              <MetricCard label="Critical blockers" value={!approvalQueue ? '—' : formatNumber(approvalQueue.summary.critical)} tone={(approvalQueue?.summary.critical ?? 0) > 0 ? 'critical' : 'default'} />
            </div>

            <div className="mt-4 space-y-3">
              {!approvalQueue || approvalQueue.items.length === 0 ? (
                <EmptyPanel label="No approval work is waiting right now." />
              ) : (
                approvalQueue.items.map((item) => (
                  <div key={item.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.title}</div>
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          {item.owner ? `Owner ${item.owner}` : 'No owner'} · {item.nextAction}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusPill label={item.kind} />
                        <StatusPill label={item.severity} tone={approvalSeverityTone(item.severity)} />
                        {isThreadApprovalItem(item) ? (
                          <StatusPill
                            label={item.dispatchReady ? 'Dispatch ready' : 'Needs unblock'}
                            tone={item.dispatchReady ? 'success' : 'warning'}
                          />
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">{item.detail}</div>

                    {isBindingApprovalItem(item) ? (
                      <>
                        <div className="mt-3 grid gap-2 text-sm text-slate-600 dark:text-slate-300 md:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Binding</div>
                            <div>{displayName(item.binding.identity.displayName, item.binding.beamId)}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Lifecycle</div>
                            <div>{item.binding.lifecycleStatus}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Runtime</div>
                            <div>{renderBindingRuntime(item.binding)}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Suggested partners</div>
                            <div>{summarizeList(item.suggestedAllowedPartners, 'No known channels yet')}</div>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <label className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 dark:border-slate-800 dark:text-slate-200">
                            <input
                              checked={selectedApprovalBindingIds.includes(item.binding.id)}
                              onChange={() => { toggleApprovalBindingSelection(item.binding.id) }}
                              type="checkbox"
                            />
                            Select for bulk actions
                          </label>
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={actionBusy === `approval-binding-${item.binding.id}`}
                            onClick={() => { void approveBindingExternalMotion(item) }}
                          >
                            {actionBusy === `approval-binding-${item.binding.id}` ? 'Approving…' : 'Approve binding'}
                          </button>
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={item.suggestedAllowedPartners.length === 0 || actionBusy === `approval-binding-${item.binding.id}`}
                            onClick={() => { void approveBindingExternalMotion(item, { saveDefault: true }) }}
                          >
                            Save default
                          </button>
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={actionBusy === `approval-binding-${item.binding.id}`}
                            onClick={() => { void approveBindingExternalMotion(item, { pauseInstead: true }) }}
                          >
                            Pause binding
                          </button>
                          {item.href ? (
                            <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={item.href}>
                              Open workspace
                            </Link>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="mt-3 grid gap-2 text-sm text-slate-600 dark:text-slate-300 md:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Sender</div>
                            <div>{item.senderBinding ? displayName(item.senderBinding.identity.displayName, item.senderBinding.beamId) : 'Missing local sender'}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Partner lane</div>
                            <div>{item.partnerChannel ? renderPartnerChannelOptionLabel(item.partnerChannel) : 'No partner channel'}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Workflow</div>
                            <div>{item.thread.workflowType || item.thread.draftIntentType || 'Unspecified'}</div>
                          </div>
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Policy</div>
                            <div>{item.policyPreview ? `${item.policyPreview.externalInitiation} · ${item.policyPreview.approvalRequired ? 'approval path' : 'direct path'}` : 'No preview available'}</div>
                          </div>
                        </div>

                        {item.blockedReason ? (
                          <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                            {item.blockedReason}
                          </div>
                        ) : null}

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={!item.senderBinding || !item.partnerChannel || item.partnerChannel.status === 'blocked' || actionBusy === `approval-thread-${item.thread.id}-dispatch`}
                            onClick={() => { void handleApprovalThreadDispatch(item) }}
                          >
                            {actionBusy === `approval-thread-${item.thread.id}-dispatch` ? 'Sending…' : 'Approve and send'}
                          </button>
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={!item.senderBinding || item.suggestedAllowedPartners.length === 0 || actionBusy === `approval-thread-${item.thread.id}-default`}
                            onClick={() => { void handleApprovalThreadDispatch(item, { saveDefault: true }) }}
                          >
                            {actionBusy === `approval-thread-${item.thread.id}-default` ? 'Saving…' : 'Save default and send'}
                          </button>
                          {item.href ? (
                            <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={item.href}>
                              Open thread
                            </Link>
                          ) : null}
                          {item.thread.trace?.href ? (
                            <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={item.thread.trace.href}>
                              Open trace
                            </Link>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
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

              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-6">
                <MetricCard label="Local identities" value={!overview ? '—' : formatNumber(overview.summary.localIdentities)} />
                <MetricCard label="Partner identities" value={!overview ? '—' : formatNumber(overview.summary.partnerIdentities)} />
                <MetricCard label="OpenClaw identities" value={formatNumber(openClawBindings.length)} tone={openClawBindings.length > 0 ? 'success' : 'default'} />
                <MetricCard label="Beam receiver live" value={formatNumber(openClawLiveBindings.length)} tone={openClawLiveBindings.length > 0 ? 'success' : 'warning'} hint={openClawBindings.length > 0 ? `${formatNumber(openClawBindings.length)} imported` : 'No OpenClaw bindings yet'} />
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
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="input-field min-w-[12rem] text-sm"
                    value={selectedHostFilter}
                    onChange={(event) => {
                      const next = new URLSearchParams(searchParams)
                      if (event.target.value === 'all') {
                        next.delete('routeHost')
                      } else {
                        next.set('routeHost', event.target.value)
                      }
                      setSearchParams(next, { replace: true })
                    }}
                  >
                    <option value="all">All bindings</option>
                    {openClawHostOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{formatNumber(visibleBindings.length)} shown</div>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {visibleBindings.length === 0 ? (
                  <EmptyPanel label="No workspace bindings exist yet." />
                ) : (
                  visibleBindings.map((binding) => (
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
                          {binding.hostLabel || binding.runtimeSessionState === 'conflict' ? (
                            <StatusPill label={binding.hostLabel || 'Conflicting hosts'} tone={hostHealthTone(binding.hostHealth)} />
                          ) : null}
                          {binding.runtimeSessionState ? (
                            <StatusPill label={binding.runtimeSessionState} tone={routeRuntimeTone(binding.runtimeSessionState)} />
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                        <div>{binding.owner ? `Owner ${binding.owner}` : 'No owner assigned'}</div>
                        <div>{renderBindingRuntime(binding)}</div>
                        <div>{binding.identity.lastSeen ? `Last seen ${formatRelativeTime(binding.identity.lastSeen)}` : 'No heartbeat recorded'}</div>
                        <div>{binding.canInitiateExternal ? 'Can initiate external' : 'Manual review required'}</div>
                        <div>{renderBindingTransport(binding)}</div>
                        <div>{binding.identity.capabilities.length > 0 ? `${binding.identity.capabilities.length} capabilities declared` : 'No capabilities declared'}</div>
                        <div>{renderBindingHostMeta(binding)}</div>
                        <div>{binding.hostHealth ? `Host health ${binding.hostHealth}` : 'No host health reported'}</div>
                        <div>{renderBindingLastDelivery(binding)}</div>
                        <div>{binding.lastDelivery?.latencyMs != null ? `Last latency ${formatLatency(binding.lastDelivery.latencyMs)}` : 'No delivery latency recorded'}</div>
                      </div>

                      <div className="mt-3 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Beam DID</div>
                            <div className="mt-1 truncate font-mono text-xs text-slate-700 dark:text-slate-200">{binding.identity.did.id}</div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <StatusPill
                              label={binding.workspacePolicy.effective.externalInitiation === 'allow' ? 'Outbound allowed' : 'Outbound blocked'}
                              tone={binding.workspacePolicy.effective.externalInitiation === 'allow' ? 'success' : 'warning'}
                            />
                            <StatusPill
                              label={binding.workspacePolicy.effective.approvalRequired ? 'Approval path' : 'Direct path'}
                              tone={binding.workspacePolicy.effective.approvalRequired ? 'warning' : 'success'}
                            />
                          </div>
                        </div>

                        <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                          <div>{summarizeKeyState(binding)}</div>
                          <div>{summarizeList(binding.workspacePolicy.effective.allowedPartners, 'No partner allowlist override')}</div>
                          <div>{binding.workspacePolicy.bindingRule ? 'Per-agent policy override active' : 'Inheriting workspace defaults'}</div>
                          <div>{binding.workspacePolicy.effective.approvalRequired ? `Approvers: ${summarizeList(binding.workspacePolicy.effective.approvers, 'Not listed')}` : 'No workflow approvers attached here'}</div>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-3 text-xs">
                          <a className="text-orange-600 hover:text-orange-700 dark:text-orange-300" href={binding.identity.did.resolutionUrl} rel="noreferrer" target="_blank">
                            Resolve DID
                          </a>
                          <a className="text-orange-600 hover:text-orange-700 dark:text-orange-300" href={binding.identity.did.keysUrl} rel="noreferrer" target="_blank">
                            Open key history
                          </a>
                          {binding.identity.existsLocally ? (
                            <a className="text-orange-600 hover:text-orange-700 dark:text-orange-300" href={binding.identity.did.agentUrl} rel="noreferrer" target="_blank">
                              Open agent record
                            </a>
                          ) : null}
                          {binding.lastDelivery ? (
                            <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={binding.lastDelivery.href}>
                              Open last trace
                            </Link>
                          ) : null}
                        </div>
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
                        {binding.runtimeSessionState === 'conflict' ? (
                          <Link className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-orange-600 transition hover:bg-slate-100 dark:border-slate-800 dark:text-orange-300 dark:hover:bg-slate-800" to={`/openclaw-fleet?conflict=${encodeURIComponent(binding.beamId)}`}>
                            Resolve in fleet
                          </Link>
                        ) : null}
                        {binding.bindingType !== 'partner' && binding.identity.existsLocally ? (
                          <button
                            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                            type="button"
                            disabled={actionBusy === `binding-credential-${binding.id}`}
                            onClick={() => { void handleReissueCredential(binding) }}
                          >
                            {actionBusy === `binding-credential-${binding.id}` ? 'Issuing…' : 'Reissue local credential'}
                          </button>
                        ) : null}
                      </div>

                      {binding.bindingType !== 'partner' ? (
                        <div className="mt-4 rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Per-agent partner control</div>
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            Keep workspace defaults, or attach an explicit outbound override for this identity only.
                          </div>
                          <div className="mt-3 grid gap-3 md:grid-cols-2">
                            <select
                              className="input-field"
                              value={(bindingPolicyDrafts[binding.id] ?? createBindingPolicyDraft(binding)).externalInitiation}
                              onChange={(event) => updateBindingPolicyDraft(binding.id, {
                                externalInitiation: event.target.value as WorkspacePolicyRuleExternalInitiation,
                              })}
                            >
                              <option value="inherit">inherit workspace default</option>
                              <option value="allow">allow outbound</option>
                              <option value="deny">deny outbound</option>
                            </select>
                            <input
                              className="input-field"
                              placeholder="finance@northwind.beam.directory, *@partner.beam.directory"
                              value={(bindingPolicyDrafts[binding.id] ?? createBindingPolicyDraft(binding)).allowedPartners}
                              onChange={(event) => updateBindingPolicyDraft(binding.id, {
                                allowedPartners: event.target.value,
                              })}
                            />
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                              type="button"
                              disabled={actionBusy === `binding-policy-${binding.id}`}
                              onClick={() => { void handleBindingPolicySubmit(binding) }}
                            >
                              {actionBusy === `binding-policy-${binding.id}` ? 'Saving…' : 'Save agent policy'}
                            </button>
                            <button
                              className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                              type="button"
                              onClick={() => {
                                setBindingPolicyDrafts((current) => ({
                                  ...current,
                                  [binding.id]: createBindingPolicyDraft(binding),
                                }))
                              }}
                            >
                              Reset form
                            </button>
                          </div>
                        </div>
                      ) : null}

                      {issuedCredential?.bindingId === binding.id ? (
                        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 dark:border-emerald-500/20 dark:bg-emerald-500/10">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">One-time local credential bundle</div>
                              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                                Copy or download this now. The API key is only returned at issuance time.
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-white dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                                type="button"
                                onClick={() => { void handleCopyCredential(issuedCredential.bundle) }}
                              >
                                Copy JSON
                              </button>
                              <button
                                className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-white dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                                type="button"
                                onClick={() => { handleDownloadCredential(issuedCredential.bundle) }}
                              >
                                Download
                              </button>
                            </div>
                          </div>
                          <textarea
                            className="input-field mt-3 min-h-56 font-mono text-xs"
                            readOnly
                            value={JSON.stringify(issuedCredential.bundle, null, 2)}
                          />
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

                      {channel.workspaceRoute ? (
                        <div className="mt-3 rounded-2xl border border-orange-200 bg-orange-50/70 px-4 py-3 text-sm text-slate-700 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-slate-200">
                          <div className="font-medium text-slate-900 dark:text-slate-100">Local workspace route</div>
                          <div className="mt-1">
                            {channel.workspaceRoute.workspaceName} · {displayName(channel.workspaceRoute.displayName, channel.partnerBeamId)}
                          </div>
                          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                            {channel.workspaceRoute.runtime.label || channel.workspaceRoute.runtime.mode}
                            {channel.workspaceRoute.runtime.deliveryMode ? ` · ${channel.workspaceRoute.runtime.deliveryMode}` : ''}
                            {channel.workspaceRoute.bindingStatus !== 'active' ? ` · binding ${channel.workspaceRoute.bindingStatus}` : ''}
                          </div>
                        </div>
                      ) : null}

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
                        {channel.workspaceRoute ? (
                          <Link className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-orange-600 transition hover:bg-slate-100 dark:border-slate-800 dark:text-orange-300 dark:hover:bg-slate-800" to={`/workspaces?workspace=${encodeURIComponent(channel.workspaceRoute.workspaceSlug)}`}>
                            Open target workspace
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
                <select
                  className="input-field"
                  value={threadForm.kind}
                  onChange={(event) => {
                    const nextKind = event.target.value as WorkspaceThreadKind
                    setThreadForm((current) => ({
                      ...current,
                      kind: nextKind,
                      ...(nextKind === 'handoff'
                        ? {
                            draftIntentType: current.draftIntentType || defaultHandoffIntentId,
                            draftPayloadJson: current.draftPayloadJson || buildIntentPayloadTemplate(selectedIntent),
                          }
                        : {}),
                    }))
                  }}
                >
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
                      {availableHandoffChannels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {renderPartnerChannelOptionLabel(channel)}
                          {channel.status !== 'active' ? ` (${channel.status})` : ''}
                        </option>
                      ))}
                    </select>
                    <select
                      className="input-field"
                      value={threadForm.draftIntentType}
                      onChange={(event) => {
                        const nextIntent = intentCatalog.find((entry) => entry.id === event.target.value) ?? FALLBACK_CONVERSATION_INTENT
                        setThreadForm((current) => ({
                          ...current,
                          draftIntentType: nextIntent.id,
                          draftPayloadJson: buildIntentPayloadTemplate(nextIntent),
                        }))
                      }}
                    >
                      {intentCatalog.map((intent) => (
                        <option key={intent.id} value={intent.id}>
                          {intent.id}
                        </option>
                      ))}
                    </select>
                    {selectedPartnerChannel ? (
                      <div className="md:col-span-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {selectedPartnerChannel.workspaceRoute ? 'Cross-workspace target' : 'External partner target'}
                        </div>
                        <div className="mt-1">
                          {selectedPartnerChannel.workspaceRoute
                            ? `${selectedPartnerChannel.workspaceRoute.workspaceName} · ${displayName(selectedPartnerChannel.workspaceRoute.displayName, selectedPartnerChannel.partnerBeamId)}`
                            : `${selectedPartnerChannel.label || displayName(selectedPartnerChannel.partner.displayName, selectedPartnerChannel.partnerBeamId)} · ${selectedPartnerChannel.partnerBeamId}`}
                        </div>
                        <div className="mt-2 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-3">
                          <div>Channel {selectedPartnerChannel.status}</div>
                          <div>Health {selectedPartnerChannel.healthStatus}</div>
                          <div>
                            {selectedPartnerChannel.workspaceRoute
                              ? `${selectedPartnerChannel.workspaceRoute.runtime.label || selectedPartnerChannel.workspaceRoute.runtime.mode} · ${selectedPartnerChannel.workspaceRoute.runtime.deliveryMode || 'manual'}`
                              : 'Partner-side runtime managed externally'}
                          </div>
                        </div>
                        {selectedPartnerChannel.workspaceRoute ? (
                          <div className="mt-3">
                            <Link className="text-sm text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/workspaces?workspace=${encodeURIComponent(selectedPartnerChannel.workspaceRoute.workspaceSlug)}`}>
                              Open target workspace
                            </Link>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="md:col-span-2 rounded-2xl border border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{selectedIntent.id}</div>
                      <div className="mt-1">{selectedIntent.description || 'No catalog description is available for this intent yet.'}</div>
                      <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                        Fields: {Object.keys(getIntentRules(selectedIntent)).length > 0 ? Object.keys(getIntentRules(selectedIntent)).join(', ') : 'No schema fields declared'}
                      </div>
                    </div>
                    <textarea
                      className="input-field md:col-span-2 min-h-48 font-mono text-xs"
                      placeholder="Structured JSON payload"
                      value={threadForm.draftPayloadJson}
                      onChange={(event) => setThreadForm((current) => ({ ...current, draftPayloadJson: event.target.value }))}
                    />
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
                      disabled={
                        actionBusy === 'thread-composer-create'
                        || actionBusy === 'thread-composer-dispatch'
                        || !threadForm.partnerChannelId
                        || !threadForm.localBindingId
                        || selectedPartnerChannel?.status === 'blocked'
                      }
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
                    Handoff threads can stay blocked for review, link to an existing nonce, or send a catalog-backed Beam intent directly from this workspace surface. Cross-workspace routes now resolve local target workspaces when a partner channel points at another Beam-controlled identity.
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
                          <div>{thread.draftIntentType ? `Draft intent ${thread.draftIntentType}` : thread.trace ? `Trace intent ${thread.trace.intentType}` : 'No Beam draft yet'}</div>
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
                        <div>
                          <div className="text-xs uppercase tracking-wide text-slate-400">Draft intent</div>
                          <div>{threadDetail.thread.draftIntentType || 'No draft intent stored'}</div>
                        </div>
                        {threadDetailWorkspaceRoute ? (
                          <div>
                            <div className="text-xs uppercase tracking-wide text-slate-400">Target workspace</div>
                            <div>{threadDetailWorkspaceRoute.workspaceName}</div>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {threadDetail.thread.draftPayload ? (
                      <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Draft payload</div>
                        <pre className="mt-3 overflow-x-auto rounded-2xl bg-slate-950/95 p-4 text-xs leading-6 text-slate-100">
                          {JSON.stringify(threadDetail.thread.draftPayload, null, 2)}
                        </pre>
                      </div>
                    ) : null}

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
                            This thread is still internal or blocked. You can now approve and send a blocked handoff directly from the workspace control plane with its stored draft intent and payload; once Beam accepts it, the full trace appears here.
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

              {policy?.policy.metadata.template ? (
                <div className="mt-4 grid gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-100">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill label={policy.policy.metadata.template.templateLabel ?? policy.policy.metadata.template.templateKey ?? 'template'} tone="success" />
                    {policy.policy.metadata.template.policyPackLabel ? (
                      <StatusPill label={`pack:${policy.policy.metadata.template.policyPackLabel}`} tone="default" />
                    ) : null}
                    {policy.policy.metadata.template.hostGroupLabel ? (
                      <StatusPill label={`group:${policy.policy.metadata.template.hostGroupLabel}`} tone="default" />
                    ) : null}
                  </div>
                  <div className="grid gap-2 text-xs text-emerald-900/80 dark:text-emerald-100/80 md:grid-cols-2">
                    <div>{`Template key ${policy.policy.metadata.template.templateKey ?? '—'}`}</div>
                    <div>{`Policy pack ${policy.policy.metadata.template.policyPackKey ?? '—'}`}</div>
                    <div>{policy.policy.metadata.template.appliedAt ? `Applied ${formatDateTime(policy.policy.metadata.template.appliedAt)}` : 'Applied time unavailable'}</div>
                    <div>{policy.policy.metadata.template.appliedBy ? `Applied by ${policy.policy.metadata.template.appliedBy}` : 'Applied by unknown operator'}</div>
                  </div>
                </div>
              ) : null}

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
