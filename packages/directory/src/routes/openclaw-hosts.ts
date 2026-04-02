import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import { isEmailDeliveryConfigured, sendOperatorDigestEmail } from '../email.js'
import {
  applyOpenClawHostRouteEvents,
  approveOpenClawHost,
  createOpenClawEnrollmentRequest,
  createOpenClawFleetDigestRun,
  createOpenClawHost,
  getAgent,
  getLatestIntentLogByTarget,
  getOpenClawFleetDigestRunById,
  getOpenClawFleetDigestSchedule,
  getOpenClawEnrollmentRequestById,
  getOpenClawEnrollmentRequestByKey,
  getOpenClawHostByEnrollmentRequestId,
  getOpenClawHostById,
  getOpenClawHostByKey,
  getOpenClawHostRouteById,
  getWorkspaceById,
  getWorkspaceBySlug,
  listOpenClawEnrollmentRequests,
  listOpenClawFleetDigestDeliveries,
  listOpenClawFleetDigestRuns,
  listOpenClawHostHeartbeats,
  listOpenClawHosts,
  listOpenClawResolvedRoutesByBeamId,
  listOpenClawResolvedRoutesForHost,
  listAuditLog,
  listWorkspaceIdentityBindingsByBeamId,
  logAuditEvent,
  recordOpenClawHostHeartbeat,
  recalculateOpenClawRouteStates,
  recoverOpenClawHost,
  refreshOpenClawHostHealth,
  revokeOpenClawHost,
  resolveOpenClawHostCredential,
  rotateOpenClawHostCredential,
  recordOpenClawFleetDigestDelivery,
  setOpenClawRouteOwnerResolution,
  syncOpenClawHostRoutes,
  updateOpenClawEnrollmentRequest,
  updateOpenClawFleetDigestSchedule,
  updateOpenClawHost,
} from '../db.js'
import { getSuppliedApiKey, hostApiKeyMatches, hostKeyFromApiKey } from '../api-key.js'
import type {
  IntentLogRow,
  OpenClawFleetDigestDeliveryKind,
  OpenClawFleetDigestDeliveryRow,
  OpenClawFleetDigestDeliveryStatus,
  OpenClawFleetDigestRunDeliveryState,
  OpenClawFleetDigestRunRow,
  OpenClawFleetDigestRunTriggerKind,
  OpenClawFleetDigestScheduleRow,
  OpenClawHostCredentialState,
  OpenClawHostEnrollmentRequestRow,
  OpenClawHostHealth,
  OpenClawHostRow,
  OpenClawHostRouteRow,
  OpenClawRouteOwnerResolutionState,
  OpenClawResolvedRouteRow,
  OpenClawRouteReportedState,
  OpenClawRouteRuntimeState,
  OpenClawRouteSource,
} from '../types.js'

type OpenClawFleetDigestSeverity = 'warning' | 'critical'

type OpenClawFleetDigestCategory = 'host' | 'credential' | 'conflict' | 'delivery'

type OpenClawFleetDigestItem = {
  id: string
  severity: OpenClawFleetDigestSeverity
  category: OpenClawFleetDigestCategory
  title: string
  detail: string
  nextAction: string
  hostId: number | null
  hostLabel: string | null
  workspaceSlug: string | null
  href: string | null
  traceHref: string | null
}

type OpenClawFleetEscalation = OpenClawFleetDigestItem

type SerializedOpenClawFleetDigestSchedule = {
  enabled: boolean
  deliveryEmail: string | null
  escalationEmail: string | null
  runHourUtc: number
  runMinuteUtc: number
  escalateOnCritical: boolean
  lastScheduledForAt: string | null
  lastRunAt: string | null
  lastDeliveryAt: string | null
  lastEscalationDeliveryAt: string | null
  nextRunAt: string | null
}

type SerializedOpenClawFleetDigestRun = {
  id: number
  triggerKind: OpenClawFleetDigestRunTriggerKind
  actor: string | null
  generatedAt: string
  deliveryState: OpenClawFleetDigestRunDeliveryState
  lastDeliveryErrorCode: string | null
  summary: {
    actionItems: number
    criticalItems: number
    staleHosts: number
    failedReceipts: number
    duplicateIdentityConflicts: number
    escalations: number
  }
}

type SerializedOpenClawFleetDigestDelivery = {
  id: number
  runId: number | null
  runGeneratedAt: string | null
  kind: OpenClawFleetDigestDeliveryKind
  status: OpenClawFleetDigestDeliveryStatus
  recipientEmail: string
  errorCode: string | null
  errorMessage: string | null
  deliveredAt: string
  summary: {
    actionItems: number
    criticalItems: number
    escalations: number
  } | null
}

type OpenClawConflictGroup = {
  beamId: string
  routeCount: number
  selectedOwnerRouteId: number | null
  recommendedRouteId: number | null
  recommendedReason: string | null
  routes: Array<{
    routeId: number
    hostId: number
    hostLabel: string | null
    hostname: string
    workspaceSlug: string | null
    routeKey: string
    routeSource: string
    ownerResolutionState: OpenClawRouteOwnerResolutionState
    ownerResolutionActor: string | null
    ownerResolutionAt: string | null
    ownerResolutionNote: string | null
    runtimeSessionState: OpenClawRouteRuntimeState
    hostHealth: OpenClawHostHealth
    lastSeenAt: string | null
    lastDeliveryStatus: IntentLogRow['status'] | null
    lastDeliveryHref: string | null
  }>
}

type OpenClawConflictHistoryItem = {
  id: string
  source: 'route' | 'host'
  action: string
  actor: string | null
  timestamp: string
  note: string | null
  routeId: number | null
  hostId: number | null
  href: string | null
}

type OpenClawHostRotationReviewState = 'scheduled' | 'due_soon' | 'overdue'

type OpenClawHostRecoveryRunbookState = 'idle' | 'prepared' | 'cutover_pending' | 'completed'

type OpenClawHostEnvironmentSummary = {
  label: string
  hostCount: number
  staleHosts: number
  degradedHosts: number
  pendingHosts: number
  hostIds: number[]
}

type OpenClawHostGroupSummary = {
  label: string
  hostCount: number
  staleHosts: number
  degradedHosts: number
  pendingHosts: number
  environments: string[]
  hostIds: number[]
}

type OpenClawFleetCredentialPolicyAttentionHost = {
  hostId: number
  hostLabel: string | null
  workspaceSlug: string | null
  healthStatus: OpenClawHostHealth
  credentialState: OpenClawHostCredentialState
  credentialAgeHours: number | null
  rotationReviewState: OpenClawHostRotationReviewState
  nextRotationDueAt: string | null
  nextRotationWindowStartsAt: string | null
  nextRotationWindowEndsAt: string | null
  dueInHours: number | null
  windowOpen: boolean
  recoveryStatus: OpenClawHostRecoveryRunbookState
  recoveryOwner: string | null
  cleanupRecommended: boolean
  reasons: string[]
  severity: OpenClawFleetDigestSeverity
  href: string
  workspaceHref: string | null
}

type OpenClawFleetCredentialPolicySummary = {
  counts: {
    overdue: number
    dueSoon: number
    windowOpen: number
    rotationPending: number
    recoveryPrepared: number
    recoveryCutover: number
    recoveryCompleted: number
    cleanupRecommended: number
    missingRecoveryOwner: number
  }
  attentionHosts: OpenClawFleetCredentialPolicyAttentionHost[]
}

type OpenClawFleetRouteHealthAttentionHost = {
  hostId: number
  hostLabel: string | null
  workspaceSlug: string | null
  healthStatus: OpenClawHostHealth
  receiptCoverageRatio: number | null
  missingReceipts: number
  failedReceipts: number
  activeRoutes: number
  p95LatencyMs: number | null
  overSlo: number
  reasons: string[]
  severity: OpenClawFleetDigestSeverity
  href: string
  workspaceHref: string | null
  traceHref: string | null
}

type OpenClawFleetRouteHealthSummary = {
  summary: {
    targetLatencyMs: number
    activeRoutes: number
    routesWithReceipts: number
    routesMissingReceipts: number
    receiptCoverageRatio: number | null
    failedReceipts: number
    degradedHosts: number
    hostsWithMissingReceipts: number
    hostsWithFailedReceipts: number
  }
  latency: {
    samples: number
    avgMs: number | null
    p50Ms: number | null
    p95Ms: number | null
    overSlo: number
    overDoubleSlo: number
    buckets: {
      withinTarget: number
      overTarget: number
      overDoubleTarget: number
    }
  }
  attentionHosts: OpenClawFleetRouteHealthAttentionHost[]
}

type OpenClawFleetBulkAction =
  | 'apply_labels'
  | 'stage_revoke_review'
  | 'clear_revoke_review'

type OpenClawHostMetadataJson = {
  credentialPolicy?: {
    rotationIntervalHours?: number | null
    rotationWindowStartHour?: number | null
    rotationWindowDurationHours?: number | null
  }
  recoveryRunbook?: {
    owner?: string | null
    status?: OpenClawHostRecoveryRunbookState | null
    notes?: string | null
    replacementHostLabel?: string | null
    windowStartsAt?: string | null
    windowEndsAt?: string | null
    updatedAt?: string | null
  }
  placement?: {
    environmentLabel?: string | null
    groupLabels?: string[] | null
    owner?: string | null
    revokeReviewRequestedAt?: string | null
    revokeReviewRequestedBy?: string | null
    revokeReviewReason?: string | null
  }
}

const DEFAULT_OPENCLAW_ROTATION_INTERVAL_HOURS = 24 * 30
const DEFAULT_OPENCLAW_ROTATION_WINDOW_START_HOUR = 2
const DEFAULT_OPENCLAW_ROTATION_WINDOW_DURATION_HOURS = 4
const OPENCLAW_ROTATION_DUE_SOON_HOURS = 72
const OPENCLAW_ROUTE_LATENCY_SLO_MS = 5_000
const OPENCLAW_ROUTE_LATENCY_LOOKBACK_HOURS = 24 * 7
const OPENCLAW_ROUTE_LATENCY_LOG_LIMIT = 500

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizeBoundedInteger(value: unknown, min: number, max: number): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return Math.min(max, Math.max(min, parsed))
}

function normalizeIsoDateTime(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  if (!normalized) {
    return null
  }
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function normalizeOptionalStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const normalized = [...new Set(value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean))]
  return normalized
}

function normalizeOpenClawRouteSource(value: unknown): OpenClawRouteSource | null {
  return value === 'agent-folder' || value === 'workspace-agent' || value === 'gateway-agent' || value === 'subagent-run'
    ? value
    : null
}

function normalizeReportedState(value: unknown): OpenClawRouteReportedState | null {
  return value === 'live' || value === 'idle' || value === 'ended'
    ? value
    : null
}

function normalizeConnectionMode(value: unknown): OpenClawHostRouteRow['connection_mode'] {
  return value === 'websocket' || value === 'http' || value === 'hybrid' || value === 'unavailable'
    ? value
    : null
}

function normalizeHours(value: unknown, fallback = 72): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.min(24 * 30, parsed)
}

function nowPlusHoursIso(hours: number): string {
  return new Date(Date.now() + (hours * 60 * 60 * 1000)).toISOString()
}

function hoursSince(value: string | null): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return Math.round(((Date.now() - parsed) / 3_600_000) * 10) / 10
}

function hoursUntil(value: string | null): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return Math.round(((parsed - Date.now()) / 3_600_000) * 10) / 10
}

function parseOpenClawHostMetadata(raw: string | null): OpenClawHostMetadataJson {
  if (!raw) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return parsed as OpenClawHostMetadataJson
  } catch {
    return {}
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function serializeOpenClawHostMetadata(metadata: OpenClawHostMetadataJson): string | null {
  const cleaned: OpenClawHostMetadataJson = {}
  if (metadata.credentialPolicy) {
    cleaned.credentialPolicy = metadata.credentialPolicy
  }
  if (metadata.recoveryRunbook) {
    cleaned.recoveryRunbook = metadata.recoveryRunbook
  }
  if (metadata.placement) {
    cleaned.placement = metadata.placement
  }
  if (!cleaned.credentialPolicy && !cleaned.recoveryRunbook && !cleaned.placement) {
    return null
  }
  return JSON.stringify(cleaned)
}

function computeNextRotationWindow(
  issuedAt: string | null,
  intervalHours: number,
  windowStartHour: number,
  windowDurationHours: number,
) {
  const issuedMs = issuedAt ? Date.parse(issuedAt) : Number.NaN
  if (!Number.isFinite(issuedMs)) {
    return {
      nextRotationDueAt: null as string | null,
      nextRotationWindowStartsAt: null as string | null,
      nextRotationWindowEndsAt: null as string | null,
      dueInHours: null as number | null,
      windowOpen: false,
      hoursUntilWindowStarts: null as number | null,
      reviewState: 'scheduled' as OpenClawHostRotationReviewState,
    }
  }

  const dueMs = issuedMs + (intervalHours * 60 * 60 * 1000)
  const dueAt = new Date(dueMs)
  const windowStart = new Date(dueMs)
  windowStart.setUTCMinutes(0, 0, 0)
  windowStart.setUTCHours(windowStartHour)
  if (windowStart.getTime() < dueMs) {
    windowStart.setUTCDate(windowStart.getUTCDate() + 1)
  }
  const windowEnd = new Date(windowStart.getTime() + (windowDurationHours * 60 * 60 * 1000))
  const dueInHours = hoursUntil(dueAt.toISOString())
  const now = Date.now()
  const reviewState: OpenClawHostRotationReviewState =
    dueMs <= now
      ? 'overdue'
      : dueMs <= (now + (OPENCLAW_ROTATION_DUE_SOON_HOURS * 60 * 60 * 1000))
        ? 'due_soon'
        : 'scheduled'

  return {
    nextRotationDueAt: dueAt.toISOString(),
    nextRotationWindowStartsAt: windowStart.toISOString(),
    nextRotationWindowEndsAt: windowEnd.toISOString(),
    dueInHours,
    windowOpen: now >= windowStart.getTime() && now <= windowEnd.getTime(),
    hoursUntilWindowStarts: hoursUntil(windowStart.toISOString()),
    reviewState,
  }
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) {
    return null
  }

  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index] ?? null
}

function listRecentIntentLogsByTargets(db: Database, targetBeamIds: string[]) {
  const uniqueTargetBeamIds = [...new Set(targetBeamIds.filter(Boolean))]
  if (uniqueTargetBeamIds.length === 0) {
    return [] as IntentLogRow[]
  }

  const placeholders = uniqueTargetBeamIds.map(() => '?').join(', ')
  const cutoffIso = new Date(Date.now() - (OPENCLAW_ROUTE_LATENCY_LOOKBACK_HOURS * 60 * 60 * 1000)).toISOString()
  return db.prepare(`
    SELECT *
    FROM intent_log
    WHERE to_beam_id IN (${placeholders})
      AND datetime(requested_at) >= datetime(?)
    ORDER BY datetime(requested_at) DESC, id DESC
    LIMIT ?
  `).all(...uniqueTargetBeamIds, cutoffIso, OPENCLAW_ROUTE_LATENCY_LOG_LIMIT) as IntentLogRow[]
}

