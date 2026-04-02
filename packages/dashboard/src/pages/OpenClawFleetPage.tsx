import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import {
  ApiError,
  type OpenClawConflictDetailResponse,
  directoryApi,
  type OpenClawConflictGroup,
  type OpenClawFleetBulkActionInput,
  type OpenClawFleetDigestResponse,
  type OpenClawFleetEnvironmentSummary,
  type OpenClawEnrollmentCreateInput,
  type OpenClawFleetOverviewResponse,
  type OpenClawFleetHostGroupSummary,
  type OpenClawHostDetailResponse,
  type OpenClawHostHealth,
  type OpenClawHostIdentitiesResponse,
  type OpenClawInstallPack,
  type OpenClawHostRoute,
  type OpenClawHostSummary,
  type OpenClawHostStatus,
  type OpenClawHostCredentialState,
  type OpenClawHostProfilePatchInput,
  type OpenClawHostPolicyPatchInput,
  type OpenClawHostRecoveryRunbookState,
  type OpenClawRouteRuntimeState,
  type OpenClawRouteOwnerResolutionState,
  type OpenClawRouteSource,
} from '../lib/api'
import { formatDateTime, formatNumber, formatRelativeTime } from '../lib/utils'

function hostStatusTone(status: OpenClawHostStatus): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'active':
      return 'success'
    case 'pending':
      return 'warning'
    case 'revoked':
      return 'critical'
    default:
      return 'default'
  }
}

function hostHealthTone(status: OpenClawHostHealth): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'healthy':
      return 'success'
    case 'watch':
    case 'pending':
      return 'warning'
    case 'stale':
    case 'revoked':
      return 'critical'
    default:
      return 'default'
  }
}

function routeStateTone(status: OpenClawRouteRuntimeState): 'default' | 'success' | 'warning' | 'critical' {
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

function credentialStateTone(status: OpenClawHostCredentialState): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'ready':
      return 'success'
    case 'rotation_pending':
    case 'recovery_pending':
      return 'warning'
    case 'revoked':
      return 'critical'
    default:
      return 'default'
  }
}

function ownerResolutionTone(status: OpenClawRouteOwnerResolutionState): 'default' | 'success' | 'warning' | 'critical' {
  switch (status) {
    case 'preferred':
      return 'success'
    case 'disabled':
      return 'critical'
    default:
      return 'default'
  }
}

function routeSourceLabel(source: OpenClawRouteSource): string {
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
      return source
  }
}

function hostTitle(host: OpenClawHostSummary): string {
  return host.label || host.hostname
}

function hostMeta(host: OpenClawHostSummary): string {
  return [
    host.hostname,
    host.os,
    host.connectorVersion,
    host.workspaceSlug ? `Workspace ${host.workspaceSlug}` : 'No workspace default',
    host.lastHeartbeatAt ? `Heartbeat ${formatRelativeTime(host.lastHeartbeatAt)}` : 'No heartbeat yet',
  ].join(' · ')
}

function hostEnvironmentLabel(host: OpenClawHostSummary): string {
  return host.placement.environmentLabel ?? 'unassigned'
}

function hostGroupLabels(host: OpenClawHostSummary): string[] {
  return host.placement.groupLabels ?? []
}

function conflictSummary(group: OpenClawConflictGroup): string {
  return `${group.routeCount} active host routes claim ${group.beamId}`
}

function digestSeverityTone(severity: 'warning' | 'critical'): 'warning' | 'critical' {
  return severity === 'critical' ? 'critical' : 'warning'
}

function conflictResolutionTone(state: OpenClawConflictDetailResponse['resolutionState']): 'warning' | 'success' {
  return state === 'owner_selected' ? 'success' : 'warning'
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

function formatLatency(value: number | null): string {
  return value === null ? '—' : `${formatNumber(value)} ms`
}

function toDateTimeLocalValue(value: string | null): string {
  if (!value) {
    return ''
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return ''
  }
  const localMs = parsed.getTime() - (parsed.getTimezoneOffset() * 60_000)
  return new Date(localMs).toISOString().slice(0, 16)
}

function fromDateTimeLocalValue(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function parseCommaSeparatedLabels(value: string): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const part of value.split(',')) {
    const trimmed = part.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    labels.push(trimmed)
  }
  return labels
}

type HostPolicyFormState = {
  rotationIntervalHours: string
  rotationWindowStartHour: string
  rotationWindowDurationHours: string
  recoveryOwner: string
  recoveryStatus: OpenClawHostRecoveryRunbookState
  recoveryNotes: string
  replacementHostLabel: string
  recoveryWindowStartsAt: string
  recoveryWindowEndsAt: string
}

type HostPlacementFormState = {
  environmentLabel: string
  groupLabels: string
  owner: string
}

type FleetBulkMode = 'labels' | 'stage_revoke_review' | 'clear_revoke_review' | null

