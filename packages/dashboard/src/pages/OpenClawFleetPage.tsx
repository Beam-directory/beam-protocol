import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyPanel, MetricCard, PageHeader, StatusPill } from '../components/Observability'
import {
  ApiError,
  directoryApi,
  type OpenClawConflictGroup,
  type OpenClawEnrollmentCreateInput,
  type OpenClawFleetOverviewResponse,
  type OpenClawHostDetailResponse,
  type OpenClawHostHealth,
  type OpenClawHostIdentitiesResponse,
  type OpenClawInstallPack,
  type OpenClawHostRoute,
  type OpenClawHostSummary,
  type OpenClawHostStatus,
  type OpenClawRouteRuntimeState,
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

function conflictSummary(group: OpenClawConflictGroup): string {
  return `${group.routeCount} active host routes claim ${group.beamId}`
}

export default function OpenClawFleetPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [overview, setOverview] = useState<OpenClawFleetOverviewResponse | null>(null)
  const [hostDetail, setHostDetail] = useState<OpenClawHostDetailResponse | null>(null)
  const [hostIdentities, setHostIdentities] = useState<OpenClawHostIdentitiesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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

  const selectedHostId = useMemo(() => {
    const raw = searchParams.get('host')
    if (!raw) return null
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [searchParams])

  const selectedHost = useMemo(
    () => overview?.hosts.find((host) => host.id === selectedHostId) ?? overview?.hosts[0] ?? null,
    [overview, selectedHostId],
  )

  async function loadOverview() {
    const response = await directoryApi.getOpenClawFleetOverview()
    setOverview(response)
  }

  async function loadHost(id: number) {
    const [detailResponse, identitiesResponse] = await Promise.all([
      directoryApi.getOpenClawHost(id),
      directoryApi.getOpenClawHostIdentities(id),
    ])
    setHostDetail(detailResponse)
    setHostIdentities(identitiesResponse)
  }

  async function refreshAll(nextHostId?: number | null) {
    try {
      setLoading(true)
      setError(null)
      await loadOverview()
      const hostId = nextHostId ?? selectedHostId
      if (hostId) {
        await loadHost(hostId)
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
    if (!overview?.hosts.length) {
      setHostDetail(null)
      setHostIdentities(null)
      return
    }

    const nextHost = overview.hosts.find((host) => host.id === selectedHostId) ?? overview.hosts[0]
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
  }, [overview, searchParams, selectedHostId, setSearchParams])

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
      await loadOverview()
    }, 'Enrollment token issued.')
  }

  async function handleApprove(host: OpenClawHostSummary) {
    await runAction(`approve-${host.id}`, async () => {
      const response = await directoryApi.approveOpenClawHost(host.id)
      setNotice(`Host ${hostTitle(response.host)} approved. Credential issued.`)
      await loadOverview()
      await loadHost(host.id)
    }, `Host ${hostTitle(host)} approved.`)
  }

  async function handleRevoke(host: OpenClawHostSummary) {
    const reason = host.status === 'revoked'
      ? host.revocationReason ?? 'Host revoked'
      : `Revoked by operator on ${new Date().toISOString()}`
    await runAction(`revoke-${host.id}`, async () => {
      await directoryApi.revokeOpenClawHost(host.id, { reason })
      await loadOverview()
      await loadHost(host.id)
    }, `Host ${hostTitle(host)} revoked.`)
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

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Hosts" value={!overview ? '—' : formatNumber(overview.summary.totalHosts)} />
        <MetricCard label="Active hosts" value={!overview ? '—' : formatNumber(overview.summary.activeHosts)} tone={(overview?.summary.activeHosts ?? 0) > 0 ? 'success' : 'default'} />
        <MetricCard label="Pending hosts" value={!overview ? '—' : formatNumber(overview.summary.pendingHosts)} tone={(overview?.summary.pendingHosts ?? 0) > 0 ? 'warning' : 'default'} />
        <MetricCard label="Live routes" value={!overview ? '—' : formatNumber(overview.summary.liveRoutes)} tone={(overview?.summary.liveRoutes ?? 0) > 0 ? 'success' : 'default'} />
        <MetricCard label="Duplicate conflicts" value={!overview ? '—' : formatNumber(overview.summary.duplicateIdentityConflicts)} tone={(overview?.summary.duplicateIdentityConflicts ?? 0) > 0 ? 'critical' : 'default'} />
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
              {!overview ? 'Loading…' : `${formatNumber(overview.hosts.length)} visible`}
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {loading && !overview ? (
              <EmptyPanel label="Loading host fleet…" />
            ) : overview && overview.hosts.length > 0 ? (
              overview.hosts.map((host) => {
                const active = selectedHost?.id === host.id
                return (
                  <button
                    key={host.id}
                    type="button"
                    className={`w-full rounded-2xl border p-4 text-left transition ${active ? 'border-orange-300 bg-orange-50/50 dark:border-orange-500/40 dark:bg-orange-500/10' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900/60'}`}
                    onClick={() => {
                      const next = new URLSearchParams(searchParams)
                      next.set('host', String(host.id))
                      setSearchParams(next)
                    }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{hostTitle(host)}</div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">{hostMeta(host)}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusPill label={host.status} tone={hostStatusTone(host.status)} />
                        <StatusPill label={host.healthStatus} tone={hostHealthTone(host.healthStatus)} />
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                      <div>{`${formatNumber(host.summary.live)} live · ${formatNumber(host.summary.stale)} stale · ${formatNumber(host.summary.conflict)} conflict`}</div>
                      <div>{`${formatNumber(host.summary.unavailable)} unavailable · ${formatNumber(host.summary.revoked)} revoked`}</div>
                      <div>{host.lastInventoryAt ? `Inventory ${formatRelativeTime(host.lastInventoryAt)}` : 'No inventory yet'}</div>
                      <div>{host.summary.delivery.receipts > 0 ? `${formatNumber(host.summary.delivery.receipts)} receipts · ${formatNumber(host.summary.delivery.failed)} failed` : 'No delivery receipts yet'}</div>
                      <div>{host.approvedAt ? `Approved ${formatRelativeTime(host.approvedAt)}` : 'Waiting for approval'}</div>
                      <div>{host.revokedAt ? `Revoked ${formatRelativeTime(host.revokedAt)}` : 'Credential active or pending'}</div>
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
                    </div>
                  </button>
                )
              })
            ) : (
              <EmptyPanel label="No OpenClaw hosts have enrolled yet." />
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
              <div key={group.beamId} className="rounded-2xl border border-red-200 bg-red-50/60 p-4 dark:border-red-500/30 dark:bg-red-500/10">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-red-700 dark:text-red-200">{group.beamId}</div>
                    <div className="text-xs text-red-600/80 dark:text-red-200/80">{conflictSummary(group)}</div>
                  </div>
                  <StatusPill label={`${group.routeCount} conflicting routes`} tone="critical" />
                </div>
                <div className="mt-3 grid gap-2 text-xs text-red-700/80 dark:text-red-200/80 md:grid-cols-2">
                  {group.routes.map((route) => (
                    <div key={`${route.hostId}-${route.routeKey}`}>
                      {[
                        route.hostLabel || route.hostname,
                        route.workspaceSlug ? `Workspace ${route.workspaceSlug}` : 'No workspace',
                        routeSourceLabel(route.routeSource),
                      ].join(' · ')}
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <EmptyPanel label="No duplicate identity conflicts are active." />
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
                <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                  <div>{selectedHost.approvedBy ? `Approved by ${selectedHost.approvedBy}` : 'No approval recorded yet'}</div>
                  <div>{selectedHost.beamDirectoryUrl}</div>
                  <div>{selectedHost.lastRouteEventAt ? `Last route event ${formatRelativeTime(selectedHost.lastRouteEventAt)}` : 'No route events yet'}</div>
                  <div>{selectedHost.revocationReason ? `Revocation reason: ${selectedHost.revocationReason}` : 'Not revoked'}</div>
                  <div>{`${formatNumber(selectedHost.summary.unavailable)} unavailable · ${formatNumber(selectedHost.summary.revoked)} revoked routes`}</div>
                  <div>{selectedHost.summary.delivery.lastRequestedAt ? `Last receipt ${formatRelativeTime(selectedHost.summary.delivery.lastRequestedAt)} · ${selectedHost.summary.delivery.lastStatus ?? 'unknown'}` : 'No delivery receipts yet'}</div>
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
                          </div>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-slate-500 dark:text-slate-400 md:grid-cols-2">
                          <div>{route.workspace ? `Workspace ${route.workspace.name}` : 'No workspace attached'}</div>
                          <div>{route.connectionMode ? `Transport ${route.connectionMode}` : 'No transport mode'}</div>
                          <div>{route.lastSeenAt ? `Last seen ${formatRelativeTime(route.lastSeenAt)}` : 'No last-seen timestamp'}</div>
                          <div>{route.endedAt ? `Ended ${formatRelativeTime(route.endedAt)}` : 'Still active in inventory'}</div>
                          <div>{route.lastDelivery ? `Last delivery ${formatRelativeTime(route.lastDelivery.requestedAt)} · ${route.lastDelivery.status}` : 'No delivery receipt yet'}</div>
                          <div>{route.lastDelivery?.errorCode ? `Last error ${route.lastDelivery.errorCode}` : 'No delivery error recorded'}</div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs">
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