function serializeOpenClawHostPolicy(host: OpenClawHostRow) {
  const metadata = parseOpenClawHostMetadata(host.metadata_json)
  const rotationPolicy = metadata.credentialPolicy && typeof metadata.credentialPolicy === 'object'
    ? metadata.credentialPolicy
    : {}
  const recoveryRunbook = metadata.recoveryRunbook && typeof metadata.recoveryRunbook === 'object'
    ? metadata.recoveryRunbook
    : {}

  const rotationIntervalHours = normalizeBoundedInteger(rotationPolicy.rotationIntervalHours, 1, 24 * 180)
    ?? DEFAULT_OPENCLAW_ROTATION_INTERVAL_HOURS
  const rotationWindowStartHour = normalizeBoundedInteger(rotationPolicy.rotationWindowStartHour, 0, 23)
    ?? DEFAULT_OPENCLAW_ROTATION_WINDOW_START_HOUR
  const rotationWindowDurationHours = normalizeBoundedInteger(rotationPolicy.rotationWindowDurationHours, 1, 24)
    ?? DEFAULT_OPENCLAW_ROTATION_WINDOW_DURATION_HOURS
  const nextRotation = computeNextRotationWindow(
    host.credential_issued_at,
    rotationIntervalHours,
    rotationWindowStartHour,
    rotationWindowDurationHours,
  )

  const rawRecoveryStatus = recoveryRunbook.status === 'prepared'
    || recoveryRunbook.status === 'cutover_pending'
    || recoveryRunbook.status === 'completed'
    || recoveryRunbook.status === 'idle'
    ? recoveryRunbook.status
    : null
  const recoveryStatus: OpenClawHostRecoveryRunbookState =
    host.credential_state === 'recovery_pending'
      ? 'cutover_pending'
      : rawRecoveryStatus === 'idle'
        ? 'idle'
        : host.recovery_completed_at
          ? 'completed'
          : (rawRecoveryStatus ?? 'idle')
  const recoveryNotes = normalizeOptionalString(recoveryRunbook.notes)
  const replacementHostLabel = normalizeOptionalString(recoveryRunbook.replacementHostLabel)
  const recoveryWindowStartsAt = normalizeIsoDateTime(recoveryRunbook.windowStartsAt)
  const recoveryWindowEndsAt = normalizeIsoDateTime(recoveryRunbook.windowEndsAt)
  const cleanupRecommended =
    recoveryStatus === 'completed'
    && Boolean(
      recoveryNotes
      || replacementHostLabel
      || recoveryWindowStartsAt
      || recoveryWindowEndsAt
      || rawRecoveryStatus === 'completed',
    )

  return {
    rotation: {
      intervalHours: rotationIntervalHours,
      windowStartHour: rotationWindowStartHour,
      windowDurationHours: rotationWindowDurationHours,
      nextRotationDueAt: nextRotation.nextRotationDueAt,
      nextRotationWindowStartsAt: nextRotation.nextRotationWindowStartsAt,
      nextRotationWindowEndsAt: nextRotation.nextRotationWindowEndsAt,
      dueInHours: nextRotation.dueInHours,
      windowOpen: nextRotation.windowOpen,
      hoursUntilWindowStarts: nextRotation.hoursUntilWindowStarts,
      reviewState: nextRotation.reviewState,
    },
    recovery: {
      owner: normalizeOptionalString(recoveryRunbook.owner),
      status: recoveryStatus,
      notes: recoveryNotes,
      replacementHostLabel,
      windowStartsAt: recoveryWindowStartsAt,
      windowEndsAt: recoveryWindowEndsAt,
      updatedAt: normalizeIsoDateTime(recoveryRunbook.updatedAt) ?? host.recovery_completed_at,
      cleanupRecommended,
    },
  }
}

function serializeOpenClawHostPlacement(host: OpenClawHostRow) {
  const metadata = parseOpenClawHostMetadata(host.metadata_json)
  const placement = metadata.placement && typeof metadata.placement === 'object'
    ? metadata.placement
    : {}

  return {
    environmentLabel: normalizeOptionalString(placement.environmentLabel),
    groupLabels: normalizeOptionalStringArray(placement.groupLabels) ?? [],
    owner: normalizeOptionalString(placement.owner),
    revokeReviewRequestedAt: normalizeIsoDateTime(placement.revokeReviewRequestedAt),
    revokeReviewRequestedBy: normalizeOptionalString(placement.revokeReviewRequestedBy),
    revokeReviewReason: normalizeOptionalString(placement.revokeReviewReason),
  }
}

function buildOpenClawHostPlacementPatch(
  host: OpenClawHostRow,
  input: {
    environmentLabel?: string | null
    groupLabels?: string[] | null
    owner?: string | null
    clearRevokeReview?: boolean
    stageRevokeReview?: {
      requestedAt: string
      requestedBy: string
      reason: string
    } | null
  },
) {
  const metadata = parseOpenClawHostMetadata(host.metadata_json)
  const currentPlacement = serializeOpenClawHostPlacement(host)
  const nextPlacement = {
    environmentLabel: input.environmentLabel !== undefined
      ? normalizeOptionalString(input.environmentLabel)
      : currentPlacement.environmentLabel,
    groupLabels: input.groupLabels !== undefined
      ? (normalizeOptionalStringArray(input.groupLabels) ?? [])
      : currentPlacement.groupLabels,
    owner: input.owner !== undefined
      ? normalizeOptionalString(input.owner)
      : currentPlacement.owner,
    revokeReviewRequestedAt: currentPlacement.revokeReviewRequestedAt,
    revokeReviewRequestedBy: currentPlacement.revokeReviewRequestedBy,
    revokeReviewReason: currentPlacement.revokeReviewReason,
  }

  if (input.clearRevokeReview) {
    nextPlacement.revokeReviewRequestedAt = null
    nextPlacement.revokeReviewRequestedBy = null
    nextPlacement.revokeReviewReason = null
  }

  if (input.stageRevokeReview) {
    nextPlacement.revokeReviewRequestedAt = input.stageRevokeReview.requestedAt
    nextPlacement.revokeReviewRequestedBy = input.stageRevokeReview.requestedBy
    nextPlacement.revokeReviewReason = input.stageRevokeReview.reason
  }

  const nextMetadata: OpenClawHostMetadataJson = {
    ...metadata,
    placement: nextPlacement,
  }

  return {
    placement: nextPlacement,
    metadataJson: serializeOpenClawHostMetadata(nextMetadata),
  }
}