export default function OpenClawFleetPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [overview, setOverview] = useState<OpenClawFleetOverviewResponse | null>(null)
  const [digest, setDigest] = useState<OpenClawFleetDigestResponse | null>(null)
  const [conflictDetail, setConflictDetail] = useState<OpenClawConflictDetailResponse | null>(null)
  const [hostDetail, setHostDetail] = useState<OpenClawHostDetailResponse | null>(null)
  const [hostIdentities, setHostIdentities] = useState<OpenClawHostIdentitiesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [credentialResult, setCredentialResult] = useState<{
    hostLabel: string
    credential: string
    commands: {
      useCredential: string
      foregroundDebug: string
    }
  } | null>(null)
  const [enrollmentResult, setEnrollmentResult] = useState<{
    token: string
    label: string | null
    workspaceSlug: string | null
    expiresAt: string | null
    installPack: OpenClawInstallPack | null
  } | null>(null)
  const [enrollmentForm, setEnrollmentForm] = useState<OpenClawEnrollmentCreateInput>({
    label: '',
    workspaceSlug: '',
    notes: '',
    expiresInHours: 72,
  })
  const [policyForm, setPolicyForm] = useState<HostPolicyFormState>({
    rotationIntervalHours: '720',
    rotationWindowStartHour: '2',
    rotationWindowDurationHours: '4',
    recoveryOwner: '',
    recoveryStatus: 'idle',
    recoveryNotes: '',
    replacementHostLabel: '',
    recoveryWindowStartsAt: '',
    recoveryWindowEndsAt: '',
  })
  const [placementForm, setPlacementForm] = useState<HostPlacementFormState>({
    environmentLabel: '',
    groupLabels: '',
    owner: '',
  })
  const [selectedHostIds, setSelectedHostIds] = useState<number[]>([])
  const [bulkMode, setBulkMode] = useState<FleetBulkMode>(null)
  const [bulkForm, setBulkForm] = useState({
    environmentLabel: '',
    groupLabels: '',
    owner: '',
    reason: '',
    confirmPhrase: '',
  })
  const [selectedConflictRouteId, setSelectedConflictRouteId] = useState<number | null>(null)

  const selectedHostId = useMemo(() => {
    const raw = searchParams.get('host')
    if (!raw) return null
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [searchParams])

  const selectedEnvironment = useMemo(() => {
    const raw = searchParams.get('environment')
    return raw && raw.trim() ? raw.trim() : 'all'
  }, [searchParams])

  const selectedGroup = useMemo(() => {
    const raw = searchParams.get('group')
    return raw && raw.trim() ? raw.trim() : 'all'
  }, [searchParams])

  const selectedConflictBeamId = useMemo(() => {
    const raw = searchParams.get('conflict')
    return raw ? raw.trim() || null : null
  }, [searchParams])

  const visibleHosts = useMemo(() => {
    const hosts = overview?.hosts ?? []
    return hosts.filter((host) => {
      const matchesEnvironment = selectedEnvironment === 'all' || hostEnvironmentLabel(host) === selectedEnvironment
      const matchesGroup = selectedGroup === 'all' || hostGroupLabels(host).includes(selectedGroup)
      return matchesEnvironment && matchesGroup
    })
  }, [overview?.hosts, selectedEnvironment, selectedGroup])

  const environmentOptions = useMemo(() => overview?.environments ?? [], [overview?.environments])
  const hostGroupOptions = useMemo(() => overview?.hostGroups ?? [], [overview?.hostGroups])

  const selectedHost = useMemo(
    () => visibleHosts.find((host) => host.id === selectedHostId) ?? visibleHosts[0] ?? null,
    [visibleHosts, selectedHostId],
  )

  const selectedBulkHosts = useMemo(
    () => visibleHosts.filter((host) => selectedHostIds.includes(host.id)),
    [visibleHosts, selectedHostIds],
  )

  const selectedBulkHostsWithRevokeReview = useMemo(
    () => selectedBulkHosts.filter((host) => Boolean(host.placement.revokeReviewRequestedAt)),
    [selectedBulkHosts],
  )

  const selectedConflictRoute = useMemo(
    () => conflictDetail?.routes.find((route) => route.id === selectedConflictRouteId) ?? null,
    [conflictDetail, selectedConflictRouteId],
  )

  async function loadOverview() {
    const response = await directoryApi.getOpenClawFleetOverview()
    setOverview(response)
  }

  async function loadDigest() {
    const response = await directoryApi.getOpenClawFleetDigest()
    setDigest(response)
  }

  async function loadConflict(beamId: string) {
    const response = await directoryApi.getOpenClawConflict(beamId)
    setConflictDetail(response)
  }

  async function loadHost(id: number) {
    const [detailResponse, identitiesResponse] = await Promise.all([
      directoryApi.getOpenClawHost(id),
      directoryApi.getOpenClawHostIdentities(id),
    ])
    setHostDetail(detailResponse)
    setHostIdentities(identitiesResponse)
  }

  async function refreshAll(nextHostId?: number | null, nextConflictBeamId?: string | null) {
    try {
      setLoading(true)
      setError(null)
      await Promise.all([loadOverview(), loadDigest()])
      const hostId = nextHostId ?? selectedHostId
      const conflictBeamId = nextConflictBeamId ?? selectedConflictBeamId
      if (hostId) {
        await loadHost(hostId)
      }
      if (conflictBeamId) {
        await loadConflict(conflictBeamId)
      } else {
        setConflictDetail(null)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load OpenClaw fleet')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshAll()
  }, [])

  useEffect(() => {
    if (!visibleHosts.length) {
      setHostDetail(null)
      setHostIdentities(null)
      return
    }

    const nextHost = visibleHosts.find((host) => host.id === selectedHostId) ?? visibleHosts[0]
    if (!nextHost) {
      return
    }

    if (selectedHostId !== nextHost.id) {
      const nextParams = new URLSearchParams(searchParams)
      nextParams.set('host', String(nextHost.id))
      setSearchParams(nextParams, { replace: true })
      return
    }

    void (async () => {
      try {
        setDetailLoading(true)
        setError(null)
        await loadHost(nextHost.id)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load host detail')
      } finally {
        setDetailLoading(false)
      }
    })()
  }, [visibleHosts, searchParams, selectedHostId, setSearchParams])

  useEffect(() => {
    const visibleHostIds = new Set(visibleHosts.map((host) => host.id))
    setSelectedHostIds((current) => current.filter((hostId) => visibleHostIds.has(hostId)))
  }, [visibleHosts])

  useEffect(() => {
    if (!selectedConflictBeamId) {
      setConflictDetail(null)
      setSelectedConflictRouteId(null)
      return
    }

    void (async () => {
      try {
        setDetailLoading(true)
        setError(null)
        await loadConflict(selectedConflictBeamId)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load conflict detail')
      } finally {
        setDetailLoading(false)
      }
    })()
  }, [selectedConflictBeamId])

  useEffect(() => {
    if (!conflictDetail) {
      setSelectedConflictRouteId(null)
      return
    }
    setSelectedConflictRouteId(conflictDetail.selectedOwnerRouteId ?? conflictDetail.recommendedRouteId ?? conflictDetail.routes[0]?.id ?? null)
  }, [conflictDetail?.beamId, conflictDetail?.selectedOwnerRouteId, conflictDetail?.recommendedRouteId, conflictDetail?.routes.length])

  useEffect(() => {
    if (!selectedHost) {
      return
    }

    setPolicyForm({
      rotationIntervalHours: String(selectedHost.policy.rotation.intervalHours),
      rotationWindowStartHour: String(selectedHost.policy.rotation.windowStartHour),
      rotationWindowDurationHours: String(selectedHost.policy.rotation.windowDurationHours),
      recoveryOwner: selectedHost.policy.recovery.owner ?? '',
      recoveryStatus: selectedHost.policy.recovery.status,
      recoveryNotes: selectedHost.policy.recovery.notes ?? '',
      replacementHostLabel: selectedHost.policy.recovery.replacementHostLabel ?? '',
      recoveryWindowStartsAt: toDateTimeLocalValue(selectedHost.policy.recovery.windowStartsAt),
      recoveryWindowEndsAt: toDateTimeLocalValue(selectedHost.policy.recovery.windowEndsAt),
    })
    setPlacementForm({
      environmentLabel: selectedHost.placement.environmentLabel ?? '',
      groupLabels: hostGroupLabels(selectedHost).join(', '),
      owner: selectedHost.placement.owner ?? '',
    })
  }, [selectedHost?.id, selectedHost?.updatedAt])

  async function runAction(actionKey: string, fn: () => Promise<void>, successMessage: string) {
    try {
      setActionBusy(actionKey)
      setError(null)
      setNotice(null)
      await fn()
      setNotice(successMessage)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'OpenClaw fleet action failed')
    } finally {
      setActionBusy(null)
    }
  }

  function updateFleetQueryParam(key: 'environment' | 'group', value: string) {
    const next = new URLSearchParams(searchParams)
    if (!value || value === 'all') {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    next.delete('host')
    setSearchParams(next, { replace: true })
  }

  function toggleHostSelection(hostId: number, checked: boolean) {
    setSelectedHostIds((current) => {
      if (checked) {
        return current.includes(hostId) ? current : [...current, hostId]
      }
      return current.filter((id) => id !== hostId)
    })
  }

  function setAllVisibleHostsSelected(checked: boolean) {
    setSelectedHostIds(checked ? visibleHosts.map((host) => host.id) : [])
  }

  async function handleCreateEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAction('create-enrollment', async () => {
      const response = await directoryApi.createOpenClawEnrollment({
        label: typeof enrollmentForm.label === 'string' && enrollmentForm.label.trim() ? enrollmentForm.label.trim() : null,
        workspaceSlug: typeof enrollmentForm.workspaceSlug === 'string' && enrollmentForm.workspaceSlug.trim() ? enrollmentForm.workspaceSlug.trim() : null,
        notes: typeof enrollmentForm.notes === 'string' && enrollmentForm.notes.trim() ? enrollmentForm.notes.trim() : null,
        expiresInHours: typeof enrollmentForm.expiresInHours === 'number' ? enrollmentForm.expiresInHours : 72,
      })
      setEnrollmentResult({
        token: response.enrollment.token ?? '',
        label: response.enrollment.label,
        workspaceSlug: response.enrollment.workspaceSlug,
        expiresAt: response.enrollment.expiresAt,
        installPack: response.enrollment.installPack ?? null,
      })
      await Promise.all([loadOverview(), loadDigest()])
    }, 'Enrollment token issued.')
  }

  async function handleApprove(host: OpenClawHostSummary) {
    await runAction(`approve-${host.id}`, async () => {
      const response = await directoryApi.approveOpenClawHost(host.id)
      setCredentialResult(null)
      setNotice(`Host ${hostTitle(response.host)} approved. Credential issued.`)
      await Promise.all([loadOverview(), loadDigest()])
      await loadHost(host.id)
    }, `Host ${hostTitle(host)} approved.`)
  }

  async function handleRotate(host: OpenClawHostSummary) {
    await runAction(`rotate-${host.id}`, async () => {
      const response = await directoryApi.rotateOpenClawHost(host.id)
      setCredentialResult({
        hostLabel: hostTitle(response.host),
        credential: response.credential,
        commands: response.installPack.commands,
      })
      await Promise.all([loadOverview(), loadDigest()])
      await loadHost(host.id)
    }, `Credential for ${hostTitle(host)} rotated.`)
  }

  async function handleRecover(host: OpenClawHostSummary) {
    await runAction(`recover-${host.id}`, async () => {
      const response = await directoryApi.recoverOpenClawHost(host.id)
      setCredentialResult({
        hostLabel: hostTitle(response.host),
        credential: response.credential,
        commands: response.installPack.commands,
      })
      await Promise.all([loadOverview(), loadDigest()])
      await loadHost(host.id)
    }, `Recovery credential for ${hostTitle(host)} issued.`)
  }

  async function handleSavePlacement(host: OpenClawHostSummary) {
    const input: OpenClawHostProfilePatchInput = {
      environmentLabel: placementForm.environmentLabel.trim() || null,
      groupLabels: parseCommaSeparatedLabels(placementForm.groupLabels),
      owner: placementForm.owner.trim() || null,
    }

    await runAction(`placement-${host.id}`, async () => {
      await directoryApi.updateOpenClawHostProfile(host.id, input)
      await refreshAll(host.id, selectedConflictBeamId)
    }, `Placement for ${hostTitle(host)} updated.`)
  }

  async function handleClearPlacementRevokeReview(host: OpenClawHostSummary) {
    await runAction(`placement-clear-revoke-${host.id}`, async () => {
      await directoryApi.updateOpenClawHostProfile(host.id, { clearRevokeReview: true })
      await refreshAll(host.id, selectedConflictBeamId)
    }, `Revoke review cleared for ${hostTitle(host)}.`)
  }

  async function handleSavePolicy(host: OpenClawHostSummary) {
    const input: OpenClawHostPolicyPatchInput = {
      rotationIntervalHours: Number.parseInt(policyForm.rotationIntervalHours, 10) || host.policy.rotation.intervalHours,
      rotationWindowStartHour: Number.parseInt(policyForm.rotationWindowStartHour, 10) || 0,
      rotationWindowDurationHours: Number.parseInt(policyForm.rotationWindowDurationHours, 10) || 1,
      recoveryOwner: policyForm.recoveryOwner.trim() || null,
      recoveryStatus: policyForm.recoveryStatus,
      recoveryNotes: policyForm.recoveryNotes.trim() || null,
      replacementHostLabel: policyForm.replacementHostLabel.trim() || null,
      recoveryWindowStartsAt: fromDateTimeLocalValue(policyForm.recoveryWindowStartsAt),
      recoveryWindowEndsAt: fromDateTimeLocalValue(policyForm.recoveryWindowEndsAt),
    }

    await runAction(`policy-${host.id}`, async () => {
      await directoryApi.updateOpenClawHostPolicy(host.id, input)
      await Promise.all([loadOverview(), loadDigest()])
      await loadHost(host.id)
    }, `Policy for ${hostTitle(host)} updated.`)
  }

  async function handleRevoke(host: OpenClawHostSummary) {
    const reason = host.status === 'revoked'
      ? host.revocationReason ?? 'Host revoked'
      : `Revoked by operator on ${new Date().toISOString()}`
    await runAction(`revoke-${host.id}`, async () => {
      await directoryApi.revokeOpenClawHost(host.id, { reason })
      await refreshAll(host.id, selectedConflictBeamId)
    }, `Host ${hostTitle(host)} revoked.`)
  }

  async function handleBulkAction(input: OpenClawFleetBulkActionInput, successMessage: string, nextMode: FleetBulkMode = null) {
    await runAction(`bulk-${input.action}`, async () => {
      await directoryApi.runOpenClawFleetBulkAction(input)
      await refreshAll(selectedHostId, selectedConflictBeamId)
      setBulkMode(nextMode)
    }, successMessage)
  }

  function focusConflict(beamId: string) {
    const nextParams = new URLSearchParams(searchParams)
    nextParams.set('conflict', beamId)
    setSearchParams(nextParams, { replace: true })
  }

  async function handleResolveConflict(options: {
    beamId: string
    preferredRouteId: number
    disableCompetingRoutes?: boolean
    note?: string | null
  }) {
    await runAction(`resolve-conflict-${options.beamId}`, async () => {
      const response = await directoryApi.resolveOpenClawConflict(options.beamId, {
        preferredRouteId: options.preferredRouteId,
        disableCompetingRoutes: options.disableCompetingRoutes,
        note: options.note,
      })
      setConflictDetail(response.conflict)
      await refreshAll(selectedHostId, options.beamId)
    }, `Conflict route owner updated for ${options.beamId}.`)
  }

  async function handlePreferRoute(route: Pick<OpenClawHostRoute, 'id' | 'beamId'>) {
    await runAction(`prefer-route-${route.id}`, async () => {
      await directoryApi.preferOpenClawRoute(route.id, {
        note: `Preferred by operator for ${route.beamId}`,
      })
      await refreshAll(selectedHostId, selectedConflictBeamId)
    }, `Preferred route set for ${route.beamId}.`)
  }

  async function handleDisableRoute(route: Pick<OpenClawHostRoute, 'id' | 'beamId'>) {
    await runAction(`disable-route-${route.id}`, async () => {
      await directoryApi.disableOpenClawRoute(route.id, {
        note: `Disabled by operator for ${route.beamId}`,
      })
      await refreshAll(selectedHostId, selectedConflictBeamId)
    }, `Route disabled for ${route.beamId}.`)
  }

  async function handleClearRouteOwner(route: Pick<OpenClawHostRoute, 'id' | 'beamId'>) {
    await runAction(`clear-route-${route.id}`, async () => {
      await directoryApi.clearOpenClawRouteOwner(route.id, {
        note: `Ownership reset by operator for ${route.beamId}`,
      })
      await refreshAll(selectedHostId, selectedConflictBeamId)
    }, `Route ownership reset for ${route.beamId}.`)
  }

  async function handleDeliverDigest() {
    await runAction('deliver-digest', async () => {
      const response = await directoryApi.deliverOpenClawFleetDigest()
      await loadDigest()
      setNotice(`Fleet digest delivered to ${response.email}.`)
    }, 'Fleet digest delivered.')
  }

  const hostRoutes = hostDetail?.routes ?? []
  const identities = hostIdentities?.identities ?? []

  return (
    <div className="space-y-6">
      <PageHeader
        title="OpenClaw Fleet"
        description="One central Beam control plane for host approval, route health, duplicate identity conflicts, and multi-host OpenClaw delivery."
      />

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
          {notice}
        </div>
      ) : null}

      {credentialResult ? (
        <div className="rounded-2xl border border-orange-200 bg-orange-50 px-4 py-4 text-sm text-orange-800 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-100">
          <div className="font-medium">Credential pack ready for {credentialResult.hostLabel}</div>
          <div className="mt-2 break-all rounded-xl bg-white/70 px-3 py-3 font-mono text-xs dark:bg-slate-950/40">
            {credentialResult.credential}
          </div>
          <div className="mt-3 space-y-2 text-xs">
            <div>
              <div className="font-medium uppercase tracking-wide opacity-70">Use credential</div>
              <div className="mt-1 break-all rounded-xl bg-white/70 px-3 py-3 font-mono dark:bg-slate-950/40">{credentialResult.commands.useCredential}</div>
            </div>
            <div>
              <div className="font-medium uppercase tracking-wide opacity-70">Foreground debug</div>
              <div className="mt-1 break-all rounded-xl bg-white/70 px-3 py-3 font-mono dark:bg-slate-950/40">{credentialResult.commands.foregroundDebug}</div>
            </div>
          </div>
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-7">
        <MetricCard label="Hosts" value={!overview ? '—' : formatNumber(overview.summary.totalHosts)} />
        <MetricCard label="Active hosts" value={!overview ? '—' : formatNumber(overview.summary.activeHosts)} tone={(overview?.summary.activeHosts ?? 0) > 0 ? 'success' : 'default'} />
        <MetricCard label="Pending hosts" value={!overview ? '—' : formatNumber(overview.summary.pendingHosts)} tone={(overview?.summary.pendingHosts ?? 0) > 0 ? 'warning' : 'default'} />
        <MetricCard label="Live routes" value={!overview ? '—' : formatNumber(overview.summary.liveRoutes)} tone={(overview?.summary.liveRoutes ?? 0) > 0 ? 'success' : 'default'} />
        <MetricCard label="Receipt coverage" value={!overview ? '—' : formatPercent(overview.summary.receiptCoverageRatio)} tone={(overview?.summary.receiptCoverageRatio ?? 1) < 0.8 ? 'warning' : 'success'} />
        <MetricCard label="Latency watch" value={!overview ? '—' : formatNumber(overview.summary.degradedHosts)} tone={(overview?.summary.degradedHosts ?? 0) > 0 ? 'warning' : 'default'} />
        <MetricCard label="Rotation due" value={!overview ? '—' : formatNumber(overview.summary.rotationDueHosts)} tone={(overview?.summary.rotationDueHosts ?? 0) > 0 ? 'warning' : 'default'} />
        <MetricCard label="Duplicate conflicts" value={!overview ? '—' : formatNumber(overview.summary.duplicateIdentityConflicts)} tone={(overview?.summary.duplicateIdentityConflicts ?? 0) > 0 ? 'critical' : 'default'} />
      </section>

      <section className="panel">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="panel-title">Fleet operator digest</div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              One recurring summary for stale hosts, pending credential actions, duplicate conflicts, and failed deliveries.
            </p>
          </div>
          <button
            type="button"
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
            disabled={actionBusy === 'deliver-digest'}
            onClick={() => { void handleDeliverDigest() }}
          >
            {actionBusy === 'deliver-digest' ? 'Delivering…' : 'Deliver digest'}
          </button>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-7">
          <MetricCard label="Action items" value={!digest ? '—' : formatNumber(digest.summary.actionItems)} tone={(digest?.summary.actionItems ?? 0) > 0 ? 'warning' : 'default'} />
          <MetricCard label="Critical items" value={!digest ? '—' : formatNumber(digest.summary.criticalItems)} tone={(digest?.summary.criticalItems ?? 0) > 0 ? 'critical' : 'default'} />
          <MetricCard label="Credential actions" value={!digest ? '—' : formatNumber(digest.summary.pendingCredentialActions)} tone={(digest?.summary.pendingCredentialActions ?? 0) > 0 ? 'warning' : 'default'} />
          <MetricCard label="Failed receipts" value={!digest ? '—' : formatNumber(digest.summary.failedReceipts)} tone={(digest?.summary.failedReceipts ?? 0) > 0 ? 'critical' : 'default'} />
          <MetricCard label="Stale hosts" value={!digest ? '—' : formatNumber(digest.summary.staleHosts)} tone={(digest?.summary.staleHosts ?? 0) > 0 ? 'critical' : 'default'} />
          <MetricCard label="Missing receipts" value={!digest ? '—' : formatNumber(digest.summary.routesMissingReceipts)} tone={(digest?.summary.routesMissingReceipts ?? 0) > 0 ? 'warning' : 'default'} />
          <MetricCard label="SLO breaches" value={!digest ? '—' : formatNumber(digest.summary.latencySloBreaches)} tone={(digest?.summary.latencySloBreaches ?? 0) > 0 ? 'warning' : 'default'} />
        </div>

        <div className="mt-4 space-y-3">
          {digest && digest.actionItems.length > 0 ? (
            digest.actionItems.map((item) => (
              <div key={item.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">{item.title}</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{item.detail}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <StatusPill label={item.severity} tone={digestSeverityTone(item.severity)} />
                    <StatusPill label={item.category} />
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                  <div>{item.nextAction}</div>
                  <div>{item.hostLabel ? `${item.hostLabel}${item.workspaceSlug ? ` · ${item.workspaceSlug}` : ''}` : item.workspaceSlug ? `Workspace ${item.workspaceSlug}` : 'Global fleet item'}</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  {item.href ? (
                    <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={item.href}>
                      Open host
                    </Link>
                  ) : null}
                  {item.workspaceSlug ? (
                    <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/workspaces?workspace=${encodeURIComponent(item.workspaceSlug)}`}>
                      Open workspace
                    </Link>
                  ) : null}
                  {item.traceHref ? (
                    <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={item.traceHref}>
                      Open trace
                    </Link>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <EmptyPanel label="No fleet action items are currently open." />
          )}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.15fr,0.85fr]">
        <div className="panel">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="panel-title">Hosts</div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Pending hosts require explicit approval before they can publish inventory or receive delivery.
              </p>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {!overview ? 'Loading…' : `${formatNumber(visibleHosts.length)} visible${visibleHosts.length !== overview.hosts.length ? ` of ${formatNumber(overview.hosts.length)}` : ''}`}
            </div>
          </div>

          <div className="mt-4 space-y-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr),minmax(0,1fr),auto]">
              <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                <span>Environment</span>
                <select
                  className="input-field"
                  value={selectedEnvironment}
                  onChange={(event) => updateFleetQueryParam('environment', event.target.value)}
                >
                  <option value="all">All environments</option>
                  {environmentOptions.map((environment: OpenClawFleetEnvironmentSummary) => (
                    <option key={environment.label} value={environment.label}>
                      {environment.label} ({environment.hostCount})
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                <span>Host group</span>
                <select
                  className="input-field"
                  value={selectedGroup}
                  onChange={(event) => updateFleetQueryParam('group', event.target.value)}
                >
                  <option value="all">All groups</option>
                  {hostGroupOptions.map((group: OpenClawFleetHostGroupSummary) => (
                    <option key={group.label} value={group.label}>
                      {group.label} ({group.hostCount})
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end">
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                  disabled={selectedEnvironment === 'all' && selectedGroup === 'all'}
                  onClick={() => {
                    const next = new URLSearchParams(searchParams)
                    next.delete('environment')
                    next.delete('group')
                    next.delete('host')
                    setSearchParams(next, { replace: true })
                  }}
                >
                  Clear filters
                </button>
              </div>
            </div>

            {overview ? (
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-800">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Environments</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {environmentOptions.length > 0 ? (
                      environmentOptions.map((environment) => (
                        <button
                          key={environment.label}
                          type="button"
                          className={`rounded-full border px-3 py-1 text-xs transition ${selectedEnvironment === environment.label ? 'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200' : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                          onClick={() => updateFleetQueryParam('environment', environment.label)}
                        >
                          {environment.label} · {formatNumber(environment.hostCount)}
                        </button>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500 dark:text-slate-400">No host environments labeled yet.</span>
                    )}
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 px-4 py-3 dark:border-slate-800">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Host groups</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {hostGroupOptions.length > 0 ? (
                      hostGroupOptions.map((group) => (
                        <button
                          key={group.label}
                          type="button"
                          className={`rounded-full border px-3 py-1 text-xs transition ${selectedGroup === group.label ? 'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200' : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                          onClick={() => updateFleetQueryParam('group', group.label)}
                        >
                          {group.label} · {formatNumber(group.hostCount)}
                        </button>
                      ))
                    ) : (
                      <span className="text-xs text-slate-500 dark:text-slate-400">No host groups labeled yet.</span>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {selectedHostIds.length > 0 ? (
              <div className="rounded-2xl border border-orange-200 bg-orange-50/70 px-4 py-4 dark:border-orange-500/30 dark:bg-orange-500/10">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {formatNumber(selectedHostIds.length)} host{selectedHostIds.length === 1 ? '' : 's'} selected
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {selectedBulkHosts.slice(0, 4).map((host) => hostTitle(host)).join(', ')}
                      {selectedBulkHosts.length > 4 ? ` +${selectedBulkHosts.length - 4} more` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={`rounded-xl border px-3 py-2 text-sm transition ${bulkMode === 'labels' ? 'border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-500/40 dark:bg-orange-500/20 dark:text-orange-100' : 'border-slate-200 text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800'}`}
                      onClick={() => setBulkMode('labels')}
                    >
                      Apply labels
                    </button>
                    <button
                      type="button"
                      className={`rounded-xl border px-3 py-2 text-sm transition ${bulkMode === 'stage_revoke_review' ? 'border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-500/40 dark:bg-orange-500/20 dark:text-orange-100' : 'border-slate-200 text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800'}`}
                      onClick={() => setBulkMode('stage_revoke_review')}
                    >
                      Stage revoke review
                    </button>
                    <button
                      type="button"
                      className={`rounded-xl border px-3 py-2 text-sm transition ${bulkMode === 'clear_revoke_review' ? 'border-orange-300 bg-orange-100 text-orange-800 dark:border-orange-500/40 dark:bg-orange-500/20 dark:text-orange-100' : 'border-slate-200 text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800'}`}
                      onClick={() => setBulkMode('clear_revoke_review')}
                    >
                      Clear staged revoke review
                    </button>
                  </div>
                </div>

                {bulkMode === 'labels' ? (
                  <div className="mt-4 space-y-3">
                    <div className="grid gap-3 md:grid-cols-3">
                      <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                        <span>Environment label</span>
                        <input
                          className="input-field"
                          placeholder="prod"
                          value={bulkForm.environmentLabel}
                          onChange={(event) => setBulkForm((current) => ({ ...current, environmentLabel: event.target.value }))}
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                        <span>Group labels</span>
                        <input
                          className="input-field"
                          placeholder="edge, team-alpha"
                          value={bulkForm.groupLabels}
                          onChange={(event) => setBulkForm((current) => ({ ...current, groupLabels: event.target.value }))}
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                        <span>Owner</span>
                        <input
                          className="input-field"
                          placeholder="ops@example.com"
                          value={bulkForm.owner}
                          onChange={(event) => setBulkForm((current) => ({ ...current, owner: event.target.value }))}
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-orange-500 dark:text-slate-950 dark:hover:bg-orange-400"
                        disabled={actionBusy === 'bulk-apply_labels'}
                        onClick={() => {
                          void handleBulkAction({
                            action: 'apply_labels',
                            hostIds: selectedHostIds,
                            environmentLabel: bulkForm.environmentLabel.trim() || null,
                            groupLabels: parseCommaSeparatedLabels(bulkForm.groupLabels),
                            owner: bulkForm.owner.trim() || null,
                          }, `Labels updated for ${selectedHostIds.length} host(s).`)
                        }}
                      >
                        {actionBusy === 'bulk-apply_labels' ? 'Applying…' : 'Apply labels'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {bulkMode === 'stage_revoke_review' ? (
                  <div className="mt-4 space-y-3">
                    <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <span>Reason</span>
                      <textarea
                        className="input-field min-h-[96px]"
                        placeholder="Why these hosts should move into revoke review."
                        value={bulkForm.reason}
                        onChange={(event) => setBulkForm((current) => ({ ...current, reason: event.target.value }))}
                      />
                    </label>
                    <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <span>Confirm phrase</span>
                      <input
                        className="input-field"
                        placeholder="STAGE_REVOKE"
                        value={bulkForm.confirmPhrase}
                        onChange={(event) => setBulkForm((current) => ({ ...current, confirmPhrase: event.target.value }))}
                      />
                    </label>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      This only stages the hosts for human revoke review. It does not revoke them yet.
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-orange-500 dark:text-slate-950 dark:hover:bg-orange-400"
                        disabled={actionBusy === 'bulk-stage_revoke_review' || !bulkForm.reason.trim() || bulkForm.confirmPhrase.trim() !== 'STAGE_REVOKE'}
                        onClick={() => {
                          void handleBulkAction({
                            action: 'stage_revoke_review',
                            hostIds: selectedHostIds,
                            reason: bulkForm.reason.trim(),
                            confirmPhrase: bulkForm.confirmPhrase.trim(),
                          }, `Revoke review staged for ${selectedHostIds.length} host(s).`)
                        }}
                      >
                        {actionBusy === 'bulk-stage_revoke_review' ? 'Staging…' : 'Stage revoke review'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {bulkMode === 'clear_revoke_review' ? (
                  <div className="mt-4 space-y-3">
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {selectedBulkHostsWithRevokeReview.length > 0
                        ? `${formatNumber(selectedBulkHostsWithRevokeReview.length)} selected host(s) currently have a staged revoke review.`
                        : 'None of the selected hosts currently have a staged revoke review.'}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-orange-500 dark:text-slate-950 dark:hover:bg-orange-400"
                        disabled={actionBusy === 'bulk-clear_revoke_review' || selectedBulkHostsWithRevokeReview.length === 0}
                        onClick={() => {
                          void handleBulkAction({
                            action: 'clear_revoke_review',
                            hostIds: selectedHostIds,
                          }, `Staged revoke review cleared for ${selectedBulkHostsWithRevokeReview.length} host(s).`)
                        }}
                      >
                        {actionBusy === 'bulk-clear_revoke_review' ? 'Clearing…' : 'Clear revoke review'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {visibleHosts.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                <div>
                  {selectedHostIds.length > 0
                    ? `${formatNumber(selectedHostIds.length)} selected`
                    : 'Select hosts to apply bulk labels or guarded revoke-review staging.'}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-700 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                    onClick={() => setAllVisibleHostsSelected(true)}
                  >
                    Select visible
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-xs text-slate-700 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                    onClick={() => setAllVisibleHostsSelected(false)}
                  >
                    Clear selection
                  </button>
                </div>
              </div>
            ) : null}

            {loading && !overview ? (
              <EmptyPanel label="Loading host fleet…" />
            ) : overview && visibleHosts.length > 0 ? (
              visibleHosts.map((host) => {
                const active = selectedHost?.id === host.id
                const groups = hostGroupLabels(host)
                const extraGroups = Math.max(groups.length - 2, 0)
                const selected = selectedHostIds.includes(host.id)
                return (
                  <div
                    key={host.id}
                    className={`rounded-2xl border p-4 transition ${active ? 'border-orange-300 bg-orange-50/50 dark:border-orange-500/40 dark:bg-orange-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900/60'}`}
                    onClick={() => {
                      const next = new URLSearchParams(searchParams)
                      next.set('host', String(host.id))
                      setSearchParams(next)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        const next = new URLSearchParams(searchParams)
                        next.set('host', String(host.id))
                        setSearchParams(next)
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{hostTitle(host)}</div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">{hostMeta(host)}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
                        <label className="flex items-center gap-2 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
                          <input
                            checked={selected}
                            type="checkbox"
                            onChange={(event) => toggleHostSelection(host.id, event.target.checked)}
                          />
                          <span>Select</span>
                        </label>
                        <StatusPill label={host.status} tone={hostStatusTone(host.status)} />
                        <StatusPill label={host.healthStatus} tone={hostHealthTone(host.healthStatus)} />
                        <StatusPill label={host.credentialState} tone={credentialStateTone(host.credentialState)} />
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <StatusPill label={`env:${hostEnvironmentLabel(host)}`} />
                      {groups.slice(0, 2).map((group) => (
                        <StatusPill key={`${host.id}-${group}`} label={`group:${group}`} />
                      ))}
                      {extraGroups > 0 ? (
                        <StatusPill label={`+${extraGroups} more`} />
                      ) : null}
                      {host.placement.revokeReviewRequestedAt ? (
                        <StatusPill label="revoke review" tone="warning" />
                      ) : null}
                    </div>

                    <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                      <div>{host.placement.owner ? `Owner ${host.placement.owner}` : 'No host owner assigned'}</div>
                      <div>{`${formatNumber(host.summary.live)} live · ${formatNumber(host.summary.stale)} stale · ${formatNumber(host.summary.conflict)} conflict`}</div>
                      <div>{`${formatNumber(host.summary.unavailable)} unavailable · ${formatNumber(host.summary.revoked)} revoked`}</div>
                      <div>{host.lastInventoryAt ? `Inventory ${formatRelativeTime(host.lastInventoryAt)}` : 'No inventory yet'}</div>
                      <div>{host.summary.delivery.receipts > 0 ? `${formatNumber(host.summary.delivery.receipts)} receipts · ${formatNumber(host.summary.delivery.failed)} failed · ${formatPercent(host.summary.delivery.coverage.ratio)} coverage` : 'No delivery receipts yet'}</div>
                      <div>{host.approvedAt ? `Approved ${formatRelativeTime(host.approvedAt)}` : 'Waiting for approval'}</div>
                      <div>{host.revokedAt ? `Revoked ${formatRelativeTime(host.revokedAt)}` : 'Credential active or pending'}</div>
                      <div>{host.credentialIssuedAt ? `Credential age ${host.credentialAgeHours ?? 0}h` : 'No credential issued yet'}</div>
                      <div>{host.policy.rotation.nextRotationDueAt ? `Rotation ${host.policy.rotation.reviewState === 'overdue' ? 'overdue' : 'due'} ${formatRelativeTime(host.policy.rotation.nextRotationDueAt)}` : 'No rotation schedule yet'}</div>
                      <div>{host.summary.delivery.latency.samples > 0 ? `p95 ${formatLatency(host.summary.delivery.latency.p95Ms)} · ${formatNumber(host.summary.delivery.latency.overSlo)} breach` : 'No latency samples yet'}</div>
                      <div>{host.policy.recovery.status !== 'idle' ? `Recovery ${host.policy.recovery.status}${host.policy.recovery.owner ? ` · ${host.policy.recovery.owner}` : ''}` : 'Recovery runbook idle'}</div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {host.status === 'pending' ? (
                        <button
                          type="button"
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                          disabled={actionBusy === `approve-${host.id}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleApprove(host)
                          }}
                        >
                          {actionBusy === `approve-${host.id}` ? 'Approving…' : 'Approve host'}
                        </button>
                      ) : null}
                      {host.status !== 'revoked' ? (
                        <button
                          type="button"
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                          disabled={actionBusy === `revoke-${host.id}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleRevoke(host)
                          }}
                        >
                          {actionBusy === `revoke-${host.id}` ? 'Revoking…' : 'Revoke host'}
                        </button>
                      ) : null}
                      {host.status === 'active' ? (
                        <button
                          type="button"
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                          disabled={actionBusy === `rotate-${host.id}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleRotate(host)
                          }}
                        >
                          {actionBusy === `rotate-${host.id}` ? 'Rotating…' : 'Rotate credential'}
                        </button>
                      ) : null}
                      {host.status === 'revoked' || host.healthStatus === 'stale' ? (
                        <button
                          type="button"
                          className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                          disabled={actionBusy === `recover-${host.id}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleRecover(host)
                          }}
                        >
                          {actionBusy === `recover-${host.id}` ? 'Recovering…' : 'Recover host'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })
            ) : (
              <EmptyPanel label={overview ? 'No hosts match the current fleet filters.' : 'No OpenClaw hosts have enrolled yet.'} />
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">Issue enrollment</div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Create a one-time host enrollment token for a new OpenClaw machine. The operator still approves the host after it checks in.
          </p>

          <form className="mt-4 space-y-3" onSubmit={(event) => { void handleCreateEnrollment(event) }}>
            <input
              className="input-field"
              placeholder="Label, e.g. OpenClaw Prod EU-1"
              value={String(enrollmentForm.label ?? '')}
              onChange={(event) => setEnrollmentForm((current) => ({ ...current, label: event.target.value }))}
            />
            <input
              className="input-field"
              placeholder="Workspace slug, optional"
              value={String(enrollmentForm.workspaceSlug ?? '')}
              onChange={(event) => setEnrollmentForm((current) => ({ ...current, workspaceSlug: event.target.value }))}
            />
            <textarea
              className="input-field min-h-[96px]"
              placeholder="Notes for the host operator"
              value={String(enrollmentForm.notes ?? '')}
              onChange={(event) => setEnrollmentForm((current) => ({ ...current, notes: event.target.value }))}
            />
            <input
              className="input-field"
              min={1}
              max={720}
              step={1}
              type="number"
              value={String(enrollmentForm.expiresInHours ?? 72)}
              onChange={(event) => setEnrollmentForm((current) => ({
                ...current,
                expiresInHours: Number.parseInt(event.target.value, 10) || 72,
              }))}
            />
            <button
              type="submit"
              className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-orange-500 dark:text-slate-950 dark:hover:bg-orange-400"
              disabled={actionBusy === 'create-enrollment'}
            >
              {actionBusy === 'create-enrollment' ? 'Issuing…' : 'Issue enrollment'}
            </button>
          </form>

          {enrollmentResult?.token ? (
            <div className="mt-4 rounded-2xl border border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Enrollment token</div>
              <div className="mt-2 break-all rounded-xl bg-slate-100 px-3 py-3 font-mono text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-200">
                {enrollmentResult.token}
              </div>
              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {[
                  enrollmentResult.label ? `Label ${enrollmentResult.label}` : null,
                  enrollmentResult.workspaceSlug ? `Workspace ${enrollmentResult.workspaceSlug}` : null,
                  enrollmentResult.expiresAt ? `Expires ${formatDateTime(enrollmentResult.expiresAt)}` : null,
                ].filter(Boolean).join(' · ')}
              </div>
              {enrollmentResult.installPack ? (
                <div className="mt-4 space-y-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Install pack</div>
                  {[
                    ['Managed macOS', enrollmentResult.installPack.commands.managedMacos],
                    ['Managed Linux', enrollmentResult.installPack.commands.managedLinux],
                    ['Foreground debug', enrollmentResult.installPack.commands.foregroundDebug],
                    ['Status', enrollmentResult.installPack.commands.status],
                    ['Uninstall', enrollmentResult.installPack.commands.uninstall],
                  ].map(([label, command]) => (
                    <div key={label}>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
                      <div className="mt-1 break-all rounded-xl bg-slate-100 px-3 py-3 font-mono text-xs text-slate-700 dark:bg-slate-900 dark:text-slate-200">
                        {command}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">Duplicate identity conflicts</div>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Beam blocks delivery when the same Beam ID appears as a live route on multiple approved hosts.
        </p>
        <div className="mt-4 space-y-3">
          {overview && overview.conflicts.length > 0 ? (
            overview.conflicts.map((group) => (
              <div
                key={group.beamId}
                className={`rounded-2xl border p-4 ${selectedConflictBeamId === group.beamId ? 'border-orange-300 bg-orange-50/60 dark:border-orange-500/40 dark:bg-orange-500/10' : 'border-red-200 bg-red-50/60 dark:border-red-500/30 dark:bg-red-500/10'}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-red-700 dark:text-red-200">{group.beamId}</div>
                    <div className="text-xs text-red-600/80 dark:text-red-200/80">{conflictSummary(group)}</div>
                    {group.recommendedReason ? (
                      <div className="mt-1 text-[11px] text-red-600/80 dark:text-red-200/80">
                        Recommended owner: route {group.recommendedRouteId ?? '—'} · {group.recommendedReason}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {group.selectedOwnerRouteId ? (
                      <StatusPill label={`Owner ${group.selectedOwnerRouteId}`} tone="success" />
                    ) : null}
                    <StatusPill label={`${group.routeCount} conflicting routes`} tone="critical" />
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-red-700/80 dark:text-red-200/80 md:grid-cols-2">
                  {group.routes.map((route) => (
                    <div key={`${route.hostId}-${route.routeKey}`} className="rounded-xl border border-red-200/70 bg-white/50 px-3 py-3 dark:border-red-500/20 dark:bg-slate-950/20">
                      <div>
                        {[
                          route.hostLabel || route.hostname,
                          route.workspaceSlug ? `Workspace ${route.workspaceSlug}` : 'No workspace',
                          routeSourceLabel(route.routeSource),
                        ].join(' · ')}
                      </div>
                      <div className="mt-1 text-[11px] opacity-80">
                        {[
                          route.hostHealth,
                          route.lastSeenAt ? `Seen ${formatRelativeTime(route.lastSeenAt)}` : null,
                          route.lastDeliveryStatus ? `Last ${route.lastDeliveryStatus}` : null,
                        ].filter(Boolean).join(' · ')}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <StatusPill label={route.ownerResolutionState} tone={ownerResolutionTone(route.ownerResolutionState)} />
                        <button
                          type="button"
                          className="rounded-xl border border-red-200 px-3 py-2 text-[11px] font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-60 dark:border-red-500/30 dark:text-red-100 dark:hover:bg-red-500/10"
                          disabled={actionBusy === `prefer-route-${route.routeId}`}
                          onClick={() => { void handlePreferRoute({ id: route.routeId, beamId: group.beamId }) }}
                        >
                          {actionBusy === `prefer-route-${route.routeId}` ? 'Preferring…' : 'Prefer route'}
                        </button>
                        <button
                          type="button"
                          className="rounded-xl border border-red-200 px-3 py-2 text-[11px] font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-60 dark:border-red-500/30 dark:text-red-100 dark:hover:bg-red-500/10"
                          disabled={actionBusy === `disable-route-${route.routeId}`}
                          onClick={() => { void handleDisableRoute({ id: route.routeId, beamId: group.beamId }) }}
                        >
                          {actionBusy === `disable-route-${route.routeId}` ? 'Disabling…' : 'Disable route'}
                        </button>
                        <button
                          type="button"
                          className="rounded-xl border border-red-200 px-3 py-2 text-[11px] font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-60 dark:border-red-500/30 dark:text-red-100 dark:hover:bg-red-500/10"
                          disabled={actionBusy === `clear-route-${route.routeId}`}
                          onClick={() => { void handleClearRouteOwner({ id: route.routeId, beamId: group.beamId }) }}
                        >
                          {actionBusy === `clear-route-${route.routeId}` ? 'Resetting…' : 'Reset owner'}
                        </button>
                        {route.lastDeliveryHref ? (
                          <Link className="rounded-xl border border-red-200 px-3 py-2 text-[11px] font-medium text-red-700 transition hover:bg-red-100 dark:border-red-500/30 dark:text-red-100 dark:hover:bg-red-500/10" to={route.lastDeliveryHref}>
                            Open trace
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <button
                    type="button"
                    className="text-orange-600 hover:text-orange-700 dark:text-orange-300"
                    onClick={() => focusConflict(group.beamId)}
                  >
                    Review conflict
                  </button>
                  <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/openclaw-fleet?conflict=${encodeURIComponent(group.beamId)}`}>
                    Open remediation view
                  </Link>
                </div>
              </div>
            ))
          ) : (
            <EmptyPanel label="No duplicate identity conflicts are active." />
          )}
        </div>
      </section>

      <section className="panel">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="panel-title">Conflict remediation</div>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Guided route-owner resolution for one Beam identity, with a recommended owner, shadow-route cleanup, and audit history.
            </p>
          </div>
          {conflictDetail ? (
            <div className="flex flex-wrap gap-2">
              <StatusPill label={conflictDetail.resolutionState} tone={conflictResolutionTone(conflictDetail.resolutionState)} />
              <StatusPill label={`${conflictDetail.activeConflictRouteCount} active conflicts`} tone={conflictDetail.activeConflictRouteCount > 0 ? 'critical' : 'default'} />
            </div>
          ) : null}
        </div>

        <div className="mt-4 space-y-4">
          {!selectedConflictBeamId ? (
            <EmptyPanel label="Pick a duplicate conflict above to open the guided remediation flow." />
          ) : detailLoading && !conflictDetail ? (
            <EmptyPanel label="Loading conflict detail…" />
          ) : !conflictDetail ? (
            <EmptyPanel label="The selected conflict no longer exists." />
          ) : (
            <>
              <div className="rounded-2xl border border-slate-200 px-4 py-4 text-sm dark:border-slate-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-medium text-slate-900 dark:text-slate-100">{conflictDetail.beamId}</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {`${formatNumber(conflictDetail.routeCount)} total route(s) · ${formatNumber(conflictDetail.activeConflictRouteCount)} active conflicting route(s)`}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {conflictDetail.selectedOwnerRouteId ? (
                      <StatusPill label={`Owner route ${conflictDetail.selectedOwnerRouteId}`} tone="success" />
                    ) : null}
                    {conflictDetail.recommendedRouteId ? (
                      <StatusPill label={`Recommended ${conflictDetail.recommendedRouteId}`} tone="warning" />
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                  <div>{conflictDetail.recommendedReason ? `Recommendation: ${conflictDetail.recommendedReason}` : 'No route recommendation available yet.'}</div>
                  <div>{selectedConflictRoute ? `Selected route ${selectedConflictRoute.id}${selectedConflictRoute.hostLabel ? ` · ${selectedConflictRoute.hostLabel}` : ''}` : 'No route selected yet.'}</div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                    disabled={!selectedConflictRoute || actionBusy === `resolve-conflict-${conflictDetail.beamId}`}
                    onClick={() => {
                      if (!selectedConflictRoute) return
                      void handleResolveConflict({
                        beamId: conflictDetail.beamId,
                        preferredRouteId: selectedConflictRoute.id,
                        disableCompetingRoutes: false,
                        note: `Guided remediation selected route ${selectedConflictRoute.id} for ${conflictDetail.beamId}.`,
                      })
                    }}
                  >
                    {actionBusy === `resolve-conflict-${conflictDetail.beamId}` ? 'Resolving…' : 'Prefer selected route'}
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                    disabled={!selectedConflictRoute || actionBusy === `resolve-conflict-${conflictDetail.beamId}`}
                    onClick={() => {
                      if (!selectedConflictRoute) return
                      void handleResolveConflict({
                        beamId: conflictDetail.beamId,
                        preferredRouteId: selectedConflictRoute.id,
                        disableCompetingRoutes: true,
                        note: `Guided remediation preferred route ${selectedConflictRoute.id} and disabled competing routes for ${conflictDetail.beamId}.`,
                      })
                    }}
                  >
                    {actionBusy === `resolve-conflict-${conflictDetail.beamId}` ? 'Resolving…' : 'Prefer and disable others'}
                  </button>
                  {conflictDetail.recommendedRouteId && conflictDetail.recommendedRouteId !== selectedConflictRouteId ? (
                    <button
                      type="button"
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                      onClick={() => setSelectedConflictRouteId(conflictDetail.recommendedRouteId)}
                    >
                      Pick recommended route
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[1.25fr,0.75fr]">
                <div className="space-y-3">
                  {conflictDetail.routes.map((route) => {
                    const selected = selectedConflictRouteId === route.id
                    const recommended = conflictDetail.recommendedRouteId === route.id
                    return (
                      <button
                        key={route.id}
                        type="button"
                        className={`w-full rounded-2xl border p-4 text-left transition ${selected ? 'border-orange-300 bg-orange-50/50 dark:border-orange-500/40 dark:bg-orange-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900/60'}`}
                        onClick={() => setSelectedConflictRouteId(route.id)}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                              {route.hostLabel || `Host ${route.hostId}`} · {route.routeKey}
                            </div>
                            <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                              {[
                                route.workspace?.slug ? `Workspace ${route.workspace.slug}` : 'No workspace',
                                routeSourceLabel(route.routeSource),
                                route.connectionMode ?? 'No receiver',
                              ].join(' · ')}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {recommended ? <StatusPill label="recommended" tone="warning" /> : null}
                            {selected ? <StatusPill label="selected" tone="success" /> : null}
                            <StatusPill label={route.runtimeSessionState} tone={routeStateTone(route.runtimeSessionState)} />
                            <StatusPill label={route.ownerResolutionState} tone={ownerResolutionTone(route.ownerResolutionState)} />
                          </div>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                          <div>{`Host health ${route.hostHealth} · credential ${route.hostCredentialState}`}</div>
                          <div>{route.lastSeenAt ? `Last seen ${formatRelativeTime(route.lastSeenAt)}` : 'No last-seen timestamp'}</div>
                          <div>{route.lastDelivery ? `Last delivery ${formatRelativeTime(route.lastDelivery.requestedAt)} · ${route.lastDelivery.status}${route.lastDelivery.errorCode ? ` · ${route.lastDelivery.errorCode}` : ''}` : 'No delivery receipt yet'}</div>
                          <div>{route.ownerResolutionAt ? `Owner action ${formatRelativeTime(route.ownerResolutionAt)}${route.ownerResolutionActor ? ` · ${route.ownerResolutionActor}` : ''}` : 'No owner action recorded'}</div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs">
                          <button
                            type="button"
                            className="text-orange-600 hover:text-orange-700 disabled:opacity-60 dark:text-orange-300"
                            disabled={actionBusy === `prefer-route-${route.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              void handlePreferRoute(route)
                            }}
                          >
                            {actionBusy === `prefer-route-${route.id}` ? 'Preferring…' : 'Prefer route'}
                          </button>
                          <button
                            type="button"
                            className="text-orange-600 hover:text-orange-700 disabled:opacity-60 dark:text-orange-300"
                            disabled={actionBusy === `disable-route-${route.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleDisableRoute(route)
                            }}
                          >
                            {actionBusy === `disable-route-${route.id}` ? 'Disabling…' : 'Disable route'}
                          </button>
                          <button
                            type="button"
                            className="text-orange-600 hover:text-orange-700 disabled:opacity-60 dark:text-orange-300"
                            disabled={actionBusy === `clear-route-${route.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleClearRouteOwner(route)
                            }}
                          >
                            {actionBusy === `clear-route-${route.id}` ? 'Resetting…' : 'Reset owner'}
                          </button>
                          <button
                            type="button"
                            className="text-orange-600 hover:text-orange-700 disabled:opacity-60 dark:text-orange-300"
                            disabled={actionBusy === `revoke-${route.hostId}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              const host = overview?.hosts.find((entry) => entry.id === route.hostId)
                              if (host) {
                                void handleRevoke(host)
                              }
                            }}
                          >
                            {actionBusy === `revoke-${route.hostId}` ? 'Revoking…' : 'Revoke host'}
                          </button>
                          {route.workspace ? (
                            <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/workspaces?workspace=${encodeURIComponent(route.workspace.slug)}`}>
                              Open workspace
                            </Link>
                          ) : null}
                          {route.lastDelivery ? (
                            <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={route.lastDelivery.href}>
                              Open trace
                            </Link>
                          ) : null}
                        </div>
                      </button>
                    )
                  })}
                </div>

                <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Resolution history</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Route-owner and host actions attached to this Beam identity.
                  </div>
                  <div className="mt-4 space-y-3">
                    {conflictDetail.history.length > 0 ? (
                      conflictDetail.history.map((entry) => (
                        <div key={entry.id} className="rounded-xl border border-slate-200 px-3 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="font-medium text-slate-900 dark:text-slate-100">{entry.action}</div>
                            <div>{formatRelativeTime(entry.timestamp)}</div>
                          </div>
                          <div className="mt-1">
                            {[
                              entry.actor ? `Actor ${entry.actor}` : null,
                              entry.routeId ? `Route ${entry.routeId}` : null,
                              entry.hostId ? `Host ${entry.hostId}` : null,
                            ].filter(Boolean).join(' · ')}
                          </div>
                          {entry.note ? (
                            <div className="mt-2">{entry.note}</div>
                          ) : null}
                          {entry.href ? (
                            <div className="mt-2">
                              <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={entry.href}>
                                Open related view
                              </Link>
                            </div>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <EmptyPanel label="No conflict history recorded yet." />
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr,0.9fr]">
        <div className="panel">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="panel-title">Selected host</div>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Route inventory, heartbeat history, and live runtime health for one approved or pending host.
              </p>
            </div>
            {selectedHost ? (
              <div className="flex flex-wrap gap-2">
                <StatusPill label={selectedHost.status} tone={hostStatusTone(selectedHost.status)} />
                <StatusPill label={selectedHost.healthStatus} tone={hostHealthTone(selectedHost.healthStatus)} />
              </div>
            ) : null}
          </div>

          {!selectedHost ? (
            <div className="mt-4">
              <EmptyPanel label="Select a host to inspect its routes and identities." />
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="rounded-2xl border border-slate-200 px-4 py-4 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                <div className="text-base font-medium text-slate-900 dark:text-slate-100">{hostTitle(selectedHost)}</div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hostMeta(selectedHost)}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <StatusPill label={`env:${hostEnvironmentLabel(selectedHost)}`} />
                  {hostGroupLabels(selectedHost).map((group) => (
                    <StatusPill key={`${selectedHost.id}-${group}`} label={`group:${group}`} />
                  ))}
                  {selectedHost.placement.revokeReviewRequestedAt ? (
                    <StatusPill label="revoke review" tone="warning" />
                  ) : null}
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                  <div>{selectedHost.placement.owner ? `Owner ${selectedHost.placement.owner}` : 'No host owner assigned'}</div>
                  <div>{selectedHost.approvedBy ? `Approved by ${selectedHost.approvedBy}` : 'No approval recorded yet'}</div>
                  <div>{selectedHost.beamDirectoryUrl}</div>
                  <div>{selectedHost.lastRouteEventAt ? `Last route event ${formatRelativeTime(selectedHost.lastRouteEventAt)}` : 'No route events yet'}</div>
                  <div>{selectedHost.revocationReason ? `Revocation reason: ${selectedHost.revocationReason}` : 'Not revoked'}</div>
                  <div>{selectedHost.credentialIssuedAt ? `Credential issued ${formatDateTime(selectedHost.credentialIssuedAt)}` : 'No credential issued yet'}</div>
                  <div>{selectedHost.credentialRotatedAt ? `Credential rotated ${formatDateTime(selectedHost.credentialRotatedAt)}` : 'No credential rotation yet'}</div>
                  <div>{`${formatNumber(selectedHost.summary.unavailable)} unavailable · ${formatNumber(selectedHost.summary.revoked)} revoked routes`}</div>
                  <div>{selectedHost.summary.delivery.lastRequestedAt ? `Last receipt ${formatRelativeTime(selectedHost.summary.delivery.lastRequestedAt)} · ${selectedHost.summary.delivery.lastStatus ?? 'unknown'}` : 'No delivery receipts yet'}</div>
                  <div>{`Receipt coverage ${formatPercent(selectedHost.summary.delivery.coverage.ratio)} · ${formatNumber(selectedHost.summary.delivery.coverage.missingReceipts)} missing`}</div>
                  <div>{selectedHost.summary.delivery.latency.samples > 0 ? `Latency avg ${formatLatency(selectedHost.summary.delivery.latency.avgMs)} · p95 ${formatLatency(selectedHost.summary.delivery.latency.p95Ms)}` : 'No latency samples yet'}</div>
                  <div>{selectedHost.policy.rotation.nextRotationWindowStartsAt ? `Rotation window ${formatDateTime(selectedHost.policy.rotation.nextRotationWindowStartsAt)}` : 'No rotation window scheduled'}</div>
                  <div>{selectedHost.policy.recovery.status !== 'idle' ? `Recovery ${selectedHost.policy.recovery.status}${selectedHost.policy.recovery.owner ? ` · ${selectedHost.policy.recovery.owner}` : ''}` : 'Recovery runbook idle'}</div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Placement and safe host labels</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Environment, group, and owner labels feed fleet filters and guarded bulk actions.
                    </div>
                  </div>
                  {selectedHost.placement.revokeReviewRequestedAt ? (
                    <div className="flex flex-wrap gap-2">
                      <StatusPill label="revoke review" tone="warning" />
                      {selectedHost.placement.revokeReviewReason ? (
                        <span className="text-xs text-slate-500 dark:text-slate-400">{selectedHost.placement.revokeReviewReason}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Environment label</span>
                    <input
                      className="input-field"
                      placeholder="prod"
                      value={placementForm.environmentLabel}
                      onChange={(event) => setPlacementForm((current) => ({ ...current, environmentLabel: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Group labels</span>
                    <input
                      className="input-field"
                      placeholder="edge, team-alpha"
                      value={placementForm.groupLabels}
                      onChange={(event) => setPlacementForm((current) => ({ ...current, groupLabels: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Owner</span>
                    <input
                      className="input-field"
                      placeholder="ops@example.com"
                      value={placementForm.owner}
                      onChange={(event) => setPlacementForm((current) => ({ ...current, owner: event.target.value }))}
                    />
                  </label>
                </div>

                <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                  <div>
                    {selectedHost.placement.revokeReviewRequestedAt
                      ? `Staged revoke review ${formatRelativeTime(selectedHost.placement.revokeReviewRequestedAt)}${selectedHost.placement.revokeReviewRequestedBy ? ` · ${selectedHost.placement.revokeReviewRequestedBy}` : ''}`
                      : 'No staged revoke review on this host'}
                  </div>
                  <div>
                    {selectedHost.placement.revokeReviewReason
                      ? `Review reason: ${selectedHost.placement.revokeReviewReason}`
                      : 'No revoke review reason recorded'}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                    disabled={actionBusy === `placement-${selectedHost.id}`}
                    onClick={() => { void handleSavePlacement(selectedHost) }}
                  >
                    {actionBusy === `placement-${selectedHost.id}` ? 'Saving…' : 'Save placement'}
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                    disabled={actionBusy === `placement-clear-revoke-${selectedHost.id}` || !selectedHost.placement.revokeReviewRequestedAt}
                    onClick={() => { void handleClearPlacementRevokeReview(selectedHost) }}
                  >
                    {actionBusy === `placement-clear-revoke-${selectedHost.id}` ? 'Clearing…' : 'Clear staged revoke review'}
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Rotation and recovery</div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Keep credential policy, rotation windows, and recovery handoff details attached to the host itself.
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <StatusPill label={selectedHost.policy.rotation.reviewState} tone={selectedHost.policy.rotation.reviewState === 'overdue' ? 'critical' : selectedHost.policy.rotation.reviewState === 'due_soon' ? 'warning' : 'default'} />
                    <StatusPill label={selectedHost.policy.recovery.status} tone={selectedHost.policy.recovery.status === 'cutover_pending' ? 'critical' : selectedHost.policy.recovery.status === 'prepared' ? 'warning' : selectedHost.policy.recovery.status === 'completed' ? 'success' : 'default'} />
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Rotation interval (hours)</span>
                    <input
                      className="input-field"
                      min={1}
                      step={1}
                      type="number"
                      value={policyForm.rotationIntervalHours}
                      onChange={(event) => setPolicyForm((current) => ({ ...current, rotationIntervalHours: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Window start hour (UTC)</span>
                    <input
                      className="input-field"
                      min={0}
                      max={23}
                      step={1}
                      type="number"
                      value={policyForm.rotationWindowStartHour}
                      onChange={(event) => setPolicyForm((current) => ({ ...current, rotationWindowStartHour: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Window duration (hours)</span>
                    <input
                      className="input-field"
                      min={1}
                      max={24}
                      step={1}
                      type="number"
                      value={policyForm.rotationWindowDurationHours}
                      onChange={(event) => setPolicyForm((current) => ({ ...current, rotationWindowDurationHours: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Recovery owner</span>
                    <input
                      className="input-field"
                      value={policyForm.recoveryOwner}
                      onChange={(event) => setPolicyForm((current) => ({ ...current, recoveryOwner: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Recovery status</span>
                    <select
                      className="input-field"
                      value={policyForm.recoveryStatus}
                      onChange={(event) => setPolicyForm((current) => ({ ...current, recoveryStatus: event.target.value as OpenClawHostRecoveryRunbookState }))}
                    >
                      <option value="idle">idle</option>
                      <option value="prepared">prepared</option>
                      <option value="cutover_pending">cutover_pending</option>
                      <option value="completed">completed</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Replacement host</span>
                    <input
                      className="input-field"
                      value={policyForm.replacementHostLabel}
                      onChange={(event) => setPolicyForm((current) => ({ ...current, replacementHostLabel: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Recovery window start</span>
                    <input
                      className="input-field"
                      type="datetime-local"
                      value={policyForm.recoveryWindowStartsAt}
                      onChange={(event) => setPolicyForm((current) => ({ ...current, recoveryWindowStartsAt: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Recovery window end</span>
                    <input
                      className="input-field"
                      type="datetime-local"
                      value={policyForm.recoveryWindowEndsAt}
                      onChange={(event) => setPolicyForm((current) => ({ ...current, recoveryWindowEndsAt: event.target.value }))}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-slate-500 dark:text-slate-400 md:col-span-3">
                    <span>Recovery notes</span>
                    <textarea
                      className="input-field min-h-[96px]"
                      value={policyForm.recoveryNotes}
                      onChange={(event) => setPolicyForm((current) => ({ ...current, recoveryNotes: event.target.value }))}
                    />
                  </label>
                </div>

                <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                  <div>{selectedHost.policy.rotation.nextRotationDueAt ? `Next rotation due ${formatDateTime(selectedHost.policy.rotation.nextRotationDueAt)}` : 'No next rotation due yet'}</div>
                  <div>{selectedHost.policy.rotation.nextRotationWindowEndsAt ? `Window ends ${formatDateTime(selectedHost.policy.rotation.nextRotationWindowEndsAt)}` : 'No rotation window end yet'}</div>
                  <div>{selectedHost.policy.recovery.windowStartsAt ? `Recovery window starts ${formatDateTime(selectedHost.policy.recovery.windowStartsAt)}` : 'No recovery window start yet'}</div>
                  <div>{selectedHost.policy.recovery.windowEndsAt ? `Recovery window ends ${formatDateTime(selectedHost.policy.recovery.windowEndsAt)}` : 'No recovery window end yet'}</div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
                    disabled={actionBusy === `policy-${selectedHost.id}`}
                    onClick={() => { void handleSavePolicy(selectedHost) }}
                  >
                    {actionBusy === `policy-${selectedHost.id}` ? 'Saving…' : 'Save policy'}
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">Routes</div>
                <div className="space-y-3">
                  {detailLoading && !hostDetail ? (
                    <EmptyPanel label="Loading routes…" />
                  ) : hostRoutes.length > 0 ? (
                    hostRoutes.map((route: OpenClawHostRoute) => (
                      <div key={route.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{route.displayName || route.beamId}</div>
                            <div className="truncate text-xs text-slate-500 dark:text-slate-400">{route.routeKey}</div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <StatusPill label={routeSourceLabel(route.routeSource)} />
                            <StatusPill label={route.runtimeSessionState} tone={routeStateTone(route.runtimeSessionState)} />
                            <StatusPill label={route.ownerResolutionState} tone={ownerResolutionTone(route.ownerResolutionState)} />
                          </div>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                          <div>{route.workspace ? `Workspace ${route.workspace.name}` : 'No workspace attached'}</div>
                          <div>{route.connectionMode ? `Transport ${route.connectionMode}` : 'No transport mode'}</div>
                          <div>{route.lastSeenAt ? `Last seen ${formatRelativeTime(route.lastSeenAt)}` : 'No last-seen timestamp'}</div>
                          <div>{route.endedAt ? `Ended ${formatRelativeTime(route.endedAt)}` : 'Still active in inventory'}</div>
                          <div>{route.ownerResolutionAt ? `Owner action ${formatRelativeTime(route.ownerResolutionAt)}${route.ownerResolutionActor ? ` · ${route.ownerResolutionActor}` : ''}` : 'No explicit owner action'}</div>
                          <div>{route.hostCredentialState ? `Host credential ${route.hostCredentialState}` : 'No host credential state'}</div>
                          <div>{route.lastDelivery ? `Last delivery ${formatRelativeTime(route.lastDelivery.requestedAt)} · ${route.lastDelivery.status}` : 'No delivery receipt yet'}</div>
                          <div>{route.lastDelivery?.errorCode ? `Last error ${route.lastDelivery.errorCode}` : 'No delivery error recorded'}</div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs">
                          <button
                            type="button"
                            className="text-orange-600 hover:text-orange-700 disabled:opacity-60 dark:text-orange-300"
                            disabled={actionBusy === `prefer-route-${route.id}`}
                            onClick={() => { void handlePreferRoute(route) }}
                          >
                            {actionBusy === `prefer-route-${route.id}` ? 'Preferring…' : 'Prefer route'}
                          </button>
                          <button
                            type="button"
                            className="text-orange-600 hover:text-orange-700 disabled:opacity-60 dark:text-orange-300"
                            disabled={actionBusy === `disable-route-${route.id}`}
                            onClick={() => { void handleDisableRoute(route) }}
                          >
                            {actionBusy === `disable-route-${route.id}` ? 'Disabling…' : 'Disable route'}
                          </button>
                          <button
                            type="button"
                            className="text-orange-600 hover:text-orange-700 disabled:opacity-60 dark:text-orange-300"
                            disabled={actionBusy === `clear-route-${route.id}`}
                            onClick={() => { void handleClearRouteOwner(route) }}
                          >
                            {actionBusy === `clear-route-${route.id}` ? 'Resetting…' : 'Reset owner'}
                          </button>
                          {route.httpEndpoint ? (
                            <a className="text-orange-600 hover:text-orange-700 dark:text-orange-300" href={route.httpEndpoint} rel="noreferrer" target="_blank">
                              Open HTTP endpoint
                            </a>
                          ) : null}
                          {route.workspace ? (
                            <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={`/workspaces?workspace=${encodeURIComponent(route.workspace.slug)}`}>
                              Open workspace
                            </Link>
                          ) : null}
                          {route.lastDelivery ? (
                            <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={route.lastDelivery.href}>
                              Open trace
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <EmptyPanel label="This host has not published any routes yet." />
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm font-medium text-slate-900 dark:text-slate-100">Heartbeat history</div>
                <div className="space-y-2">
                  {hostDetail?.heartbeats.length ? (
                    hostDetail.heartbeats.map((heartbeat) => (
                      <div key={heartbeat.id} className="rounded-2xl border border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>{formatDateTime(heartbeat.heartbeatAt)}</div>
                          <StatusPill label={heartbeat.healthStatus} tone={hostHealthTone(heartbeat.healthStatus)} />
                        </div>
                        <div className="mt-2">{`${formatNumber(heartbeat.routeCount)} routes · ${heartbeat.connectorVersion || 'unknown connector version'}`}</div>
                      </div>
                    ))
                  ) : (
                    <EmptyPanel label="No heartbeat history recorded yet." />
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">Identities on selected host</div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Beam IDs, workspace bindings, and route ownership for the currently selected host.
          </p>
          <div className="mt-4 space-y-3">
            {detailLoading && !hostIdentities ? (
              <EmptyPanel label="Loading identities…" />
            ) : identities.length > 0 ? (
              identities.map((identity) => (
                <div key={identity.beamId} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{identity.displayName || identity.beamId}</div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">{identity.beamId}</div>
                    </div>
                    <StatusPill label={identity.route.runtimeSessionState} tone={routeStateTone(identity.route.runtimeSessionState)} />
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <div>
                      {identity.route.lastDelivery
                        ? `Last delivery ${formatRelativeTime(identity.route.lastDelivery.requestedAt)} · ${identity.route.lastDelivery.status}${identity.route.lastDelivery.errorCode ? ` · ${identity.route.lastDelivery.errorCode}` : ''}`
                        : 'No delivery receipt yet'}
                    </div>
                    {identity.bindings.length > 0 ? (
                      identity.bindings.map((binding) => (
                        <div key={binding.id}>
                          {[
                            binding.workspaceName || binding.workspaceSlug || `Workspace ${binding.workspaceId}`,
                            binding.bindingType,
                            binding.status,
                            binding.owner ? `Owner ${binding.owner}` : 'No owner',
                          ].join(' · ')}
                        </div>
                      ))
                    ) : (
                      <div>No workspace bindings reference this Beam ID yet.</div>
                    )}
                  </div>
                  {identity.route.lastDelivery ? (
                    <div className="mt-3 text-xs">
                      <Link className="text-orange-600 hover:text-orange-700 dark:text-orange-300" to={identity.route.lastDelivery.href}>
                        Open trace
                      </Link>
                    </div>
                  ) : null}
                </div>
              ))
            ) : (
              <EmptyPanel label="No identities published for this host yet." />
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