function serializeEnrollment(row: OpenClawHostEnrollmentRequestRow | null) {
  if (!row) {
    return null
  }

  return {
    id: row.id,
    label: row.label,
    workspaceSlug: row.workspace_slug,
    notes: row.notes,
    status: row.status,
    claimedHostId: row.claimed_host_id,
    claimedAt: row.claimed_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildOpenClawInstallPack(input: {
  directoryUrl: string
  workspaceSlug: string | null
  token: string
  label: string | null
}) {
  const directoryUrl = input.directoryUrl
  const workspaceSlug = input.workspaceSlug ?? 'openclaw-local'
  const baseArgs = [
    '--directory-url',
    shellQuote(directoryUrl),
    '--workspace',
    shellQuote(workspaceSlug),
    '--enrollment-token',
    shellQuote(input.token),
  ]

  if (input.label) {
    baseArgs.push('--host-label', shellQuote(input.label))
  }

  const joinedArgs = baseArgs.join(' ')
  return {
    directoryUrl,
    workspaceSlug,
    commands: {
      managedMacos: `npm run workspace:openclaw-host:install -- ${joinedArgs}`,
      managedLinux: `npm run workspace:openclaw-host:install -- ${joinedArgs}`,
      foregroundDebug: `npm run workspace:openclaw-host -- ${joinedArgs}`,
      status: 'npm run workspace:openclaw-status',
      uninstall: 'npm run workspace:openclaw-host:uninstall',
    },
  }
}

function buildIntentHref(nonce: string): string {
  return `/intents/${encodeURIComponent(nonce)}`
}

function buildOpenClawFleetHref(hostId: number | null = null): string {
  if (typeof hostId === 'number' && hostId > 0) {
    return `/openclaw-fleet?host=${hostId}`
  }
  return '/openclaw-fleet'
}

function buildOpenClawConflictHref(beamId: string): string {
  return `/openclaw-fleet?conflict=${encodeURIComponent(beamId)}`
}

function buildWorkspaceHref(workspaceSlug: string | null): string | null {
  if (!workspaceSlug) {
    return null
  }
  return `/workspaces?workspace=${encodeURIComponent(workspaceSlug)}`
}

function absoluteHref(baseUrl: string, href: string | null): string | null {
  if (!href) {
    return null
  }
  return new URL(href, baseUrl).toString()
}

function hostCredentialAgeHours(host: Pick<OpenClawHostRow, 'credential_issued_at'>): number | null {
  return hoursSince(host.credential_issued_at)
}

function buildCredentialRefreshPack(input: {
  directoryUrl: string
  credential: string
  statePath?: string
}) {
  const statePath = input.statePath ?? '$HOME/.openclaw/workspace/secrets/beam-openclaw-host.json'
  return {
    commands: {
      useCredential: `npm run workspace:openclaw-host:use-credential -- --credential ${shellQuote(input.credential)} --state-path ${shellQuote(statePath)} --directory-url ${shellQuote(input.directoryUrl)}`,
      foregroundDebug: `npm run workspace:openclaw-host -- use-credential --credential ${shellQuote(input.credential)} --state-path ${shellQuote(statePath)} --directory-url ${shellQuote(input.directoryUrl)}`,
    },
  }
}

function serializeLatestRouteDelivery(log: IntentLogRow | null) {
  if (!log) {
    return null
  }

  return {
    nonce: log.nonce,
    intentType: log.intent_type,
    status: log.status,
    errorCode: log.error_code,
    requestedAt: log.requested_at,
    completedAt: log.completed_at,
    latencyMs: log.round_trip_latency_ms,
    href: buildIntentHref(log.nonce),
  }
}

function serializeRoute(db: Database, row: OpenClawResolvedRouteRow) {
  const workspace = row.workspace_slug ? getWorkspaceBySlug(db, row.workspace_slug) : null
  const bindings = listWorkspaceIdentityBindingsByBeamId(db, row.beam_id)
  const displayName = getAgent(db, row.beam_id)?.display_name ?? null
  const latestDelivery = serializeLatestRouteDelivery(getLatestIntentLogByTarget(db, row.beam_id))

  return {
    id: row.id,
    beamId: row.beam_id,
    workspaceSlug: row.workspace_slug,
    workspace: workspace ? {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
    } : null,
    routeSource: row.route_source,
    routeKey: row.route_key,
    runtimeType: row.runtime_type,
    label: row.label,
    displayName,
    connectionMode: row.connection_mode,
    httpEndpoint: row.http_endpoint,
    sessionKey: row.session_key,
    reportedState: row.reported_state,
    runtimeSessionState: row.runtime_session_state,
    ownerResolutionState: row.owner_resolution_state,
    ownerResolutionActor: row.owner_resolution_actor,
    ownerResolutionAt: row.owner_resolution_at,
    ownerResolutionNote: row.owner_resolution_note,
    hostId: row.host_id,
    hostLabel: row.host_label,
    hostHealth: row.host_health_status,
    hostCredentialState: row.host_credential_state,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : null,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at,
    lastDelivery: latestDelivery,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bindings: bindings.map((binding) => ({
      id: binding.id,
      workspaceId: binding.workspace_id,
      bindingType: binding.binding_type,
      status: binding.status,
      owner: binding.owner,
      runtimeType: binding.runtime_type,
    })),
  }
}

function rankConflictRoute(route: ReturnType<typeof serializeRoute>) {
  let score = 0
  const reasons: string[] = []

  switch (route.hostHealth) {
    case 'healthy':
      score += 50
      reasons.push('healthy host heartbeat')
      break
    case 'watch':
      score += 25
      reasons.push('host is still connected')
      break
    case 'pending':
      score += 5
      break
    case 'stale':
    case 'revoked':
      score -= 50
      break
  }

  switch (route.connectionMode) {
    case 'websocket':
      score += 20
      reasons.push('live websocket receiver')
      break
    case 'hybrid':
      score += 16
      reasons.push('hybrid receiver path')
      break
    case 'http':
      score += 10
      reasons.push('HTTP receiver path')
      break
    default:
      break
  }

  switch (route.routeSource) {
    case 'gateway-agent':
      score += 12
      reasons.push('gateway route')
      break
    case 'workspace-agent':
      score += 8
      break
    case 'agent-folder':
      score += 6
      break
    case 'subagent-run':
      score += 2
      break
  }

  if (route.lastDelivery?.status === 'acked') {
    score += 12
    reasons.push('recent successful delivery')
  } else if (route.lastDelivery?.status === 'failed') {
    score -= 12
  }

  if (route.ownerResolutionState === 'preferred') {
    score += 10
    reasons.push('already preferred previously')
  }

  const lastSeenMs = route.lastSeenAt ? Date.parse(route.lastSeenAt) : Number.NaN
  if (Number.isFinite(lastSeenMs)) {
    const ageMinutes = (Date.now() - lastSeenMs) / 60_000
    if (ageMinutes <= 5) {
      score += 15
      reasons.push('very recent heartbeat')
    } else if (ageMinutes <= 30) {
      score += 8
    } else if (ageMinutes > 180) {
      score -= 8
    }
  }

  if (route.runtimeSessionState === 'conflict') {
    score += 4
  } else if (route.runtimeSessionState === 'stale' || route.runtimeSessionState === 'revoked') {
    score -= 20
  }

  return {
    score,
    reason: reasons.slice(0, 3).join(' · ') || 'best available route based on health and delivery signals',
  }
}

function summarizeConflictResolution(routes: Array<ReturnType<typeof serializeRoute>>) {
  const selectedOwnerRouteId = routes.find((route) => route.ownerResolutionState === 'preferred')?.id ?? null
  const ranked = [...routes]
    .map((route) => ({
      route,
      ranking: rankConflictRoute(route),
    }))
    .sort((left, right) => {
      if (right.ranking.score !== left.ranking.score) {
        return right.ranking.score - left.ranking.score
      }
      return (Date.parse(right.route.lastSeenAt ?? '') || 0) - (Date.parse(left.route.lastSeenAt ?? '') || 0)
    })

  const recommended = ranked[0] ?? null
  return {
    selectedOwnerRouteId,
    recommendedRouteId: recommended?.route.id ?? null,
    recommendedReason: recommended?.ranking.reason ?? null,
  }
}

function buildConflictHistory(
  db: Database,
  beamId: string,
  routes: Array<ReturnType<typeof serializeRoute>>,
): OpenClawConflictHistoryItem[] {
  const historyItems: OpenClawConflictHistoryItem[] = []

  for (const entry of listAuditLog(db, {
    limit: 5,
    target: `openclaw-conflict:${beamId}`,
  })) {
    let note: string | null = null
    try {
      const parsed = entry.details ? JSON.parse(entry.details) as Record<string, unknown> : null
      note = normalizeOptionalString(parsed?.note)
    } catch {
      note = null
    }
    historyItems.push({
      id: `audit-conflict:${entry.id}`,
      source: 'route',
      action: entry.action,
      actor: entry.actor,
      timestamp: entry.timestamp,
      note,
      routeId: null,
      hostId: null,
      href: buildOpenClawConflictHref(beamId),
    })
  }

  for (const route of routes) {
    if (route.ownerResolutionAt) {
      historyItems.push({
        id: `route-resolution:${route.id}:${route.ownerResolutionAt}`,
        source: 'route',
        action: route.ownerResolutionState,
        actor: route.ownerResolutionActor,
        timestamp: route.ownerResolutionAt,
        note: route.ownerResolutionNote,
        routeId: route.id,
        hostId: route.hostId,
        href: route.lastDelivery?.href ?? null,
      })
    }

    const auditEntries = listAuditLog(db, {
      limit: 5,
      target: `openclaw-route:${route.id}`,
    })
    for (const entry of auditEntries) {
      let note: string | null = null
      try {
        const parsed = entry.details ? JSON.parse(entry.details) as Record<string, unknown> : null
        note = normalizeOptionalString(parsed?.note)
      } catch {
        note = null
      }
      historyItems.push({
        id: `audit-route:${entry.id}`,
        source: 'route',
        action: entry.action,
        actor: entry.actor,
        timestamp: entry.timestamp,
        note,
        routeId: route.id,
        hostId: route.hostId,
        href: null,
      })
    }
  }

  const seenHostIds = new Set<number>()
  for (const route of routes) {
    if (seenHostIds.has(route.hostId)) {
      continue
    }
    seenHostIds.add(route.hostId)
    const auditEntries = listAuditLog(db, {
      limit: 5,
      target: `openclaw-host:${route.hostId}`,
    }).filter((entry) => entry.action === 'admin.openclaw_host.revoked')
    for (const entry of auditEntries) {
      let note: string | null = null
      try {
        const parsed = entry.details ? JSON.parse(entry.details) as Record<string, unknown> : null
        note = normalizeOptionalString(parsed?.reason)
      } catch {
        note = null
      }
      historyItems.push({
        id: `audit-host:${entry.id}`,
        source: 'host',
        action: entry.action,
        actor: entry.actor,
        timestamp: entry.timestamp,
        note,
        routeId: null,
        hostId: route.hostId,
        href: buildOpenClawFleetHref(route.hostId),
      })
    }
  }

  return historyItems
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .filter((entry, index, items) => items.findIndex((candidate) => candidate.id === entry.id) === index)
    .slice(0, 12)
}

function buildConflictDetail(db: Database, beamId: string) {
  const resolvedRoutes = listOpenClawResolvedRoutesByBeamId(db, beamId)
  if (resolvedRoutes.length === 0) {
    return null
  }

  const routes = resolvedRoutes.map((route) => serializeRoute(db, route))
  const summary = summarizeConflictResolution(routes)
  const activeConflictRoutes = summary.selectedOwnerRouteId
    ? []
    : routes.filter((route) => route.runtimeSessionState === 'conflict')

  return {
    beamId,
    routeCount: routes.length,
    activeConflictRouteCount: activeConflictRoutes.length,
    resolutionState: summary.selectedOwnerRouteId ? 'owner_selected' : 'unresolved',
    selectedOwnerRouteId: summary.selectedOwnerRouteId,
    recommendedRouteId: summary.recommendedRouteId,
    recommendedReason: summary.recommendedReason,
    routes,
    history: buildConflictHistory(db, beamId, routes),
  }
}

function summarizeRoutes(db: Database, routes: OpenClawResolvedRouteRow[]) {
  const recentLogs = listRecentIntentLogsByTargets(db, routes.map((route) => route.beam_id))
  const recentLogsByTarget = new Map<string, IntentLogRow[]>()
  for (const log of recentLogs) {
    const existing = recentLogsByTarget.get(log.to_beam_id)
    if (existing) {
      existing.push(log)
    } else {
      recentLogsByTarget.set(log.to_beam_id, [log])
    }
  }

  const summary = routes.reduce((current, route) => {
    const targetLogs = recentLogsByTarget.get(route.beam_id) ?? []
    const latestDelivery = targetLogs[0] ?? getLatestIntentLogByTarget(db, route.beam_id)
    current.total += 1
    switch (route.runtime_session_state) {
      case 'live':
        current.live += 1
        break
      case 'stale':
        current.stale += 1
        break
      case 'conflict':
        current.conflict += 1
        break
      case 'revoked':
        current.revoked += 1
        break
      case 'ended':
        current.ended += 1
        break
      default:
        current.idle += 1
        break
    }

    if (
      route.connection_mode === 'unavailable'
      || route.runtime_session_state === 'stale'
      || route.runtime_session_state === 'revoked'
      || route.runtime_session_state === 'conflict'
    ) {
      current.unavailable += 1
    }

    if (latestDelivery) {
      current.delivery.receipts += 1
      current.delivery.coverage.routesWithReceipts += 1
      if (latestDelivery.status === 'failed' || latestDelivery.error_code) {
        current.delivery.failed += 1
      }

      const isNewer = !current.delivery.lastRequestedAt || Date.parse(latestDelivery.requested_at) >= Date.parse(current.delivery.lastRequestedAt)
      if (isNewer) {
        current.delivery.lastRequestedAt = latestDelivery.requested_at
        current.delivery.lastStatus = latestDelivery.status
        current.delivery.lastErrorCode = latestDelivery.error_code
        current.delivery.lastHref = buildIntentHref(latestDelivery.nonce)
      }
    }

    return current
  }, {
    total: 0,
    live: 0,
    idle: 0,
    stale: 0,
    conflict: 0,
    ended: 0,
    revoked: 0,
    unavailable: 0,
    delivery: {
      receipts: 0,
      failed: 0,
      lastRequestedAt: null as string | null,
      lastStatus: null as IntentLogRow['status'] | null,
      lastErrorCode: null as string | null,
      lastHref: null as string | null,
      coverage: {
        activeRoutes: 0,
        routesWithReceipts: 0,
        missingReceipts: 0,
        ratio: null as number | null,
      },
      latency: {
        targetMs: OPENCLAW_ROUTE_LATENCY_SLO_MS,
        samples: 0,
        avgMs: null as number | null,
        p50Ms: null as number | null,
        p95Ms: null as number | null,
        overSlo: 0,
        degraded: false,
      },
    },
  })

  summary.delivery.coverage.activeRoutes = routes.filter((route) =>
    route.runtime_session_state === 'live' || route.runtime_session_state === 'idle',
  ).length
  summary.delivery.coverage.missingReceipts = Math.max(
    0,
    summary.delivery.coverage.activeRoutes - summary.delivery.coverage.routesWithReceipts,
  )
  summary.delivery.coverage.ratio = summary.delivery.coverage.activeRoutes > 0
    ? Number((summary.delivery.coverage.routesWithReceipts / summary.delivery.coverage.activeRoutes).toFixed(3))
    : null

  const ackLatencies = recentLogs
    .filter((log) => log.status === 'acked' && typeof log.round_trip_latency_ms === 'number')
    .map((log) => log.round_trip_latency_ms as number)
  if (ackLatencies.length > 0) {
    const total = ackLatencies.reduce((sum, value) => sum + value, 0)
    summary.delivery.latency.samples = ackLatencies.length
    summary.delivery.latency.avgMs = Math.round(total / ackLatencies.length)
    summary.delivery.latency.p50Ms = percentile(ackLatencies, 0.5)
    summary.delivery.latency.p95Ms = percentile(ackLatencies, 0.95)
    summary.delivery.latency.overSlo = ackLatencies.filter((value) => value > OPENCLAW_ROUTE_LATENCY_SLO_MS).length
  }
  summary.delivery.latency.degraded =
    summary.delivery.failed > 0
    || summary.delivery.coverage.missingReceipts > 0
    || summary.delivery.latency.overSlo > 0

  return summary
}

function serializeHost(db: Database, host: OpenClawHostRow) {
  const enrollment = host.enrollment_request_id
    ? listOpenClawEnrollmentRequests(db).find((entry) => entry.id === host.enrollment_request_id) ?? null
    : null
  const routes = listOpenClawResolvedRoutesForHost(db, host.id)
  const summary = summarizeRoutes(db, routes)
  const policy = serializeOpenClawHostPolicy(host)
  const placement = serializeOpenClawHostPlacement(host)

  return {
    id: host.id,
    hostKey: host.host_key,
    label: host.label,
    hostname: host.hostname,
    os: host.os,
    connectorVersion: host.connector_version,
    beamDirectoryUrl: host.beam_directory_url,
    workspaceSlug: host.workspace_slug,
    status: host.status,
    healthStatus: host.health_status,
    credentialState: host.credential_state,
    credentialIssuedAt: host.credential_issued_at,
    credentialRotatedAt: host.credential_rotated_at,
    credentialAgeHours: hostCredentialAgeHours(host),
    recoveryCompletedAt: host.recovery_completed_at,
    routeCount: host.route_count,
    approvedAt: host.approved_at,
    approvedBy: host.approved_by,
    revokedAt: host.revoked_at,
    revocationReason: host.revocation_reason,
    lastHeartbeatAt: host.last_heartbeat_at,
    lastHeartbeatAgeHours: hoursSince(host.last_heartbeat_at),
    lastInventoryAt: host.last_inventory_at,
    lastRouteEventAt: host.last_route_event_at,
    createdAt: host.created_at,
    updatedAt: host.updated_at,
    policy,
    placement,
    enrollment: serializeEnrollment(enrollment),
    summary,
  }
}

function summarizeOpenClawFleetEnvironments(hosts: Array<ReturnType<typeof serializeHost>>): OpenClawHostEnvironmentSummary[] {
  const buckets = new Map<string, OpenClawHostEnvironmentSummary>()

  for (const host of hosts) {
    const label = host.placement.environmentLabel ?? 'unassigned'
    const existing = buckets.get(label) ?? {
      label,
      hostCount: 0,
      staleHosts: 0,
      degradedHosts: 0,
      pendingHosts: 0,
      hostIds: [],
    }

    existing.hostCount += 1
    existing.staleHosts += host.healthStatus === 'stale' ? 1 : 0
    existing.degradedHosts += host.summary.delivery.latency.degraded ? 1 : 0
    existing.pendingHosts += host.status === 'pending' ? 1 : 0
    existing.hostIds.push(host.id)
    buckets.set(label, existing)
  }

  return [...buckets.values()].sort((left, right) => left.label.localeCompare(right.label))
}

function summarizeOpenClawFleetGroups(hosts: Array<ReturnType<typeof serializeHost>>): OpenClawHostGroupSummary[] {
  const buckets = new Map<string, OpenClawHostGroupSummary>()

  for (const host of hosts) {
    for (const groupLabel of host.placement.groupLabels) {
      const existing = buckets.get(groupLabel) ?? {
        label: groupLabel,
        hostCount: 0,
        staleHosts: 0,
        degradedHosts: 0,
        pendingHosts: 0,
        environments: [],
        hostIds: [],
      }

      existing.hostCount += 1
      existing.staleHosts += host.healthStatus === 'stale' ? 1 : 0
      existing.degradedHosts += host.summary.delivery.latency.degraded ? 1 : 0
      existing.pendingHosts += host.status === 'pending' ? 1 : 0
      existing.hostIds.push(host.id)
      const environmentLabel = host.placement.environmentLabel ?? 'unassigned'
      if (!existing.environments.includes(environmentLabel)) {
        existing.environments.push(environmentLabel)
      }
      buckets.set(groupLabel, existing)
    }
  }

  return [...buckets.values()]
    .map((group) => ({
      ...group,
      environments: [...group.environments].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

function severityWeight(severity: OpenClawFleetDigestSeverity): number {
  return severity === 'critical' ? 0 : 1
}

function buildOpenClawFleetCredentialPolicySummary(
  hosts: Array<ReturnType<typeof serializeHost>>,
): OpenClawFleetCredentialPolicySummary {
  const counts: OpenClawFleetCredentialPolicySummary['counts'] = {
    overdue: 0,
    dueSoon: 0,
    windowOpen: 0,
    rotationPending: 0,
    recoveryPrepared: 0,
    recoveryCutover: 0,
    recoveryCompleted: 0,
    cleanupRecommended: 0,
    missingRecoveryOwner: 0,
  }
  const attentionHosts: OpenClawFleetCredentialPolicyAttentionHost[] = []

  for (const host of hosts) {
    const reasons: string[] = []
    let severity: OpenClawFleetDigestSeverity = 'warning'
    if (host.policy.rotation.reviewState === 'overdue') {
      counts.overdue += 1
      reasons.push('credential rotation overdue')
      severity = 'critical'
    } else if (host.policy.rotation.reviewState === 'due_soon') {
      counts.dueSoon += 1
      reasons.push('credential rotation due soon')
    }

    if (host.policy.rotation.windowOpen) {
      counts.windowOpen += 1
      reasons.push('rotation window open')
    }

    if (host.credentialState === 'rotation_pending') {
      counts.rotationPending += 1
      reasons.push('rotated credential not yet active')
    }

    if (host.policy.recovery.status === 'prepared') {
      counts.recoveryPrepared += 1
      reasons.push('recovery runbook prepared')
    } else if (host.policy.recovery.status === 'cutover_pending') {
      counts.recoveryCutover += 1
      reasons.push('recovery cutover pending')
      severity = 'critical'
    } else if (host.policy.recovery.status === 'completed') {
      counts.recoveryCompleted += 1
    }

    if (host.policy.recovery.cleanupRecommended) {
      counts.cleanupRecommended += 1
      reasons.push('post-recovery cleanup recommended')
    }

    if (host.policy.recovery.status !== 'idle' && !host.policy.recovery.owner) {
      counts.missingRecoveryOwner += 1
      reasons.push('recovery owner missing')
    }

    if (reasons.length === 0) {
      continue
    }

    attentionHosts.push({
      hostId: host.id,
      hostLabel: host.label,
      workspaceSlug: host.workspaceSlug,
      healthStatus: host.healthStatus,
      credentialState: host.credentialState,
      credentialAgeHours: host.credentialAgeHours,
      rotationReviewState: host.policy.rotation.reviewState,
      nextRotationDueAt: host.policy.rotation.nextRotationDueAt,
      nextRotationWindowStartsAt: host.policy.rotation.nextRotationWindowStartsAt,
      nextRotationWindowEndsAt: host.policy.rotation.nextRotationWindowEndsAt,
      dueInHours: host.policy.rotation.dueInHours,
      windowOpen: host.policy.rotation.windowOpen,
      recoveryStatus: host.policy.recovery.status,
      recoveryOwner: host.policy.recovery.owner,
      cleanupRecommended: host.policy.recovery.cleanupRecommended,
      reasons,
      severity,
      href: buildOpenClawFleetHref(host.id),
      workspaceHref: buildWorkspaceHref(host.workspaceSlug),
    })
  }

  attentionHosts.sort((left, right) =>
    severityWeight(left.severity) - severityWeight(right.severity)
      || (left.dueInHours ?? Number.POSITIVE_INFINITY) - (right.dueInHours ?? Number.POSITIVE_INFINITY)
      || (right.credentialAgeHours ?? 0) - (left.credentialAgeHours ?? 0)
      || left.hostId - right.hostId)

  return {
    counts,
    attentionHosts,
  }
}

function buildOpenClawFleetRouteHealthSummary(
  db: Database,
  hosts: Array<ReturnType<typeof serializeHost>>,
): OpenClawFleetRouteHealthSummary {
  const targetBeamIds = hosts.flatMap((host) => listOpenClawResolvedRoutesForHost(db, host.id).map((route) => route.beam_id))
  const recentLogs = listRecentIntentLogsByTargets(db, targetBeamIds)
  const ackLatencies = recentLogs
    .filter((log) => log.status === 'acked' && typeof log.round_trip_latency_ms === 'number')
    .map((log) => log.round_trip_latency_ms as number)
  const totalLatency = ackLatencies.reduce((sum, value) => sum + value, 0)
  const overTarget = ackLatencies.filter((value) => value > OPENCLAW_ROUTE_LATENCY_SLO_MS)
  const overDoubleTarget = ackLatencies.filter((value) => value > OPENCLAW_ROUTE_LATENCY_SLO_MS * 2)
  const attentionHosts: OpenClawFleetRouteHealthAttentionHost[] = []

  for (const host of hosts) {
    const reasons: string[] = []
    let severity: OpenClawFleetDigestSeverity = 'warning'
    if (host.healthStatus === 'stale') {
      reasons.push('host stale')
      severity = 'critical'
    }
    if (host.summary.delivery.failed > 0) {
      reasons.push('failed receipts')
      severity = 'critical'
    }
    if (host.summary.delivery.coverage.missingReceipts > 0) {
      reasons.push('missing receipts')
    }
    if (host.summary.delivery.latency.overSlo > 0) {
      reasons.push('latency above target')
      if ((host.summary.delivery.latency.p95Ms ?? 0) > OPENCLAW_ROUTE_LATENCY_SLO_MS * 2) {
        severity = 'critical'
      }
    }
    if (reasons.length === 0) {
      continue
    }
    attentionHosts.push({
      hostId: host.id,
      hostLabel: host.label,
      workspaceSlug: host.workspaceSlug,
      healthStatus: host.healthStatus,
      receiptCoverageRatio: host.summary.delivery.coverage.ratio,
      missingReceipts: host.summary.delivery.coverage.missingReceipts,
      failedReceipts: host.summary.delivery.failed,
      activeRoutes: host.summary.delivery.coverage.activeRoutes,
      p95LatencyMs: host.summary.delivery.latency.p95Ms,
      overSlo: host.summary.delivery.latency.overSlo,
      reasons,
      severity,
      href: buildOpenClawFleetHref(host.id),
      workspaceHref: buildWorkspaceHref(host.workspaceSlug),
      traceHref: host.summary.delivery.lastHref,
    })
  }

  attentionHosts.sort((left, right) =>
    severityWeight(left.severity) - severityWeight(right.severity)
      || right.failedReceipts - left.failedReceipts
      || right.missingReceipts - left.missingReceipts
      || (right.p95LatencyMs ?? 0) - (left.p95LatencyMs ?? 0)
      || left.hostId - right.hostId)

  const activeRoutes = hosts.reduce((sum, host) => sum + host.summary.delivery.coverage.activeRoutes, 0)
  const routesWithReceipts = hosts.reduce((sum, host) => sum + host.summary.delivery.coverage.routesWithReceipts, 0)
  const routesMissingReceipts = hosts.reduce((sum, host) => sum + host.summary.delivery.coverage.missingReceipts, 0)
  const failedReceipts = hosts.reduce((sum, host) => sum + host.summary.delivery.failed, 0)
  const degradedHosts = hosts.filter((host) => host.summary.delivery.latency.degraded).length

  return {
    summary: {
      targetLatencyMs: OPENCLAW_ROUTE_LATENCY_SLO_MS,
      activeRoutes,
      routesWithReceipts,
      routesMissingReceipts,
      receiptCoverageRatio: activeRoutes > 0 ? Number((routesWithReceipts / activeRoutes).toFixed(3)) : null,
      failedReceipts,
      degradedHosts,
      hostsWithMissingReceipts: hosts.filter((host) => host.summary.delivery.coverage.missingReceipts > 0).length,
      hostsWithFailedReceipts: hosts.filter((host) => host.summary.delivery.failed > 0).length,
    },
    latency: {
      samples: ackLatencies.length,
      avgMs: ackLatencies.length > 0 ? Math.round(totalLatency / ackLatencies.length) : null,
      p50Ms: percentile(ackLatencies, 0.5),
      p95Ms: percentile(ackLatencies, 0.95),
      overSlo: overTarget.length,
      overDoubleSlo: overDoubleTarget.length,
      buckets: {
        withinTarget: ackLatencies.filter((value) => value <= OPENCLAW_ROUTE_LATENCY_SLO_MS).length,
        overTarget: overTarget.length,
        overDoubleTarget: overDoubleTarget.length,
      },
    },
    attentionHosts,
  }
}

function buildOpenClawFleetEscalations(actionItems: OpenClawFleetDigestItem[]): OpenClawFleetEscalation[] {
  return actionItems.filter((item) => item.severity === 'critical')
}

function computeOpenClawFleetDigestCurrentScheduleSlot(
  runHourUtc: number,
  runMinuteUtc: number,
  now = new Date(),
): string {
  const slot = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    runHourUtc,
    runMinuteUtc,
    0,
    0,
  ))
  if (now.getTime() < slot.getTime()) {
    slot.setUTCDate(slot.getUTCDate() - 1)
  }
  return slot.toISOString()
}

function computeOpenClawFleetDigestNextRunAt(
  schedule: OpenClawFleetDigestScheduleRow,
  now = new Date(),
): string | null {
  if (!schedule.enabled) {
    return null
  }

  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    schedule.run_hour_utc,
    schedule.run_minute_utc,
    0,
    0,
  ))
  if (now.getTime() >= next.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.toISOString()
}

function serializeOpenClawFleetDigestSchedule(
  schedule: OpenClawFleetDigestScheduleRow,
  runsById: Map<number, OpenClawFleetDigestRunRow>,
): SerializedOpenClawFleetDigestSchedule {
  const lastRun = schedule.last_run_id ? runsById.get(schedule.last_run_id) ?? null : null

  return {
    enabled: schedule.enabled === 1,
    deliveryEmail: schedule.delivery_email,
    escalationEmail: schedule.escalation_email,
    runHourUtc: schedule.run_hour_utc,
    runMinuteUtc: schedule.run_minute_utc,
    escalateOnCritical: schedule.escalate_on_critical === 1,
    lastScheduledForAt: schedule.last_scheduled_for_at,
    lastRunAt: lastRun?.generated_at ?? null,
    lastDeliveryAt: schedule.last_delivery_at,
    lastEscalationDeliveryAt: schedule.last_escalation_delivery_at,
    nextRunAt: computeOpenClawFleetDigestNextRunAt(schedule),
  }
}

function serializeOpenClawFleetDigestRun(row: OpenClawFleetDigestRunRow): SerializedOpenClawFleetDigestRun {
  const summary = parseJson<Record<string, unknown>>(row.summary_json, {})
  const escalationItems = parseJson<unknown[]>(row.escalation_items_json, [])
  return {
    id: row.id,
    triggerKind: row.trigger_kind,
    actor: row.actor,
    generatedAt: row.generated_at,
    deliveryState: row.delivery_state,
    lastDeliveryErrorCode: row.last_delivery_error_code,
    summary: {
      actionItems: Number(summary['actionItems'] ?? 0),
      criticalItems: Number(summary['criticalItems'] ?? 0),
      staleHosts: Number(summary['staleHosts'] ?? 0),
      failedReceipts: Number(summary['failedReceipts'] ?? 0),
      duplicateIdentityConflicts: Number(summary['duplicateIdentityConflicts'] ?? 0),
      escalations: escalationItems.length,
    },
  }
}

function serializeOpenClawFleetDigestDelivery(
  row: OpenClawFleetDigestDeliveryRow,
  runsById: Map<number, OpenClawFleetDigestRunRow>,
): SerializedOpenClawFleetDigestDelivery {
  const run = row.run_id ? runsById.get(row.run_id) ?? null : null
  const summary = run ? parseJson<Record<string, unknown>>(run.summary_json, {}) : null
  const escalationItems = run ? parseJson<unknown[]>(run.escalation_items_json, []) : []

  return {
    id: row.id,
    runId: row.run_id,
    runGeneratedAt: run?.generated_at ?? null,
    kind: row.delivery_kind,
    status: row.status,
    recipientEmail: row.recipient_email,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    deliveredAt: row.delivered_at,
    summary: summary
      ? {
          actionItems: Number(summary['actionItems'] ?? 0),
          criticalItems: Number(summary['criticalItems'] ?? 0),
          escalations: escalationItems.length,
        }
      : null,
  }
}

function buildOpenClawFleetDigest(db: Database, baseUrl: string) {
  refreshOpenClawHostHealth(db)
  recalculateOpenClawRouteStates(db)

  const hosts = listOpenClawHosts(db).map((host) => serializeHost(db, host))
  const conflicts = listConflictGroups(db)
  const actionItems: OpenClawFleetDigestItem[] = []

  for (const host of hosts) {
    const hostHref = buildOpenClawFleetHref(host.id)
    const lastTraceHref = host.summary.delivery.lastHref
    const baseDetail = [
      host.hostname,
      host.workspaceSlug ? `workspace ${host.workspaceSlug}` : null,
    ].filter(Boolean).join(' · ')

    if (host.status === 'pending') {
      actionItems.push({
        id: `host-pending:${host.id}`,
        severity: 'warning',
        category: 'host',
        title: `${hostTitleForDigest(host)} is awaiting approval`,
        detail: `${baseDetail} has enrolled but cannot publish a trusted fleet route until an operator approves the host.`,
        nextAction: 'Approve the host or revoke the enrollment if the machine should not join the fleet.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }

    if (host.healthStatus === 'stale') {
      actionItems.push({
        id: `host-stale:${host.id}`,
        severity: 'critical',
        category: 'host',
        title: `${hostTitleForDigest(host)} has gone stale`,
        detail: `${baseDetail} has not sent a recent heartbeat, so its routes are currently non-deliverable.`,
        nextAction: 'Inspect the service status on the host, then recover or replace the host if it no longer owns the route.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }

    if (host.status === 'revoked') {
      actionItems.push({
        id: `host-revoked:${host.id}`,
        severity: 'warning',
        category: 'host',
        title: `${hostTitleForDigest(host)} is revoked`,
        detail: `${baseDetail} remains visible for audit history, but its routes are disabled until recovery is explicitly started.`,
        nextAction: 'Recover or replace the host only if this machine should rejoin the fleet; otherwise leave it revoked.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }

    if (host.policy.rotation.reviewState === 'overdue' || host.policy.rotation.reviewState === 'due_soon') {
      actionItems.push({
        id: `credential-window:${host.id}`,
        severity: host.policy.rotation.reviewState === 'overdue' ? 'critical' : 'warning',
        category: 'credential',
        title: `${hostTitleForDigest(host)} is due for credential rotation`,
        detail: `${baseDetail} last issued a host credential ${host.credentialAgeHours ?? 0}h ago. The next rotation window starts ${host.policy.rotation.nextRotationWindowStartsAt ? `at ${host.policy.rotation.nextRotationWindowStartsAt}` : 'soon'}.`,
        nextAction: 'Review the host rotation window, rotate the credential in Beam, then confirm the host returns with a fresh heartbeat and inventory sync.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }

    if (host.credentialState === 'rotation_pending') {
      actionItems.push({
        id: `credential-rotate:${host.id}`,
        severity: 'warning',
        category: 'credential',
        title: `${hostTitleForDigest(host)} is waiting for rotated credentials`,
        detail: `${baseDetail} has a fresh credential issued, but the host has not yet come back with a heartbeat or inventory sync on the rotated secret.`,
        nextAction: 'Apply the rotated credential pack on the host and wait for the next heartbeat to restore route health.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }

    if (host.credentialState === 'recovery_pending') {
      actionItems.push({
        id: `credential-recovery:${host.id}`,
        severity: 'critical',
        category: 'credential',
        title: `${hostTitleForDigest(host)} is waiting for recovery cutover`,
        detail: `${baseDetail} has a recovery credential issued and will stay unavailable until the replacement machine publishes inventory with the recovered host identity.`,
        nextAction: 'Install the recovery credential on the replacement host, then verify heartbeat and inventory before closing the recovery.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }

    if (host.policy.recovery.status === 'prepared' || host.policy.recovery.status === 'cutover_pending') {
      actionItems.push({
        id: `recovery-runbook:${host.id}`,
        severity: host.policy.recovery.status === 'cutover_pending' ? 'critical' : 'warning',
        category: 'host',
        title: `${hostTitleForDigest(host)} has an open recovery runbook`,
        detail: `${baseDetail} is assigned to ${host.policy.recovery.owner ?? 'an operator'} with recovery state ${host.policy.recovery.status}${host.policy.recovery.replacementHostLabel ? ` on ${host.policy.recovery.replacementHostLabel}` : ''}.`,
        nextAction: host.policy.recovery.status === 'cutover_pending'
          ? 'Complete the recovery cutover, confirm fresh routes on the replacement host, then close the runbook state.'
          : 'Review the recovery notes and schedule the replacement window before the next operator handoff.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }

    if (host.policy.recovery.cleanupRecommended) {
      actionItems.push({
        id: `recovery-cleanup:${host.id}`,
        severity: 'warning',
        category: 'credential',
        title: `${hostTitleForDigest(host)} has recovery cleanup pending`,
        detail: `${baseDetail} already completed recovery cutover, but the runbook still carries recovery-specific window or replacement metadata.`,
        nextAction: 'Review the replacement host state and then complete recovery cleanup so the host returns to the normal credential review queue.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }

    if (host.placement.revokeReviewRequestedAt) {
      actionItems.push({
        id: `host-revoke-review:${host.id}`,
        severity: 'warning',
        category: 'host',
        title: `${hostTitleForDigest(host)} is staged for revoke review`,
        detail: `${baseDetail} has a staged revoke review${host.placement.revokeReviewReason ? `: ${host.placement.revokeReviewReason}` : ''}.`,
        nextAction: 'Review the host health and route ownership, then either clear the staged review or perform a targeted revoke.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: lastTraceHref,
      })
    }

    if (host.summary.delivery.failed > 0) {
      actionItems.push({
        id: `delivery-failed:${host.id}`,
        severity: host.healthStatus === 'stale' || host.status === 'revoked' ? 'critical' : 'warning',
        category: 'delivery',
        title: `${hostTitleForDigest(host)} has failed delivery receipts`,
        detail: `${baseDetail} recorded ${host.summary.delivery.failed} failed receipt(s) on live or recently active routes.`,
        nextAction: 'Open the latest trace, confirm the failure reason, then repair the route or revoke the host if it should stop receiving delivery.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: lastTraceHref,
      })
    } else if (host.summary.live > 0 && host.summary.delivery.receipts === 0) {
      actionItems.push({
        id: `delivery-missing:${host.id}`,
        severity: 'warning',
        category: 'delivery',
        title: `${hostTitleForDigest(host)} has live routes without receipts`,
        detail: `${baseDetail} reports live routes, but Beam has not yet recorded a receipt for them.`,
        nextAction: 'Send a Beam ping to the host and confirm the trace closes with a successful receipt.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }

    if (host.summary.delivery.latency.overSlo > 0) {
      actionItems.push({
        id: `delivery-latency:${host.id}`,
        severity: host.summary.delivery.latency.p95Ms && host.summary.delivery.latency.p95Ms > OPENCLAW_ROUTE_LATENCY_SLO_MS * 2
          ? 'critical'
          : 'warning',
        category: 'delivery',
        title: `${hostTitleForDigest(host)} is breaching fleet delivery latency`,
        detail: `${baseDetail} has ${host.summary.delivery.latency.overSlo} receipt(s) above the ${OPENCLAW_ROUTE_LATENCY_SLO_MS}ms target. Recent p95 is ${host.summary.delivery.latency.p95Ms ?? 'unknown'}ms.`,
        nextAction: 'Open the affected traces, verify route transport and host health, then confirm fresh receipts land within the fleet SLO.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: lastTraceHref,
      })
    }

    if (host.summary.conflict > 0 && !conflicts.some((conflict) => conflict.routes.some((route) => route.hostId === host.id))) {
      actionItems.push({
        id: `host-shadow-conflict:${host.id}`,
        severity: 'warning',
        category: 'conflict',
        title: `${hostTitleForDigest(host)} still carries shadow conflict routes`,
        detail: `${baseDetail} has at least one non-deliverable conflicting route that is no longer the active owner.`,
        nextAction: 'Inspect the host detail and disable or clean up the shadow route if it should no longer advertise the Beam ID.',
        hostId: host.id,
        hostLabel: host.label,
        workspaceSlug: host.workspaceSlug,
        href: hostHref,
        traceHref: null,
      })
    }
  }

  for (const conflict of conflicts) {
    const primaryRoute = conflict.routes[0] ?? null
    actionItems.push({
      id: `conflict:${conflict.beamId}`,
      severity: 'critical',
      category: 'conflict',
      title: `${conflict.beamId} has duplicate live routes`,
      detail: `${conflict.routeCount} host routes currently claim ${conflict.beamId}, so Beam blocks delivery until one route owner is preferred or the competing route is disabled.`,
      nextAction: 'Prefer exactly one route owner or revoke/disable the conflicting host route before retrying delivery.',
      hostId: primaryRoute?.hostId ?? null,
      hostLabel: primaryRoute?.hostLabel ?? primaryRoute?.hostname ?? null,
      workspaceSlug: primaryRoute?.workspaceSlug ?? null,
      href: buildOpenClawConflictHref(conflict.beamId),
      traceHref: null,
    })
  }

  const summary = {
    totalHosts: hosts.length,
    activeHosts: hosts.filter((host) => host.status === 'active').length,
    pendingHosts: hosts.filter((host) => host.status === 'pending').length,
    revokedHosts: hosts.filter((host) => host.status === 'revoked').length,
    staleHosts: hosts.filter((host) => host.healthStatus === 'stale').length,
    liveRoutes: hosts.reduce((sum, host) => sum + host.summary.live, 0),
    staleRoutes: hosts.reduce((sum, host) => sum + host.summary.stale, 0),
    failedReceipts: hosts.reduce((sum, host) => sum + host.summary.delivery.failed, 0),
    routesMissingReceipts: hosts.reduce((sum, host) => sum + host.summary.delivery.coverage.missingReceipts, 0),
    degradedHosts: hosts.filter((host) => host.summary.delivery.latency.degraded).length,
    latencySloBreaches: hosts.reduce((sum, host) => sum + host.summary.delivery.latency.overSlo, 0),
    rotationDueHosts: hosts.filter((host) => host.policy.rotation.reviewState === 'due_soon' || host.policy.rotation.reviewState === 'overdue').length,
    recoveryRunbooksOpen: hosts.filter((host) => host.policy.recovery.status === 'prepared' || host.policy.recovery.status === 'cutover_pending').length,
    receiptCoverageRatio: (() => {
      const activeRoutes = hosts.reduce((sum, host) => sum + host.summary.delivery.coverage.activeRoutes, 0)
      const routesWithReceipts = hosts.reduce((sum, host) => sum + host.summary.delivery.coverage.routesWithReceipts, 0)
      return activeRoutes > 0 ? Number((routesWithReceipts / activeRoutes).toFixed(3)) : null
    })(),
    duplicateIdentityConflicts: conflicts.length,
    pendingCredentialActions: hosts.filter((host) => host.credentialState === 'rotation_pending' || host.credentialState === 'recovery_pending').length,
    actionItems: actionItems.length,
    criticalItems: actionItems.filter((item) => item.severity === 'critical').length,
    escalations: buildOpenClawFleetEscalations(actionItems).length,
    warningItems: actionItems.filter((item) => item.severity === 'warning').length,
  }

  const markdownLines = [
    `# Beam OpenClaw fleet digest · ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Summary',
    '',
    `- Hosts: \`${summary.totalHosts}\` total · \`${summary.activeHosts}\` active · \`${summary.pendingHosts}\` pending · \`${summary.revokedHosts}\` revoked`,
    `- Fleet health: \`${summary.staleHosts}\` stale host(s) · \`${summary.pendingCredentialActions}\` credential action(s) pending`,
    `- Routes: \`${summary.liveRoutes}\` live · \`${summary.staleRoutes}\` stale`,
    `- Delivery: \`${summary.failedReceipts}\` failed receipt(s) · \`${summary.routesMissingReceipts}\` route(s) without receipts · \`${summary.duplicateIdentityConflicts}\` duplicate conflict(s)`,
    `- SLO: \`${summary.degradedHosts}\` degraded host(s) · \`${summary.latencySloBreaches}\` latency breach(es) · coverage \`${summary.receiptCoverageRatio === null ? 'n/a' : `${Math.round(summary.receiptCoverageRatio * 100)}%`}\``,
    `- Operator backlog: \`${summary.actionItems}\` action item(s) · \`${summary.criticalItems}\` critical`,
    '',
    '## Action Items',
    '',
  ]

  if (actionItems.length === 0) {
    markdownLines.push('- No fleet action items are currently open.')
  } else {
    for (const item of actionItems) {
      markdownLines.push(`- [${item.severity.toUpperCase()}] ${item.title}`)
      markdownLines.push(`  - Detail: ${item.detail}`)
      markdownLines.push(`  - Next action: ${item.nextAction}`)
      if (item.href) {
        markdownLines.push(`  - Host: ${absoluteHref(baseUrl, item.href)}`)
      }
      if (item.traceHref) {
        markdownLines.push(`  - Trace: ${absoluteHref(baseUrl, item.traceHref)}`)
      }
      const workspaceHref = buildWorkspaceHref(item.workspaceSlug)
      if (workspaceHref) {
        markdownLines.push(`  - Workspace: ${absoluteHref(baseUrl, workspaceHref)}`)
      }
    }
  }

  const escalationItems = buildOpenClawFleetEscalations(actionItems)
  markdownLines.push('', '## Escalations', '')
  if (escalationItems.length === 0) {
    markdownLines.push('- No critical fleet escalations are currently open.')
  } else {
    for (const item of escalationItems) {
      markdownLines.push(`- ${item.title}`)
      markdownLines.push(`  - Detail: ${item.detail}`)
      markdownLines.push(`  - Next action: ${item.nextAction}`)
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary,
    actionItems,
    escalations: escalationItems,
    markdown: `${markdownLines.join('\n')}\n`,
  }
}

type BuiltOpenClawFleetDigest = ReturnType<typeof buildOpenClawFleetDigest>

function buildPersistedOpenClawFleetDigestRun(
  db: Database,
  baseUrl: string,
  input: {
    triggerKind: OpenClawFleetDigestRunTriggerKind
    actor?: string | null
    scheduledForAt?: string | null
  },
): { digest: BuiltOpenClawFleetDigest; run: OpenClawFleetDigestRunRow } {
  const digest = buildOpenClawFleetDigest(db, baseUrl)
  const run = createOpenClawFleetDigestRun(db, {
    triggerKind: input.triggerKind,
    actor: input.actor ?? null,
    generatedAt: digest.generatedAt,
    summaryJson: JSON.stringify(digest.summary),
    actionItemsJson: JSON.stringify(digest.actionItems),
    escalationItemsJson: JSON.stringify(digest.escalations),
    markdown: digest.markdown,
  })

  if (input.scheduledForAt !== undefined) {
    updateOpenClawFleetDigestSchedule(db, {
      lastRunId: run.id,
      lastScheduledForAt: input.scheduledForAt,
    })
  }

  return { digest, run }
}

function buildOpenClawFleetEscalationMarkdown(run: OpenClawFleetDigestRunRow): string {
  const escalations = parseJson<OpenClawFleetEscalation[]>(run.escalation_items_json, [])
  const summary = parseJson<Record<string, unknown>>(run.summary_json, {})
  const lines = [
    `# Beam OpenClaw fleet escalation · ${run.generated_at.slice(0, 10)}`,
    '',
    '## Summary',
    '',
    `- Trigger: \`${run.trigger_kind}\``,
    `- Critical items: \`${Number(summary['criticalItems'] ?? escalations.length)}\``,
    `- Action items: \`${Number(summary['actionItems'] ?? 0)}\``,
    '',
    '## Escalations',
    '',
  ]

  if (escalations.length === 0) {
    lines.push('- No critical fleet escalations are currently open.')
  } else {
    for (const item of escalations) {
      lines.push(`- ${item.title}`)
      lines.push(`  - Detail: ${item.detail}`)
      lines.push(`  - Next action: ${item.nextAction}`)
    }
  }

  return `${lines.join('\n')}\n`
}

async function deliverOpenClawFleetDigestRun(
  db: Database,
  run: OpenClawFleetDigestRunRow,
  input: {
    actor: string
    recipientEmail: string
    deliveryKind: OpenClawFleetDigestDeliveryKind
  },
): Promise<{
  ok: boolean
  status: OpenClawFleetDigestDeliveryStatus
  errorCode: string | null
  errorMessage: string | null
  delivery: OpenClawFleetDigestDeliveryRow
}> {
  const markdown = input.deliveryKind === 'escalation'
    ? buildOpenClawFleetEscalationMarkdown(run)
    : run.markdown
  const subject = input.deliveryKind === 'escalation'
    ? `Beam OpenClaw fleet escalation · ${run.generated_at.slice(0, 10)}`
    : `Beam OpenClaw fleet digest · ${run.generated_at.slice(0, 10)}`

  if (!isEmailDeliveryConfigured()) {
    const delivery = recordOpenClawFleetDigestDelivery(db, {
      runId: run.id,
      deliveryKind: input.deliveryKind,
      recipientEmail: input.recipientEmail,
      status: 'unavailable',
      errorCode: 'EMAIL_DELIVERY_UNAVAILABLE',
      errorMessage: 'Email delivery is not configured for fleet digests.',
      detailsJson: JSON.stringify({ actor: input.actor }),
    })
    return {
      ok: false,
      status: 'unavailable',
      errorCode: 'EMAIL_DELIVERY_UNAVAILABLE',
      errorMessage: 'Email delivery is not configured for fleet digests.',
      delivery,
    }
  }

  const delivered = await sendOperatorDigestEmail({
    email: input.recipientEmail,
    subject,
    markdown,
  })

  const delivery = recordOpenClawFleetDigestDelivery(db, {
    runId: run.id,
    deliveryKind: input.deliveryKind,
    recipientEmail: input.recipientEmail,
    status: delivered ? 'delivered' : 'failed',
    errorCode: delivered ? null : 'EMAIL_DELIVERY_FAILED',
    errorMessage: delivered ? null : 'Failed to deliver fleet digest email.',
    detailsJson: JSON.stringify({ actor: input.actor }),
  })

  return {
    ok: delivered,
    status: delivered ? 'delivered' : 'failed',
    errorCode: delivered ? null : 'EMAIL_DELIVERY_FAILED',
    errorMessage: delivered ? null : 'Failed to deliver fleet digest email.',
    delivery,
  }
}

function buildOpenClawFleetDigestEnvelope(db: Database, baseUrl: string) {
  const digest = buildOpenClawFleetDigest(db, baseUrl)
  const schedule = getOpenClawFleetDigestSchedule(db)
  const runs = listOpenClawFleetDigestRuns(db, 10)
  const runsById = new Map(runs.map((run) => [run.id, run]))
  const deliveries = listOpenClawFleetDigestDeliveries(db, 20)

  return {
    ...digest,
    schedule: serializeOpenClawFleetDigestSchedule(schedule, runsById),
    history: {
      runs: runs.map((run) => serializeOpenClawFleetDigestRun(run)),
      deliveries: deliveries.map((delivery) => serializeOpenClawFleetDigestDelivery(delivery, runsById)),
    },
  }
}

function isOpenClawFleetDigestDue(schedule: OpenClawFleetDigestScheduleRow, now = new Date()) {
  if (!schedule.enabled) {
    return {
      due: false,
      scheduledForAt: null,
      nextRunAt: computeOpenClawFleetDigestNextRunAt(schedule, now),
    }
  }

  const scheduledForAt = computeOpenClawFleetDigestCurrentScheduleSlot(
    schedule.run_hour_utc,
    schedule.run_minute_utc,
    now,
  )

  return {
    due: schedule.last_scheduled_for_at !== scheduledForAt,
    scheduledForAt,
    nextRunAt: computeOpenClawFleetDigestNextRunAt(schedule, now),
  }
}

function hostTitleForDigest(host: Pick<ReturnType<typeof serializeHost>, 'label' | 'hostname'>): string {
  return host.label || host.hostname
}

function listConflictGroups(db: Database): OpenClawConflictGroup[] {
  refreshOpenClawHostHealth(db)
  recalculateOpenClawRouteStates(db)

  const rows = db.prepare(`
    SELECT DISTINCT beam_id
    FROM openclaw_host_routes
    WHERE runtime_session_state = 'conflict'
    ORDER BY beam_id ASC
  `).all() as Array<{ beam_id: string }>

  return rows.flatMap((row): OpenClawConflictGroup[] => {
    const detail = buildConflictDetail(db, row.beam_id)
    if (!detail || detail.activeConflictRouteCount === 0) {
      return []
    }

    return [{
      beamId: row.beam_id,
      routeCount: detail.activeConflictRouteCount,
      selectedOwnerRouteId: detail.selectedOwnerRouteId,
      recommendedRouteId: detail.recommendedRouteId,
      recommendedReason: detail.recommendedReason,
      routes: detail.routes
        .filter((route) => route.runtimeSessionState === 'conflict')
        .map((route) => ({
          routeId: route.id,
          hostId: route.hostId,
          hostLabel: route.hostLabel,
          hostname: route.hostLabel ?? `host-${route.hostId}`,
          workspaceSlug: route.workspaceSlug,
          routeKey: route.routeKey,
          routeSource: route.routeSource,
          ownerResolutionState: route.ownerResolutionState,
          ownerResolutionActor: route.ownerResolutionActor,
          ownerResolutionAt: route.ownerResolutionAt,
          ownerResolutionNote: route.ownerResolutionNote,
          runtimeSessionState: route.runtimeSessionState,
          hostHealth: route.hostHealth,
          lastSeenAt: route.lastSeenAt,
          lastDeliveryStatus: route.lastDelivery?.status ?? null,
          lastDeliveryHref: route.lastDelivery?.href ?? null,
        })),
    }]
  })
}

function requireHostCredential(db: Database, req: Request): OpenClawHostRow | Response {
  refreshOpenClawHostHealth(db)
  const suppliedApiKey = getSuppliedApiKey(req)
  const hostKey = hostKeyFromApiKey(suppliedApiKey)
  if (!hostKey) {
    return new Response(JSON.stringify({ error: 'Host credential required', errorCode: 'HOST_AUTH_REQUIRED' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  const host = getOpenClawHostByKey(db, hostKey)
  if (!host || !hostApiKeyMatches(host, suppliedApiKey)) {
    return new Response(JSON.stringify({ error: 'Invalid host credential', errorCode: 'HOST_AUTH_INVALID' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (host.status === 'revoked') {
    return new Response(JSON.stringify({ error: 'Host credential revoked', errorCode: 'HOST_REVOKED' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
  }

  return host
}

export function openClawAdminRouter(db: Database) {
  const router = new Hono()

  router.get('/fleet/overview', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    refreshOpenClawHostHealth(db)
    recalculateOpenClawRouteStates(db)
    const hosts = listOpenClawHosts(db).map((host) => serializeHost(db, host))
    const conflicts = listConflictGroups(db)
    const digest = buildOpenClawFleetDigest(db, new URL(c.req.url).origin)
    const environments = summarizeOpenClawFleetEnvironments(hosts)
    const hostGroups = summarizeOpenClawFleetGroups(hosts)
    const credentialPolicy = buildOpenClawFleetCredentialPolicySummary(hosts)
    const routeHealth = buildOpenClawFleetRouteHealthSummary(db, hosts)
    const summary = hosts.reduce((acc, host) => {
      acc.totalHosts += 1
      if (host.status === 'pending') acc.pendingHosts += 1
      if (host.status === 'active') acc.activeHosts += 1
      if (host.status === 'revoked') acc.revokedHosts += 1
      if (host.healthStatus === 'stale') acc.staleHosts += 1
      acc.liveRoutes += host.summary.live
      acc.staleRoutes += host.summary.stale
      acc.conflictRoutes += host.summary.conflict
      acc.endedRoutes += host.summary.ended
      acc.failedReceipts += host.summary.delivery.failed
      acc.routesMissingReceipts += host.summary.delivery.coverage.missingReceipts
      acc.degradedHosts += host.summary.delivery.latency.degraded ? 1 : 0
      acc.latencySloBreaches += host.summary.delivery.latency.overSlo
      if (host.policy.rotation.reviewState === 'due_soon' || host.policy.rotation.reviewState === 'overdue') {
        acc.rotationDueHosts += 1
      }
      if (host.policy.recovery.status === 'prepared' || host.policy.recovery.status === 'cutover_pending') {
        acc.recoveryRunbooksOpen += 1
      }
      return acc
    }, {
      totalHosts: 0,
      pendingHosts: 0,
      activeHosts: 0,
      revokedHosts: 0,
      staleHosts: 0,
      liveRoutes: 0,
      staleRoutes: 0,
      conflictRoutes: 0,
      endedRoutes: 0,
      failedReceipts: 0,
      routesMissingReceipts: 0,
      degradedHosts: 0,
      latencySloBreaches: 0,
      rotationDueHosts: 0,
      recoveryRunbooksOpen: 0,
    })

    const activeRoutes = hosts.reduce((sum, host) => sum + host.summary.delivery.coverage.activeRoutes, 0)
    const routesWithReceipts = hosts.reduce((sum, host) => sum + host.summary.delivery.coverage.routesWithReceipts, 0)

    c.header('Cache-Control', 'no-store')
    return c.json({
      summary: {
        ...summary,
        receiptCoverageRatio: activeRoutes > 0 ? Number((routesWithReceipts / activeRoutes).toFixed(3)) : null,
        duplicateIdentityConflicts: conflicts.length,
        pendingCredentialActions: digest.summary.pendingCredentialActions,
        actionItems: digest.summary.actionItems,
        criticalItems: digest.summary.criticalItems,
      },
      hosts,
      conflicts,
      credentialPolicy,
      routeHealth,
      environments,
      hostGroups,
    })
  })

  router.get('/conflicts/:beamId', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const beamId = normalizeOptionalString(c.req.param('beamId'))
    if (!beamId) {
      return c.json({ error: 'Invalid Beam ID', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const conflict = buildConflictDetail(db, beamId)
    if (!conflict) {
      return c.json({ error: 'Conflict not found', errorCode: 'NOT_FOUND' }, 404)
    }

    c.header('Cache-Control', 'no-store')
    return c.json(conflict)
  })

  router.post('/conflicts/:beamId/resolve', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const beamId = normalizeOptionalString(c.req.param('beamId'))
    if (!beamId) {
      return c.json({ error: 'Invalid Beam ID', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const conflict = buildConflictDetail(db, beamId)
    if (!conflict) {
      return c.json({ error: 'Conflict not found', errorCode: 'NOT_FOUND' }, 404)
    }
    if (conflict.routes.length < 2) {
      return c.json({ error: 'Route ownership conflict is no longer active', errorCode: 'NO_ACTIVE_CONFLICT' }, 409)
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const preferredRouteId = normalizePositiveInteger(body.preferredRouteId)
    if (!preferredRouteId) {
      return c.json({ error: 'Preferred route is required', errorCode: 'PREFERRED_ROUTE_REQUIRED' }, 400)
    }

    const preferredRoute = conflict.routes.find((route) => route.id === preferredRouteId)
    if (!preferredRoute) {
      return c.json({ error: 'Preferred route does not belong to this Beam ID', errorCode: 'PREFERRED_ROUTE_INVALID' }, 400)
    }

    const note = normalizeOptionalString(body.note)
    const disableCompetingRoutes = body.disableCompetingRoutes === true

    setOpenClawRouteOwnerResolution(db, {
      routeId: preferredRouteId,
      resolutionState: 'preferred',
      actor: auth.session.email,
      note: note ?? `Preferred during guided remediation for ${beamId}.`,
    })

    const disabledRouteIds: number[] = []
    if (disableCompetingRoutes) {
      for (const route of conflict.routes) {
        if (route.id === preferredRouteId || route.ownerResolutionState === 'disabled') {
          continue
        }
        const updated = setOpenClawRouteOwnerResolution(db, {
          routeId: route.id,
          resolutionState: 'disabled',
          actor: auth.session.email,
          note: note ?? `Disabled during guided remediation for ${beamId}.`,
        })
        if (updated) {
          disabledRouteIds.push(updated.id)
        }
      }
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_conflict.resolved',
      actor: auth.session.email,
      target: `openclaw-conflict:${beamId}`,
      details: {
        role: auth.session.role,
        preferredRouteId,
        disableCompetingRoutes,
        disabledRouteIds,
        note: note ?? null,
      },
    })

    const updatedConflict = buildConflictDetail(db, beamId)
    c.header('Cache-Control', 'no-store')
    return c.json({
      conflict: updatedConflict,
      preferredRouteId,
      disabledRouteIds,
    })
  })

  router.get('/fleet/digest', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const digest = buildOpenClawFleetDigestEnvelope(db, new URL(c.req.url).origin)
    const format = c.req.query('format')
    if (format === 'markdown') {
      c.header('Cache-Control', 'no-store')
      c.header('Content-Type', 'text/markdown; charset=utf-8')
      const timestamp = digest.generatedAt.slice(0, 10)
      c.header('Content-Disposition', `attachment; filename="beam-openclaw-fleet-digest-${timestamp}.md"`)
      return c.body(digest.markdown)
    }

    c.header('Cache-Control', 'no-store')
    return c.json(digest)
  })

  router.patch('/fleet/digest/schedule', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const enabled = body.enabled === undefined ? undefined : body.enabled === true
    const deliveryEmail = body.deliveryEmail === undefined ? undefined : normalizeOptionalString(body.deliveryEmail)
    const escalationEmail = body.escalationEmail === undefined ? undefined : normalizeOptionalString(body.escalationEmail)
    const runHourUtc = body.runHourUtc === undefined ? undefined : normalizeBoundedInteger(body.runHourUtc, 0, 23)
    const runMinuteUtc = body.runMinuteUtc === undefined ? undefined : normalizeBoundedInteger(body.runMinuteUtc, 0, 59)
    const escalateOnCritical = body.escalateOnCritical === undefined ? undefined : body.escalateOnCritical === true

    const schedule = updateOpenClawFleetDigestSchedule(db, {
      enabled,
      deliveryEmail,
      escalationEmail,
      runHourUtc: runHourUtc ?? undefined,
      runMinuteUtc: runMinuteUtc ?? undefined,
      escalateOnCritical,
    })

    logAuditEvent(db, {
      action: 'admin.openclaw_fleet_digest.schedule_updated',
      actor: auth.session.email,
      target: 'openclaw-fleet:digest-schedule',
      details: {
        role: auth.session.role,
        enabled: schedule.enabled === 1,
        deliveryEmail: schedule.delivery_email,
        escalationEmail: schedule.escalation_email,
        runHourUtc: schedule.run_hour_utc,
        runMinuteUtc: schedule.run_minute_utc,
        escalateOnCritical: schedule.escalate_on_critical === 1,
      },
    })

    const runs = listOpenClawFleetDigestRuns(db, 10)
    const runsById = new Map(runs.map((run) => [run.id, run]))
    c.header('Cache-Control', 'no-store')
    return c.json({
      schedule: serializeOpenClawFleetDigestSchedule(schedule, runsById),
    })
  })

  router.post('/fleet/digest/run', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const triggerKind: OpenClawFleetDigestRunTriggerKind = body.triggerKind === 'scheduled' ? 'scheduled' : 'manual'
    const deliver = body.deliver === true
    const respectSchedule = body.respectSchedule === true
    const schedule = getOpenClawFleetDigestSchedule(db)
    if (triggerKind === 'scheduled' && respectSchedule) {
      const dueState = isOpenClawFleetDigestDue(schedule)
      if (!dueState.due) {
        c.header('Cache-Control', 'no-store')
        return c.json({
          ok: true,
          skipped: true,
          reason: schedule.enabled ? 'not_due' : 'disabled',
          schedule: serializeOpenClawFleetDigestSchedule(schedule, new Map(listOpenClawFleetDigestRuns(db, 10).map((run) => [run.id, run]))),
          nextRunAt: dueState.nextRunAt,
        })
      }

      const { digest, run } = buildPersistedOpenClawFleetDigestRun(db, new URL(c.req.url).origin, {
        triggerKind,
        actor: auth.session.email,
        scheduledForAt: dueState.scheduledForAt,
      })

      const deliveries: Array<{
        ok: boolean
        status: OpenClawFleetDigestDeliveryStatus
        errorCode: string | null
        errorMessage: string | null
        delivery: SerializedOpenClawFleetDigestDelivery
      }> = []

      if (deliver) {
        if (schedule.delivery_email) {
          const digestDelivery = await deliverOpenClawFleetDigestRun(db, run, {
            actor: auth.session.email,
            recipientEmail: schedule.delivery_email,
            deliveryKind: 'digest',
          })
          deliveries.push({
            ...digestDelivery,
            delivery: serializeOpenClawFleetDigestDelivery(digestDelivery.delivery, new Map([[run.id, run]])),
          })
        } else {
          const missingDigestDelivery = recordOpenClawFleetDigestDelivery(db, {
            runId: run.id,
            deliveryKind: 'digest',
            recipientEmail: 'unconfigured',
            status: 'skipped',
            errorCode: 'NO_DIGEST_RECIPIENT',
            errorMessage: 'No default fleet digest recipient is configured.',
            detailsJson: JSON.stringify({ actor: auth.session.email }),
          })
          deliveries.push({
            ok: false,
            status: 'skipped',
            errorCode: 'NO_DIGEST_RECIPIENT',
            errorMessage: 'No default fleet digest recipient is configured.',
            delivery: serializeOpenClawFleetDigestDelivery(missingDigestDelivery, new Map([[run.id, run]])),
          })
        }

        if (schedule.escalate_on_critical === 1 && digest.escalations.length > 0) {
          if (schedule.escalation_email) {
            const escalationDelivery = await deliverOpenClawFleetDigestRun(db, run, {
              actor: auth.session.email,
              recipientEmail: schedule.escalation_email,
              deliveryKind: 'escalation',
            })
            deliveries.push({
              ...escalationDelivery,
              delivery: serializeOpenClawFleetDigestDelivery(escalationDelivery.delivery, new Map([[run.id, run]])),
            })
          } else {
            const missingEscalationDelivery = recordOpenClawFleetDigestDelivery(db, {
              runId: run.id,
              deliveryKind: 'escalation',
              recipientEmail: 'unconfigured',
              status: 'skipped',
              errorCode: 'NO_ESCALATION_RECIPIENT',
              errorMessage: 'No escalation recipient is configured for the fleet digest.',
              detailsJson: JSON.stringify({ actor: auth.session.email }),
            })
            deliveries.push({
              ok: false,
              status: 'skipped',
              errorCode: 'NO_ESCALATION_RECIPIENT',
              errorMessage: 'No escalation recipient is configured for the fleet digest.',
              delivery: serializeOpenClawFleetDigestDelivery(missingEscalationDelivery, new Map([[run.id, run]])),
            })
          }
        }
      }

      logAuditEvent(db, {
        action: 'admin.openclaw_fleet_digest.run',
        actor: auth.session.email,
        target: 'openclaw-fleet:digest',
        details: {
          role: auth.session.role,
          triggerKind,
          deliver,
          scheduledForAt: dueState.scheduledForAt,
          runId: run.id,
          deliveryCount: deliveries.length,
        },
      })

      c.header('Cache-Control', 'no-store')
      return c.json({
        ok: true,
        skipped: false,
        run: serializeOpenClawFleetDigestRun(getOpenClawFleetDigestRunById(db, run.id) as OpenClawFleetDigestRunRow),
        digest: buildOpenClawFleetDigestEnvelope(db, new URL(c.req.url).origin),
        deliveries,
      })
    }

    const { digest, run } = buildPersistedOpenClawFleetDigestRun(db, new URL(c.req.url).origin, {
      triggerKind,
      actor: auth.session.email,
    })
    const deliveries: Array<{
      ok: boolean
      status: OpenClawFleetDigestDeliveryStatus
      errorCode: string | null
      errorMessage: string | null
      delivery: SerializedOpenClawFleetDigestDelivery
    }> = []
    if (deliver) {
      const schedule = getOpenClawFleetDigestSchedule(db)
      const targetEmail = schedule.delivery_email ?? auth.session.email
      const digestDelivery = await deliverOpenClawFleetDigestRun(db, run, {
        actor: auth.session.email,
        recipientEmail: targetEmail,
        deliveryKind: 'digest',
      })
      deliveries.push({
        ...digestDelivery,
        delivery: serializeOpenClawFleetDigestDelivery(digestDelivery.delivery, new Map([[run.id, run]])),
      })
      if (schedule.escalate_on_critical === 1 && digest.escalations.length > 0 && schedule.escalation_email) {
        const escalationDelivery = await deliverOpenClawFleetDigestRun(db, run, {
          actor: auth.session.email,
          recipientEmail: schedule.escalation_email,
          deliveryKind: 'escalation',
        })
        deliveries.push({
          ...escalationDelivery,
          delivery: serializeOpenClawFleetDigestDelivery(escalationDelivery.delivery, new Map([[run.id, run]])),
        })
      }
    }
    logAuditEvent(db, {
      action: 'admin.openclaw_fleet_digest.run',
      actor: auth.session.email,
      target: 'openclaw-fleet:digest',
      details: {
        role: auth.session.role,
        triggerKind,
        deliver,
        runId: run.id,
        deliveryCount: deliveries.length,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      skipped: false,
      run: serializeOpenClawFleetDigestRun(getOpenClawFleetDigestRunById(db, run.id) as OpenClawFleetDigestRunRow),
      digest: buildOpenClawFleetDigestEnvelope(db, new URL(c.req.url).origin),
      deliveries,
    })
  })

  router.post('/fleet/digest/deliver', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const requestedEmail = normalizeOptionalString(body.email)
    if (requestedEmail && auth.session.role !== 'admin' && requestedEmail !== auth.session.email) {
      return c.json({ error: 'Only admins can deliver digests to a different mailbox', errorCode: 'FORBIDDEN' }, 403)
    }

    const deliveryKind: OpenClawFleetDigestDeliveryKind = body.kind === 'escalation' ? 'escalation' : 'digest'
    const runId = normalizePositiveInteger(body.runId)
    const run = runId
      ? getOpenClawFleetDigestRunById(db, runId)
      : buildPersistedOpenClawFleetDigestRun(db, new URL(c.req.url).origin, {
          triggerKind: 'manual',
          actor: auth.session.email,
        }).run

    if (!run) {
      return c.json({ error: 'Digest run not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const email = requestedEmail ?? auth.session.email
    const result = await deliverOpenClawFleetDigestRun(db, run, {
      actor: auth.session.email,
      recipientEmail: email,
      deliveryKind,
    })

    logAuditEvent(db, {
      action: result.ok ? 'admin.openclaw_fleet_digest.delivered' : 'admin.openclaw_fleet_digest.delivery_failed',
      actor: auth.session.email,
      target: 'openclaw-fleet:digest',
      details: {
        role: auth.session.role,
        email,
        deliveryKind,
        runId: run.id,
        status: result.status,
        errorCode: result.errorCode,
      },
    })

    if (!result.ok) {
      const statusCode = result.status === 'unavailable' ? 503 : 500
      return c.json({
        error: result.errorMessage ?? 'Failed to deliver fleet digest',
        errorCode: result.errorCode ?? 'EMAIL_DELIVERY_FAILED',
        runId: run.id,
      }, statusCode)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      email,
      kind: deliveryKind,
      deliveredAt: result.delivery.delivered_at,
      summary: parseJson<Record<string, unknown>>(run.summary_json, {}) as BuiltOpenClawFleetDigest['summary'],
    })
  })

  router.post('/fleet/bulk-actions', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const action: OpenClawFleetBulkAction | null =
      body.action === 'apply_labels'
        || body.action === 'stage_revoke_review'
        || body.action === 'clear_revoke_review'
        ? body.action
        : null
    if (!action) {
      return c.json({ error: 'Invalid bulk action', errorCode: 'INVALID_ACTION' }, 400)
    }

    if (!Array.isArray(body.hostIds)) {
      return c.json({ error: 'hostIds must be an array', errorCode: 'INVALID_HOST_IDS' }, 400)
    }
    const hostIds = [...new Set(body.hostIds
      .map((value) => normalizePositiveInteger(value))
      .filter((value): value is number => Boolean(value)))]
    if (hostIds.length === 0) {
      return c.json({ error: 'At least one host id is required', errorCode: 'HOST_IDS_REQUIRED' }, 400)
    }

    const hosts = hostIds.map((hostId) => getOpenClawHostById(db, hostId)).filter((host): host is OpenClawHostRow => Boolean(host))
    if (hosts.length !== hostIds.length) {
      return c.json({ error: 'One or more hosts were not found', errorCode: 'HOST_NOT_FOUND' }, 404)
    }

    const updatedHosts: Array<ReturnType<typeof serializeHost>> = []
    const changedHostIds: number[] = []

    if (action === 'apply_labels') {
      const environmentLabel = Object.prototype.hasOwnProperty.call(body, 'environmentLabel')
        ? normalizeOptionalString(body.environmentLabel)
        : undefined
      const groupLabels = Object.prototype.hasOwnProperty.call(body, 'groupLabels')
        ? (normalizeOptionalStringArray(body.groupLabels) ?? [])
        : undefined
      const owner = Object.prototype.hasOwnProperty.call(body, 'owner')
        ? normalizeOptionalString(body.owner)
        : undefined

      for (const host of hosts) {
        const patch = buildOpenClawHostPlacementPatch(host, {
          environmentLabel,
          groupLabels,
          owner,
        })
        const updated = updateOpenClawHost(db, {
          id: host.id,
          metadataJson: patch.metadataJson,
        })
        if (updated) {
          changedHostIds.push(updated.id)
          updatedHosts.push(serializeHost(db, updated))
        }
      }

      logAuditEvent(db, {
        action: 'admin.openclaw_fleet.bulk_labels_applied',
        actor: auth.session.email,
        target: 'openclaw-fleet:bulk',
        details: {
          role: auth.session.role,
          hostIds: changedHostIds,
          environmentLabel: environmentLabel ?? null,
          groupLabels: groupLabels ?? null,
          owner: owner ?? null,
        },
      })
    } else if (action === 'stage_revoke_review') {
      const reason = normalizeOptionalString(body.reason)
      if (!reason) {
        return c.json({ error: 'A revoke review reason is required', errorCode: 'REASON_REQUIRED' }, 400)
      }
      if (normalizeOptionalString(body.confirmPhrase) !== 'STAGE_REVOKE') {
        return c.json({ error: 'Bulk revoke staging requires confirmPhrase STAGE_REVOKE', errorCode: 'CONFIRMATION_REQUIRED' }, 400)
      }

      const requestedAt = new Date().toISOString()
      for (const host of hosts) {
        const patch = buildOpenClawHostPlacementPatch(host, {
          stageRevokeReview: {
            requestedAt,
            requestedBy: auth.session.email,
            reason,
          },
        })
        const updated = updateOpenClawHost(db, {
          id: host.id,
          metadataJson: patch.metadataJson,
        })
        if (updated) {
          changedHostIds.push(updated.id)
          updatedHosts.push(serializeHost(db, updated))
        }
      }

      logAuditEvent(db, {
        action: 'admin.openclaw_fleet.bulk_revoke_review_staged',
        actor: auth.session.email,
        target: 'openclaw-fleet:bulk',
        details: {
          role: auth.session.role,
          hostIds: changedHostIds,
          reason,
        },
      })
    } else if (action === 'clear_revoke_review') {
      for (const host of hosts) {
        const patch = buildOpenClawHostPlacementPatch(host, {
          clearRevokeReview: true,
        })
        const updated = updateOpenClawHost(db, {
          id: host.id,
          metadataJson: patch.metadataJson,
        })
        if (updated) {
          changedHostIds.push(updated.id)
          updatedHosts.push(serializeHost(db, updated))
        }
      }

      logAuditEvent(db, {
        action: 'admin.openclaw_fleet.bulk_revoke_review_cleared',
        actor: auth.session.email,
        target: 'openclaw-fleet:bulk',
        details: {
          role: auth.session.role,
          hostIds: changedHostIds,
        },
      })
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      action,
      hostIds: changedHostIds,
      hosts: updatedHosts,
    })
  })

  router.post('/hosts/enrollment', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const enrollment = createOpenClawEnrollmentRequest(db, {
      label: normalizeOptionalString(body.label),
      workspaceSlug: normalizeOptionalString(body.workspaceSlug),
      notes: normalizeOptionalString(body.notes),
      expiresAt: nowPlusHoursIso(normalizeHours(body.expiresInHours, 72)),
    })

    logAuditEvent(db, {
      action: 'admin.openclaw_host.enrollment.created',
      actor: auth.session.email,
      target: `openclaw-enrollment:${enrollment.id}`,
      details: {
        role: auth.session.role,
        label: enrollment.label,
        workspaceSlug: enrollment.workspace_slug,
        expiresAt: enrollment.expires_at,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      enrollment: {
        ...serializeEnrollment(enrollment),
        token: enrollment.request_key,
        installPack: buildOpenClawInstallPack({
          directoryUrl: new URL(c.req.url).origin,
          workspaceSlug: enrollment.workspace_slug,
          token: enrollment.request_key,
          label: enrollment.label,
        }),
      },
    }, 201)
  })

  router.get('/hosts', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    refreshOpenClawHostHealth(db)
    recalculateOpenClawRouteStates(db)
    const hosts = listOpenClawHosts(db).map((host) => serializeHost(db, host))
    c.header('Cache-Control', 'no-store')
    return c.json({
      hosts,
      total: hosts.length,
    })
  })

  router.get('/hosts/:id/routes', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const host = getOpenClawHostById(db, hostId)
    if (!host) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    refreshOpenClawHostHealth(db)
    recalculateOpenClawRouteStates(db)
    const refreshedHost = getOpenClawHostById(db, hostId)
    if (!refreshedHost) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const routes = listOpenClawResolvedRoutesForHost(db, refreshedHost.id).map((route) => serializeRoute(db, route))
    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, refreshedHost),
      routes,
      total: routes.length,
    })
  })

  router.get('/hosts/:id/identities', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const host = getOpenClawHostById(db, hostId)
    if (!host) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    refreshOpenClawHostHealth(db)
    recalculateOpenClawRouteStates(db)
    const refreshedHost = getOpenClawHostById(db, hostId)
    if (!refreshedHost) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const routes = listOpenClawResolvedRoutesForHost(db, refreshedHost.id)
    const identities = routes.map((route) => {
      const bindings = listWorkspaceIdentityBindingsByBeamId(db, route.beam_id)
      const agent = getAgent(db, route.beam_id)
      return {
        beamId: route.beam_id,
        displayName: agent?.display_name ?? null,
        org: agent?.org ?? null,
        route: serializeRoute(db, route),
        bindings: bindings.map((binding) => {
          const workspace = getWorkspaceById(db, binding.workspace_id)
          return {
            id: binding.id,
            workspaceId: binding.workspace_id,
            workspaceSlug: workspace?.slug ?? null,
            workspaceName: workspace?.name ?? null,
            bindingType: binding.binding_type,
            status: binding.status,
            owner: binding.owner,
            runtimeType: binding.runtime_type,
          }
        }),
      }
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, refreshedHost),
      identities,
      total: identities.length,
    })
  })

  router.post('/hosts/:id/approve', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const approved = approveOpenClawHost(db, {
      id: hostId,
      approvedBy: auth.session.email,
    })
    if (!approved) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_host.approved',
      actor: auth.session.email,
      target: `openclaw-host:${approved.host.id}`,
      details: {
        role: auth.session.role,
        hostname: approved.host.hostname,
        label: approved.host.label,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, approved.host),
      credential: approved.credential,
    })
  })

  router.post('/hosts/:id/rotate', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const rotated = rotateOpenClawHostCredential(db, { id: hostId })
    if (!rotated) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_host.credential_rotated',
      actor: auth.session.email,
      target: `openclaw-host:${rotated.host.id}`,
      details: {
        role: auth.session.role,
        hostname: rotated.host.hostname,
        label: rotated.host.label,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, rotated.host),
      credential: rotated.credential,
      installPack: buildCredentialRefreshPack({
        directoryUrl: new URL(c.req.url).origin,
        credential: rotated.credential,
      }),
    })
  })

  router.patch('/hosts/:id/profile', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const host = getOpenClawHostById(db, hostId)
    if (!host) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const patch = buildOpenClawHostPlacementPatch(host, {
      environmentLabel: Object.prototype.hasOwnProperty.call(body, 'environmentLabel')
        ? normalizeOptionalString(body.environmentLabel)
        : undefined,
      groupLabels: Object.prototype.hasOwnProperty.call(body, 'groupLabels')
        ? (normalizeOptionalStringArray(body.groupLabels) ?? [])
        : undefined,
      owner: Object.prototype.hasOwnProperty.call(body, 'owner')
        ? normalizeOptionalString(body.owner)
        : undefined,
      clearRevokeReview: body.clearRevokeReview === true,
    })

    const updated = updateOpenClawHost(db, {
      id: host.id,
      metadataJson: patch.metadataJson,
    })
    if (!updated) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_host.profile_updated',
      actor: auth.session.email,
      target: `openclaw-host:${updated.id}`,
      details: {
        role: auth.session.role,
        environmentLabel: patch.placement.environmentLabel,
        groupLabels: patch.placement.groupLabels,
        owner: patch.placement.owner,
        clearRevokeReview: body.clearRevokeReview === true,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, updated),
    })
  })

  router.patch('/hosts/:id/policy', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const host = getOpenClawHostById(db, hostId)
    if (!host) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const metadata = parseOpenClawHostMetadata(host.metadata_json)
    const nextMetadata: OpenClawHostMetadataJson = {
      ...metadata,
      credentialPolicy: {
        ...(metadata.credentialPolicy ?? {}),
        rotationIntervalHours: normalizePositiveInteger(body.rotationIntervalHours)
          ?? metadata.credentialPolicy?.rotationIntervalHours
          ?? DEFAULT_OPENCLAW_ROTATION_INTERVAL_HOURS,
        rotationWindowStartHour: normalizeBoundedInteger(body.rotationWindowStartHour, 0, 23)
          ?? metadata.credentialPolicy?.rotationWindowStartHour
          ?? DEFAULT_OPENCLAW_ROTATION_WINDOW_START_HOUR,
        rotationWindowDurationHours: normalizeBoundedInteger(body.rotationWindowDurationHours, 1, 24)
          ?? metadata.credentialPolicy?.rotationWindowDurationHours
          ?? DEFAULT_OPENCLAW_ROTATION_WINDOW_DURATION_HOURS,
      },
      recoveryRunbook: {
        ...(metadata.recoveryRunbook ?? {}),
        owner: normalizeOptionalString(body.recoveryOwner)
          ?? metadata.recoveryRunbook?.owner
          ?? null,
        status: body.recoveryStatus === 'prepared'
          || body.recoveryStatus === 'cutover_pending'
          || body.recoveryStatus === 'completed'
          || body.recoveryStatus === 'idle'
          ? body.recoveryStatus
          : (metadata.recoveryRunbook?.status ?? 'idle'),
        notes: normalizeOptionalString(body.recoveryNotes)
          ?? metadata.recoveryRunbook?.notes
          ?? null,
        replacementHostLabel: normalizeOptionalString(body.replacementHostLabel)
          ?? metadata.recoveryRunbook?.replacementHostLabel
          ?? null,
        windowStartsAt: normalizeIsoDateTime(body.recoveryWindowStartsAt)
          ?? metadata.recoveryRunbook?.windowStartsAt
          ?? null,
        windowEndsAt: normalizeIsoDateTime(body.recoveryWindowEndsAt)
          ?? metadata.recoveryRunbook?.windowEndsAt
          ?? null,
        updatedAt: new Date().toISOString(),
      },
    }

    const updated = updateOpenClawHost(db, {
      id: host.id,
      metadataJson: serializeOpenClawHostMetadata(nextMetadata),
    })
    if (!updated) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_host.policy_updated',
      actor: auth.session.email,
      target: `openclaw-host:${updated.id}`,
      details: {
        role: auth.session.role,
        rotationIntervalHours: nextMetadata.credentialPolicy?.rotationIntervalHours ?? null,
        rotationWindowStartHour: nextMetadata.credentialPolicy?.rotationWindowStartHour ?? null,
        rotationWindowDurationHours: nextMetadata.credentialPolicy?.rotationWindowDurationHours ?? null,
        recoveryOwner: nextMetadata.recoveryRunbook?.owner ?? null,
        recoveryStatus: nextMetadata.recoveryRunbook?.status ?? null,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, updated),
    })
  })

  router.post('/hosts/:id/recover', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const recovered = recoverOpenClawHost(db, {
      id: hostId,
      recoveredBy: auth.session.email,
    })
    if (!recovered) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const recoveryMetadata = parseOpenClawHostMetadata(recovered.host.metadata_json)
    const recoveredHost = updateOpenClawHost(db, {
      id: recovered.host.id,
      metadataJson: serializeOpenClawHostMetadata({
        ...recoveryMetadata,
        recoveryRunbook: {
          ...(recoveryMetadata.recoveryRunbook ?? {}),
          owner: normalizeOptionalString(recoveryMetadata.recoveryRunbook?.owner) ?? auth.session.email,
          status: 'cutover_pending',
          updatedAt: new Date().toISOString(),
        },
      }),
    }) as OpenClawHostRow

    logAuditEvent(db, {
      action: 'admin.openclaw_host.recovered',
      actor: auth.session.email,
      target: `openclaw-host:${recoveredHost.id}`,
      details: {
        role: auth.session.role,
        hostname: recoveredHost.hostname,
        label: recoveredHost.label,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, recoveredHost),
      credential: recovered.credential,
      installPack: buildCredentialRefreshPack({
        directoryUrl: new URL(c.req.url).origin,
        credential: recovered.credential,
      }),
    })
  })

  router.post('/hosts/:id/recovery/cleanup', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const host = getOpenClawHostById(db, hostId)
    if (!host) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const policy = serializeOpenClawHostPolicy(host)
    if (!policy.recovery.cleanupRecommended) {
      return c.json({ error: 'Recovery cleanup is not currently required', errorCode: 'RECOVERY_CLEANUP_NOT_REQUIRED' }, 409)
    }

    const metadata = parseOpenClawHostMetadata(host.metadata_json)
    const updated = updateOpenClawHost(db, {
      id: host.id,
      metadataJson: serializeOpenClawHostMetadata({
        ...metadata,
        recoveryRunbook: {
          ...(metadata.recoveryRunbook ?? {}),
          owner: normalizeOptionalString(metadata.recoveryRunbook?.owner),
          status: 'idle',
          notes: null,
          replacementHostLabel: null,
          windowStartsAt: null,
          windowEndsAt: null,
          updatedAt: new Date().toISOString(),
        },
      }),
    })
    if (!updated) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_host.recovery_cleanup_completed',
      actor: auth.session.email,
      target: `openclaw-host:${updated.id}`,
      details: {
        role: auth.session.role,
        owner: serializeOpenClawHostPolicy(updated).recovery.owner,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, updated),
    })
  })

  router.post('/hosts/:id/revoke', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const revoked = revokeOpenClawHost(db, {
      id: hostId,
      reason: normalizeOptionalString(body.reason),
    })
    if (!revoked) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_host.revoked',
      actor: auth.session.email,
      target: `openclaw-host:${revoked.id}`,
      details: {
        role: auth.session.role,
        reason: revoked.revocation_reason,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, revoked),
    })
  })

  router.post('/routes/:id/prefer', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const routeId = normalizePositiveInteger(c.req.param('id'))
    if (!routeId) {
      return c.json({ error: 'Invalid route id', errorCode: 'INVALID_ROUTE_ID' }, 400)
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const updated = setOpenClawRouteOwnerResolution(db, {
      routeId,
      resolutionState: 'preferred',
      actor: auth.session.email,
      note: normalizeOptionalString(body.note),
    })
    if (!updated) {
      return c.json({ error: 'Route not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_route.preferred',
      actor: auth.session.email,
      target: `openclaw-route:${updated.id}`,
      details: {
        role: auth.session.role,
        beamId: updated.beam_id,
        hostId: updated.host_id,
      },
    })

    const resolved = listOpenClawResolvedRoutesByBeamId(db, updated.beam_id).find((entry) => entry.id === updated.id)
    return c.json({
      route: resolved ? serializeRoute(db, resolved) : null,
    })
  })

  router.post('/routes/:id/disable', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const routeId = normalizePositiveInteger(c.req.param('id'))
    if (!routeId) {
      return c.json({ error: 'Invalid route id', errorCode: 'INVALID_ROUTE_ID' }, 400)
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const updated = setOpenClawRouteOwnerResolution(db, {
      routeId,
      resolutionState: 'disabled',
      actor: auth.session.email,
      note: normalizeOptionalString(body.note),
    })
    if (!updated) {
      return c.json({ error: 'Route not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_route.disabled',
      actor: auth.session.email,
      target: `openclaw-route:${updated.id}`,
      details: {
        role: auth.session.role,
        beamId: updated.beam_id,
        hostId: updated.host_id,
      },
    })

    const resolved = listOpenClawResolvedRoutesByBeamId(db, updated.beam_id).find((entry) => entry.id === updated.id)
    return c.json({
      route: resolved ? serializeRoute(db, resolved) : null,
    })
  })

  router.post('/routes/:id/clear-owner', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const routeId = normalizePositiveInteger(c.req.param('id'))
    if (!routeId) {
      return c.json({ error: 'Invalid route id', errorCode: 'INVALID_ROUTE_ID' }, 400)
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const updated = setOpenClawRouteOwnerResolution(db, {
      routeId,
      resolutionState: 'implicit',
      actor: auth.session.email,
      note: normalizeOptionalString(body.note),
    })
    if (!updated) {
      return c.json({ error: 'Route not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.openclaw_route.owner_cleared',
      actor: auth.session.email,
      target: `openclaw-route:${updated.id}`,
      details: {
        role: auth.session.role,
        beamId: updated.beam_id,
        hostId: updated.host_id,
      },
    })

    const resolved = listOpenClawResolvedRoutesByBeamId(db, updated.beam_id).find((entry) => entry.id === updated.id)
    return c.json({
      route: resolved ? serializeRoute(db, resolved) : null,
    })
  })

  router.get('/hosts/:id', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const hostId = normalizePositiveInteger(c.req.param('id'))
    if (!hostId) {
      return c.json({ error: 'Invalid host id', errorCode: 'INVALID_HOST_ID' }, 400)
    }

    const host = getOpenClawHostById(db, hostId)
    if (!host) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    refreshOpenClawHostHealth(db)
    recalculateOpenClawRouteStates(db)
    const refreshedHost = getOpenClawHostById(db, hostId)
    if (!refreshedHost) {
      return c.json({ error: 'Host not found', errorCode: 'NOT_FOUND' }, 404)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      host: serializeHost(db, refreshedHost),
      routes: listOpenClawResolvedRoutesForHost(db, refreshedHost.id).map((route) => serializeRoute(db, route)),
      heartbeats: listOpenClawHostHeartbeats(db, refreshedHost.id, 20).map((row) => ({
        id: row.id,
        routeCount: row.route_count,
        connectorVersion: row.connector_version,
        healthStatus: row.health_status,
        details: row.details_json ? JSON.parse(row.details_json) as Record<string, unknown> : null,
        heartbeatAt: row.heartbeat_at,
      })),
    })
  })

  return router
}

export function openClawPublicRouter(db: Database) {
  const router = new Hono()

  router.post('/enroll', async (c) => {
    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const enrollmentToken = normalizeOptionalString(body.token)
    if (!enrollmentToken) {
      return c.json({ error: 'token is required', errorCode: 'INVALID_ENROLLMENT_TOKEN' }, 400)
    }

    const request = getOpenClawEnrollmentRequestByKey(db, enrollmentToken)
    if (!request) {
      return c.json({ error: 'Enrollment request not found', errorCode: 'NOT_FOUND' }, 404)
    }

    if (request.status === 'revoked' || request.status === 'expired') {
      return c.json({ error: 'Enrollment request is not active', errorCode: 'ENROLLMENT_INACTIVE' }, 403)
    }

    if (request.expires_at && Date.parse(request.expires_at) < Date.now()) {
      updateOpenClawEnrollmentRequest(db, {
        id: request.id,
        status: 'expired',
      })
      return c.json({ error: 'Enrollment request expired', errorCode: 'ENROLLMENT_EXPIRED' }, 410)
    }

    const hostname = normalizeOptionalString(body.hostname) ?? 'unknown-host'
    const os = normalizeOptionalString(body.os) ?? 'unknown-os'
    const connectorVersion = normalizeOptionalString(body.connectorVersion) ?? '0.0.0'
    const beamDirectoryUrl = normalizeOptionalString(body.beamDirectoryUrl) ?? 'unknown'
    const workspaceSlug = normalizeOptionalString(body.workspaceSlug) ?? request.workspace_slug
    const label = normalizeOptionalString(body.label) ?? request.label
    const metadataJson = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? JSON.stringify(body.metadata)
      : null

    let host = getOpenClawHostByEnrollmentRequestId(db, request.id)
    if (!host) {
      host = createOpenClawHost(db, {
        enrollmentRequestId: request.id,
        label,
        hostname,
        os,
        connectorVersion,
        beamDirectoryUrl,
        workspaceSlug,
        metadataJson,
      })
    } else {
      host = updateOpenClawHost(db, {
        id: host.id,
        label,
        hostname,
        os,
        connectorVersion,
        beamDirectoryUrl,
        workspaceSlug,
        metadataJson,
      }) as OpenClawHostRow
    }

    updateOpenClawEnrollmentRequest(db, {
      id: request.id,
      status: host.status === 'active' ? 'approved' : 'pending',
      claimedHostId: host.id,
      claimedAt: host.status === 'active'
        ? (request.claimed_at ?? host.created_at)
        : new Date().toISOString(),
      approvedAt: host.approved_at,
      approvedBy: host.approved_by,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      approved: host.status === 'active',
      host: serializeHost(db, host),
      enrollment: serializeEnrollment(getOpenClawEnrollmentRequestById(db, request.id)),
      credential: host.status === 'active' ? resolveOpenClawHostCredential(host) : null,
    }, host.status === 'active' ? 200 : 202)
  })

  router.post('/heartbeat', async (c) => {
    const host = requireHostCredential(db, c.req.raw)
    if (host instanceof Response) {
      return host
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const routeCount = normalizePositiveInteger(body.routeCount) ?? host.route_count
    const connectorVersion = normalizeOptionalString(body.connectorVersion) ?? host.connector_version
    const detailsJson = body.details && typeof body.details === 'object' && !Array.isArray(body.details)
      ? JSON.stringify(body.details)
      : null

    const heartbeat = recordOpenClawHostHeartbeat(db, {
      hostId: host.id,
      routeCount,
      connectorVersion,
      detailsJson,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      host: serializeHost(db, getOpenClawHostById(db, host.id) as OpenClawHostRow),
      heartbeat: {
        id: heartbeat.id,
        healthStatus: heartbeat.health_status,
        heartbeatAt: heartbeat.heartbeat_at,
      },
    })
  })

  router.post('/inventory', async (c) => {
    const host = requireHostCredential(db, c.req.raw)
    if (host instanceof Response) {
      return host
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const routesInput = Array.isArray(body.routes) ? body.routes : []
    const routes = routesInput.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return []
      }

      const route = entry as Record<string, unknown>
      const beamId = normalizeOptionalString(route.beamId)
      const routeKey = normalizeOptionalString(route.routeKey)
      const routeSource = normalizeOpenClawRouteSource(route.routeSource)
      if (!beamId || !routeKey || !routeSource) {
        return []
      }

      return [{
        beamId,
        workspaceSlug: normalizeOptionalString(route.workspaceSlug) ?? host.workspace_slug,
        routeSource,
        routeKey,
        runtimeType: normalizeOptionalString(route.runtimeType),
        label: normalizeOptionalString(route.label),
        connectionMode: normalizeConnectionMode(route.connectionMode),
        httpEndpoint: normalizeOptionalString(route.httpEndpoint),
        sessionKey: normalizeOptionalString(route.sessionKey),
        reportedState: normalizeReportedState(route.reportedState) ?? 'idle',
        metadataJson: route.metadata && typeof route.metadata === 'object' && !Array.isArray(route.metadata)
          ? JSON.stringify(route.metadata)
          : null,
        lastSeenAt: normalizeOptionalString(route.lastSeenAt),
        endedAt: normalizeOptionalString(route.endedAt),
      }]
    })

    const updatedHost = updateOpenClawHost(db, {
      id: host.id,
      connectorVersion: normalizeOptionalString(body.connectorVersion) ?? host.connector_version,
      beamDirectoryUrl: normalizeOptionalString(body.beamDirectoryUrl) ?? host.beam_directory_url,
      workspaceSlug: normalizeOptionalString(body.workspaceSlug) ?? host.workspace_slug,
      label: normalizeOptionalString(body.label) ?? host.label,
      hostname: normalizeOptionalString(body.hostname) ?? host.hostname,
      os: normalizeOptionalString(body.os) ?? host.os,
    }) as OpenClawHostRow
    const syncedRoutes = syncOpenClawHostRoutes(db, {
      hostId: host.id,
      routes,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      host: serializeHost(db, getOpenClawHostById(db, host.id) as OpenClawHostRow),
      routes: syncedRoutes.map((route) => {
        const resolved = listOpenClawResolvedRoutesByBeamId(db, route.beam_id).find((entry) => entry.id === route.id)
        return resolved ? serializeRoute(db, resolved) : null
      }).filter(Boolean),
      total: syncedRoutes.length,
    })
  })

  router.post('/route-events', async (c) => {
    const host = requireHostCredential(db, c.req.raw)
    if (host instanceof Response) {
      return host
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const eventsInput = Array.isArray(body.events) ? body.events : []
    const events = eventsInput.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return []
      }

      const event = entry as Record<string, unknown>
      const beamId = normalizeOptionalString(event.beamId)
      const routeKey = normalizeOptionalString(event.routeKey)
      const routeSource = normalizeOpenClawRouteSource(event.routeSource)
      if (!beamId || !routeKey || !routeSource) {
        return []
      }

      return [{
        beamId,
        routeKey,
        routeSource,
        reportedState: normalizeReportedState(event.reportedState) ?? 'idle',
        runtimeType: normalizeOptionalString(event.runtimeType),
        label: normalizeOptionalString(event.label),
        workspaceSlug: normalizeOptionalString(event.workspaceSlug),
        sessionKey: normalizeOptionalString(event.sessionKey),
        connectionMode: normalizeConnectionMode(event.connectionMode),
        httpEndpoint: normalizeOptionalString(event.httpEndpoint),
        metadataJson: event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
          ? JSON.stringify(event.metadata)
          : null,
      }]
    })

    const updatedRoutes = applyOpenClawHostRouteEvents(db, {
      hostId: host.id,
      events,
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      host: serializeHost(db, getOpenClawHostById(db, host.id) as OpenClawHostRow),
      routes: updatedRoutes.map((route) => {
        const resolved = listOpenClawResolvedRoutesByBeamId(db, route.beam_id).find((entry) => entry.id === route.id)
        return resolved ? serializeRoute(db, resolved) : null
      }).filter(Boolean),
      total: updatedRoutes.length,
    })
  })

  return router
}
