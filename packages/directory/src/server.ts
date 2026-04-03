import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import type { Server as HttpServer } from 'node:http'
import type { Database } from 'better-sqlite3'
import { adminAuthRouter } from './routes/admin-auth.js'
import { agentsRouter } from './routes/agents.js'
import { billingRouter } from './routes/billing.js'
import { businessVerificationRouter } from './routes/business-verify.js'
import { credentialsRouter } from './routes/credentials.js'
import { delegationsRouter } from './routes/delegations.js'
import { didRouter } from './routes/did.js'
import { federationRouter } from './routes/federation.js'
import { agentKeysRouter, revokedKeysRouter } from './routes/keys.js'
import { orgsRouter } from './routes/orgs.js'
import { buildAlerts, buildAlertsWithNotificationState, buildOverviewPayload, observabilityRouter, type AlertItem } from './routes/observability.js'
import { reportsRouter } from './routes/reports.js'
import { shieldRouter } from './routes/shield.js'
import { openClawAdminRouter, openClawPublicRouter } from './routes/openclaw-hosts.js'
import { verificationRouter } from './routes/verify.js'
import { workspacesRouter } from './routes/workspaces.js'
import { createTrustGateMiddleware } from './middleware/trust-gate.js'
import {
  createWebSocketServer,
  getConnectedCount,
  getConnectedBeamIds,
  recoverInterruptedIntentsOnStartup,
  relayIntentFromHttp,
  RelayError,
  startRecoveredIntentTimeoutSweep,
  stopRecoveredIntentTimeoutSweep,
} from './websocket.js'
import { createAcl, deleteAcl, listAclsForBeam, seedAclsFromCatalog } from './acl.js'
import { getAdminSessionFromRequest, requireAdminRole } from './admin-auth.js'
import {
  assignDirectoryRole,
  deleteDirectoryRole,
  getAgent,
  getDIDDocument,
  getIntentLogByNonce,
  getOperatorNotificationBySourceKey,
  insertFunnelEvent,
  listAgentKeys,
  listAuditLog,
  listFunnelEvents,
  listIntentTraceEvents,
  listDirectoryRoles,
  listOperatorNotifications,
  listOperatorNotificationsBySourceKeys,
  listRecentIntentLogs,
  listShieldAuditLog,
  listTrustScores,
  logAuditEvent,
  updateOperatorNotificationStatus,
  upsertDIDDocument,
  upsertOperatorNotification,
} from './db.js'
import { getFederationSharedSecret, getLocalDirectoryUrl, isPrivateDirectoryMode } from './federation.js'
import { createRateLimitMiddleware } from './middleware/rate-limit.js'
import { getReleaseInfo } from './release.js'
import { sendOperatorDigestEmail } from './email.js'
import type { AgentRow, AuditLogRow, IntentFrame, IntentTraceEventRow, OperatorNotificationRow } from './types.js'
import { loadIntentCatalogDocument } from './validation.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverStartedAt = Date.now()

function nowMinusDays(days: number): string {
  return new Date(Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000).toISOString()
}

type WaitlistSignupInput = {
  email: string
  source: string | null
  company: string | null
  agentCount: number | null
  workflowType: string | null
  workflowSummary: string | null
}

type BetaRequestStatus = 'new' | 'reviewing' | 'contacted' | 'scheduled' | 'active' | 'closed'
type BetaRequestAttention = 'unowned' | 'stale' | 'follow_up_due'
type BetaRequestBlockedPrerequisite =
  | 'workflow_owner_confirmed'
  | 'sender_receiver_confirmed'
  | 'success_metric_confirmed'
  | 'security_review_confirmed'
  | 'go_live_window_confirmed'
  | 'proof_recipients_confirmed'
type BetaRequestSort = 'attention' | 'updated_desc' | 'created_desc' | 'stage' | 'owner' | 'last_contact_desc'
type OperatorNotificationStatus = 'new' | 'acknowledged' | 'acted'
type OperatorNotificationSource = 'beta_request' | 'critical_alert'
type BetaRequestActivityKind =
  | 'request_created'
  | 'stage_changed'
  | 'request_updated'
  | 'contact_logged'
  | 'meeting_scheduled'
  | 'reminder'
  | 'notification'
type BetaRequestActivityTone = 'default' | 'success' | 'warning'
type PartnerHealthStatus = 'healthy' | 'watch' | 'critical'
type FunnelEventCategory = 'page_view' | 'cta_click' | 'request' | 'demo_milestone'
type FunnelPageKey =
  | 'landing'
  | 'guided_evaluation'
  | 'hosted_beta'
  | 'playground'
  | 'register'
  | 'status'
  | 'privacy'
  | 'terms'
  | 'docs_home'
  | 'docs_partner_handoff'
  | 'docs_design_partner_onboarding'
  | 'docs_hosted_quickstart'
  | 'docs_other'

type BetaRequestUpdateInput = {
  status?: BetaRequestStatus
  owner?: string | null
  operatorNotes?: string | null
  nextAction?: string | null
  lastContactAt?: string | null
  nextMeetingAt?: string | null
  reminderAt?: string | null
  proofIntentNonce?: string | null
  blockedPrerequisites?: BetaRequestBlockedPrerequisite[] | null
}

type BetaRequestFilters = {
  q?: string
  status?: string
  owner?: string
  source?: string
  workflowType?: string
  attention?: string
  sort?: string
  limit?: number
}

type OperatorNotificationFilters = {
  q?: string
  status?: string
  source?: string
  limit?: number
  hours?: number
}

type FunnelEventInput = {
  sessionId: string
  pageKey: FunnelPageKey
  eventCategory: FunnelEventCategory
  ctaKey?: string | null
  targetPage?: FunnelPageKey | null
  workflowType?: string | null
  milestoneKey?: string | null
}

type WaitlistRow = {
  id: number
  email: string
  source: string | null
  company: string | null
  agent_count: number | null
  workflow_type: string | null
  workflow_summary: string | null
  proof_intent_nonce: string | null
  status: string
  owner: string | null
  operator_notes: string | null
  next_action: string | null
  last_contact_at: string | null
  next_meeting_at: string | null
  reminder_at: string | null
  blocked_prerequisites: string | null
  stage_entered_at: string | null
  created_at: string
  updated_at: string
}

type PartnerHealthRow = ReturnType<typeof serializeBetaRequest> & {
  workflowTypeLabel: string
  healthStatus: PartnerHealthStatus
  latestIntentStatus: string | null
  latestLatencyMs: number | null
  latencyBreach: boolean
  deadLetter: boolean
  incidentCount: number
  breachCount: number
  alertCount: number
  links: {
    requestHref: string
    traceHref: string | null
    inboxHref: string | null
    alertHref: string | null
  }
}

type PartnerHealthIncident = {
  id: string
  severity: 'warning' | 'critical'
  title: string
  detail: string
  company: string | null
  workflowType: string | null
  owner: string | null
  requestId: number
  requestHref: string
  traceHref: string | null
  alertHref: string | null
  deadLetter: boolean
  followUpDue: boolean
}

type PartnerDigestActionItem = {
  requestId: number
  company: string | null
  email: string
  workflowType: string | null
  stage: BetaRequestStatus
  owner: string | null
  nextAction: string | null
  lastContactAt: string | null
  nextMeetingAt: string | null
  reminderAt: string | null
  proofIntentNonce: string | null
  reason: string
  href: string
}

type BetaRequestProofPack = {
  generatedAt: string
  audience: 'external'
  request: {
    id: number
    company: string | null
    workflowType: string | null
    workflowSummary: string | null
    currentStage: BetaRequestStatus
  }
  proof: {
    headline: string
    summary: string
    recommendation: string
    proofIntentNonce: string
    intentType: string
    deliveryStatus: string
    latencyMs: number | null
    traceStages: string[]
    sender: BetaRequestProofSummaryParty
    recipient: BetaRequestProofSummaryParty
  }
  evidence: {
    releaseUrl: string
    statusUrl: string
    traceReference: string
    requestReference: string
  }
  redaction: {
    excludedFields: string[]
    notes: string[]
  }
  markdown: string
}

type BetaRequestActivityEntry = {
  key: string
  kind: BetaRequestActivityKind
  timestamp: string
  title: string
  detail: string
  actor: string | null
  tone: BetaRequestActivityTone
  href: string | null
  upcoming: boolean
}

type BetaRequestProofSummaryParty = {
  beamId: string
  displayName: string
  verificationTier: string
  trustScore: number | null
  verified: boolean
}

type BetaRequestProofSummary = {
  generatedAt: string
  proofIntentNonce: string
  headline: string
  summary: string
  recommendation: string
  markdown: string
  identity: {
    sender: BetaRequestProofSummaryParty
    recipient: BetaRequestProofSummaryParty
  }
  delivery: {
    intentType: string
    status: string
    requestedAt: string
    completedAt: string | null
    latencyMs: number | null
    traceStageCount: number
    stages: string[]
    routeLabel: string | null
    shieldDecision: string | null
  }
  operatorVisibility: {
    signalStatus: OperatorNotificationStatus | 'missing'
    signalOwner: string | null
    nextAction: string | null
    activityCount: number
    liveAgents: number
    activeAlerts: number
    traceHref: string
    signalHref: string | null
    requestHref: string
  }
}

const BETA_REQUEST_STATUSES: BetaRequestStatus[] = ['new', 'reviewing', 'contacted', 'scheduled', 'active', 'closed']
const BETA_REQUEST_STATUS_SET = new Set<string>(BETA_REQUEST_STATUSES)
const BETA_REQUEST_SORTS: BetaRequestSort[] = ['attention', 'updated_desc', 'created_desc', 'stage', 'owner', 'last_contact_desc']
const BETA_REQUEST_SORT_SET = new Set<string>(BETA_REQUEST_SORTS)
const BETA_REQUEST_ATTENTION_SET = new Set<BetaRequestAttention>(['unowned', 'stale', 'follow_up_due'])
const BETA_REQUEST_BLOCKED_PREREQUISITES: BetaRequestBlockedPrerequisite[] = [
  'workflow_owner_confirmed',
  'sender_receiver_confirmed',
  'success_metric_confirmed',
  'security_review_confirmed',
  'go_live_window_confirmed',
  'proof_recipients_confirmed',
]
const BETA_REQUEST_BLOCKED_PREREQUISITE_SET = new Set<string>(BETA_REQUEST_BLOCKED_PREREQUISITES)
const OPERATOR_NOTIFICATION_STATUSES: OperatorNotificationStatus[] = ['new', 'acknowledged', 'acted']
const OPERATOR_NOTIFICATION_STATUS_SET = new Set<string>(OPERATOR_NOTIFICATION_STATUSES)
const OPERATOR_NOTIFICATION_SOURCES: OperatorNotificationSource[] = ['beta_request', 'critical_alert']
const OPERATOR_NOTIFICATION_SOURCE_SET = new Set<string>(OPERATOR_NOTIFICATION_SOURCES)
const FUNNEL_EVENT_CATEGORIES: FunnelEventCategory[] = ['page_view', 'cta_click', 'request', 'demo_milestone']
const FUNNEL_EVENT_CATEGORY_SET = new Set<string>(FUNNEL_EVENT_CATEGORIES)
const FUNNEL_PAGE_KEYS: FunnelPageKey[] = [
  'landing',
  'guided_evaluation',
  'hosted_beta',
  'playground',
  'register',
  'status',
  'privacy',
  'terms',
  'docs_home',
  'docs_partner_handoff',
  'docs_design_partner_onboarding',
  'docs_hosted_quickstart',
  'docs_other',
]
const FUNNEL_PAGE_KEY_SET = new Set<string>(FUNNEL_PAGE_KEYS)
const FUNNEL_WORKFLOW_TYPES = new Set<string>([
  'hosted-beta-partner-handoff',
  'hosted-beta-operator-eval',
  'hosted-beta-managed-rollout',
  'hosted-beta-compliance',
])
const FUNNEL_MILESTONE_KEYS = new Set<string>([
  'guided_evaluation_view',
  'hosted_beta_view',
  'design_partner_onboarding_view',
  'hosted_quickstart_view',
  'playground_identity_ready',
  'playground_echo_success',
  'hosted_beta_request_submitted',
])
const BETA_REQUEST_STALE_HOURS: Record<BetaRequestStatus, number | null> = {
  new: 24,
  reviewing: 24,
  contacted: 72,
  scheduled: 120,
  active: 96,
  closed: null,
}
const PARTNER_SLA_LATENCY_MS = 5_000
const PARTNER_DIGEST_DEFAULT_DAYS = 7
const PARTNER_HEALTH_DEFAULT_DAYS = 30

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function normalizeOptionalNonce(value: unknown): string | null {
  const normalized = normalizeOptionalString(value)
  if (!normalized) {
    return null
  }

  return /^[A-Za-z0-9:_-]{8,200}$/.test(normalized) ? normalized : null
}

function normalizeOptionalIsoDateTime(value: unknown): string | null {
  if (value == null || value === '') {
    return null
  }

  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  if (!normalized) {
    return null
  }

  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString()
}

function normalizeBetaRequestStatus(value: unknown): BetaRequestStatus | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (!BETA_REQUEST_STATUS_SET.has(normalized)) {
    return null
  }

  return normalized as BetaRequestStatus
}

function normalizeBetaRequestAttention(value: unknown): BetaRequestAttention | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (!BETA_REQUEST_ATTENTION_SET.has(normalized as BetaRequestAttention)) {
    return null
  }

  return normalized as BetaRequestAttention
}

function normalizeBetaRequestSort(value: unknown): BetaRequestSort {
  if (typeof value !== 'string') {
    return 'attention'
  }

  const normalized = value.trim().toLowerCase()
  if (!BETA_REQUEST_SORT_SET.has(normalized)) {
    return 'attention'
  }

  return normalized as BetaRequestSort
}

function normalizeBlockedPrerequisites(value: unknown): BetaRequestBlockedPrerequisite[] | null {
  if (value == null) {
    return []
  }

  if (!Array.isArray(value)) {
    return null
  }

  const normalized: BetaRequestBlockedPrerequisite[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null
    }

    const next = entry.trim().toLowerCase()
    if (!BETA_REQUEST_BLOCKED_PREREQUISITE_SET.has(next)) {
      return null
    }

    if (!normalized.includes(next as BetaRequestBlockedPrerequisite)) {
      normalized.push(next as BetaRequestBlockedPrerequisite)
    }
  }

  return normalized
}

function parseBlockedPrerequisites(value: string | null | undefined): BetaRequestBlockedPrerequisite[] {
  if (!value) {
    return []
  }

  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((entry): entry is BetaRequestBlockedPrerequisite => (
      typeof entry === 'string' && BETA_REQUEST_BLOCKED_PREREQUISITE_SET.has(entry)
    ))
  } catch {
    return []
  }
}

function serializeBlockedPrerequisites(value: BetaRequestBlockedPrerequisite[] | null | undefined): string | null {
  if (!value || value.length === 0) {
    return null
  }

  return JSON.stringify(value)
}

function formatBlockedPrerequisiteLabel(value: BetaRequestBlockedPrerequisite): string {
  switch (value) {
    case 'workflow_owner_confirmed':
      return 'workflow owner confirmed'
    case 'sender_receiver_confirmed':
      return 'sender and receiver confirmed'
    case 'success_metric_confirmed':
      return 'success metric confirmed'
    case 'security_review_confirmed':
      return 'security review confirmed'
    case 'go_live_window_confirmed':
      return 'go-live window confirmed'
    case 'proof_recipients_confirmed':
      return 'proof recipients confirmed'
    default:
      return String(value).split('_').join(' ')
  }
}

function normalizeOperatorNotificationStatus(value: unknown): OperatorNotificationStatus | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (!OPERATOR_NOTIFICATION_STATUS_SET.has(normalized)) {
    return null
  }

  return normalized as OperatorNotificationStatus
}

function normalizeOperatorNotificationSource(value: unknown): OperatorNotificationSource | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (!OPERATOR_NOTIFICATION_SOURCE_SET.has(normalized)) {
    return null
  }

  return normalized as OperatorNotificationSource
}

function normalizeFunnelEventCategory(value: unknown): FunnelEventCategory | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (!FUNNEL_EVENT_CATEGORY_SET.has(normalized)) {
    return null
  }

  return normalized as FunnelEventCategory
}

function normalizeFunnelPageKey(value: unknown): FunnelPageKey | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase().replaceAll('-', '_')
  if (!FUNNEL_PAGE_KEY_SET.has(normalized)) {
    return null
  }

  return normalized as FunnelPageKey
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(normalized)) {
    return null
  }

  return normalized
}

function normalizeFunnelKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase().replaceAll(' ', '_')
  if (!/^[a-z0-9:_-]{2,80}$/.test(normalized)) {
    return null
  }

  return normalized
}

function normalizeWorkflowType(value: unknown): string | null {
  const normalized = normalizeOptionalString(value)
  if (!normalized) {
    return null
  }

  return FUNNEL_WORKFLOW_TYPES.has(normalized) ? normalized : null
}

function normalizeMilestoneKey(value: unknown): string | null {
  const normalized = normalizeFunnelKey(value)
  if (!normalized) {
    return null
  }

  return FUNNEL_MILESTONE_KEYS.has(normalized) ? normalized : null
}

function ratio(part: number, total: number): number | null {
  if (!total) {
    return null
  }

  return Number((part / total).toFixed(4))
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0
  }

  let count = 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const value of small) {
    if (large.has(value)) {
      count += 1
    }
  }

  return count
}

function betaRequestNotificationSourceKey(id: number): string {
  return `beta-request:${id}`
}

function getBetaRequestContactTimestamp(row: WaitlistRow): string {
  return row.last_contact_at ?? row.stage_entered_at ?? row.created_at
}

function getBetaRequestStageTimestamp(row: WaitlistRow): string {
  return row.stage_entered_at ?? row.updated_at ?? row.created_at
}

function formatBetaRequestAgeLabel(hours: number): string {
  if (hours < 1) {
    return '<1h'
  }

  if (hours < 24) {
    return `${Math.round(hours)}h`
  }

  const days = hours / 24
  if (days < 7) {
    return `${Math.round(days)}d`
  }

  return `${Math.round(days / 7)}w`
}

function getBetaRequestAttention(row: WaitlistRow) {
  const stage = normalizeBetaRequestStatus(row.status) ?? 'new'
  const attentionFlags: BetaRequestAttention[] = []
  const stageTimestamp = getBetaRequestStageTimestamp(row)
  const stageTime = new Date(stageTimestamp).getTime()
  const stageAgeHours = Number.isNaN(stageTime)
    ? 0
    : Math.max(0, (Date.now() - stageTime) / (1000 * 60 * 60))
  const stageAgeLabel = formatBetaRequestAgeLabel(stageAgeHours)

  if (stage !== 'closed' && !row.owner) {
    attentionFlags.push('unowned')
  }

  let stale = false
  let staleReason: string | null = null
  const thresholdHours = BETA_REQUEST_STALE_HOURS[stage]
  if (thresholdHours != null && stageAgeHours >= thresholdHours) {
    stale = true
    staleReason = `This request has stayed in the ${stage} stage for ${thresholdHours}+ hours.`
    attentionFlags.push('stale')
  }

  let followUpDue = false
  let followUpReason: string | null = null

  if (stage !== 'closed') {
    if (row.reminder_at) {
      const reminderTime = new Date(row.reminder_at).getTime()
      if (!Number.isNaN(reminderTime) && reminderTime <= Date.now()) {
        followUpDue = true
        followUpReason = 'A follow-up reminder is due now.'
      }
    }

    if (!followUpDue && stage === 'scheduled' && !row.next_meeting_at) {
      followUpDue = true
      followUpReason = 'This request is scheduled, but the next meeting time is still missing.'
    }
  }

  if (followUpDue) {
    attentionFlags.push('follow_up_due')
  }

  return {
    stage,
    stageEnteredAt: stageTimestamp,
    stageAgeHours,
    stageAgeLabel,
    stale,
    staleReason,
    followUpDue,
    followUpReason,
    attentionFlags,
  }
}

function serializeOperatorNotification(row: OperatorNotificationRow) {
  let details: unknown = null
  if (row.details_json) {
    try {
      details = JSON.parse(row.details_json)
    } catch {
      details = null
    }
  }

  return {
    id: row.id,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    betaRequestId: row.beta_request_id,
    alertId: row.alert_id,
    severity: row.severity,
    title: row.title,
    message: row.message,
    href: row.href,
    owner: row.owner,
    nextAction: row.next_action,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at,
    actedAt: row.acted_at,
    actor: row.actor,
    details,
  }
}

function serializeBetaRequest(
  row: WaitlistRow,
  notification?: OperatorNotificationRow | null,
) {
  const attention = getBetaRequestAttention(row)
  const nextAction = row.next_action ?? getBetaRequestNextStep(row.status)
  const blockedPrerequisites = parseBlockedPrerequisites(row.blocked_prerequisites)
  return {
    id: row.id,
    email: row.email,
    source: row.source,
    company: row.company,
    agentCount: row.agent_count,
    workflowType: row.workflow_type,
    workflowSummary: row.workflow_summary,
    proofIntentNonce: row.proof_intent_nonce,
    requestStatus: attention.stage,
    stage: attention.stage,
    owner: row.owner,
    operatorNotes: row.operator_notes,
    nextAction,
    lastContactAt: row.last_contact_at,
    nextMeetingAt: row.next_meeting_at,
    reminderAt: row.reminder_at,
    blockedPrerequisites,
    stageEnteredAt: attention.stageEnteredAt,
    stageAgeHours: attention.stageAgeHours,
    stageAgeLabel: attention.stageAgeLabel,
    stale: attention.stale,
    staleReason: attention.staleReason,
    followUpDue: attention.followUpDue,
    followUpReason: attention.followUpReason,
    attentionFlags: attention.attentionFlags,
    notificationId: notification?.id ?? null,
    notificationStatus: notification?.status ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }

  return null
}

function parseAuditDetails(details: string | null | undefined): Record<string, unknown> | null {
  return parseJsonRecord(details)
}

function formatBetaRequestStatusLabel(value: string | null | undefined): string {
  if (!value) {
    return 'Unknown'
  }

  return value.charAt(0).toUpperCase() + value.slice(1)
}

function describeBetaRequestAuditEntry(log: AuditLogRow): BetaRequestActivityEntry {
  const details = parseAuditDetails(log.details)
  const detailParts: string[] = []
  const nextStatus = typeof details?.status === 'string' ? details.status : null
  const owner = typeof details?.owner === 'string' ? details.owner : null

  if (owner) {
    detailParts.push(`Owner: ${owner}.`)
  }

  if (details?.nextActionChanged === true) {
    detailParts.push('Next action updated.')
  }

  if (details?.operatorNotesChanged === true) {
    detailParts.push('Operator notes updated.')
  }

  if (details?.lastContactChanged === true) {
    detailParts.push('Last contact refreshed.')
  }

  if (details?.nextMeetingChanged === true) {
    detailParts.push('Next meeting updated.')
  }

  if (details?.reminderChanged === true) {
    detailParts.push('Reminder timing updated.')
  }

  if (details?.proofIntentChanged === true) {
    detailParts.push('Pilot proof trace updated.')
  }

  if (details?.blockedPrerequisitesChanged === true) {
    const count = typeof details?.blockedPrerequisiteCount === 'number' ? details.blockedPrerequisiteCount : null
    detailParts.push(
      count && count > 0
        ? `Go-live blockers: ${count}.`
        : 'Go-live blockers cleared.',
    )
  }

  let kind: BetaRequestActivityKind = 'request_updated'
  let title = 'Operator updated the partner request'
  let tone: BetaRequestActivityTone = 'default'

  if (nextStatus) {
    kind = 'stage_changed'
    title = `Stage moved to ${formatBetaRequestStatusLabel(nextStatus)}`
    tone = nextStatus === 'active' || nextStatus === 'closed' ? 'success' : 'default'
  } else if (details?.lastContactChanged === true) {
    kind = 'contact_logged'
    title = 'Last contact was recorded'
    tone = 'success'
  } else if (details?.nextMeetingChanged === true) {
    kind = 'meeting_scheduled'
    title = 'Next meeting plan changed'
  } else if (details?.reminderChanged === true) {
    kind = 'reminder'
    title = 'Follow-up reminder changed'
    tone = 'warning'
  } else if (details?.blockedPrerequisitesChanged === true) {
    title = 'Go-live blockers updated'
    tone = 'warning'
  }

  return {
    key: `audit-${log.id}`,
    kind,
    timestamp: log.timestamp,
    title,
    detail: detailParts.join(' ') || 'Operator metadata changed for this partner request.',
    actor: log.actor,
    tone,
    href: null,
    upcoming: false,
  }
}

function describeNotificationAuditEntry(
  log: AuditLogRow,
  notificationId: number | null,
): BetaRequestActivityEntry | null {
  const details = parseAuditDetails(log.details)
  if (details?.sourceType !== 'beta_request') {
    return null
  }

  const detailParts: string[] = []
  const status = typeof details?.status === 'string' ? details.status : null
  const owner = typeof details?.owner === 'string' ? details.owner : null
  const nextAction = typeof details?.nextAction === 'string' ? details.nextAction : null

  if (owner) {
    detailParts.push(`Owner: ${owner}.`)
  }

  if (nextAction) {
    detailParts.push(`Next: ${nextAction}`)
  }

  let title = 'Operator signal updated'
  let tone: BetaRequestActivityTone = 'default'

  if (status === 'new') {
    title = 'Operator signal reset to new'
    tone = 'warning'
  } else if (status === 'acknowledged') {
    title = 'Operator signal acknowledged'
  } else if (status === 'acted') {
    title = 'Operator signal marked acted'
    tone = 'success'
  }

  return {
    key: `notification-audit-${log.id}`,
    kind: 'notification',
    timestamp: log.timestamp,
    title,
    detail: detailParts.join(' ') || 'Operator signal state changed for this partner request.',
    actor: log.actor,
    tone,
    href: notificationId ? `/inbox?id=${notificationId}` : '/inbox',
    upcoming: false,
  }
}

function buildBetaRequestActivityTimeline(
  db: Database,
  row: WaitlistRow,
  notification?: OperatorNotificationRow | null,
): BetaRequestActivityEntry[] {
  const activities: BetaRequestActivityEntry[] = []
  const stage = normalizeBetaRequestStatus(row.status) ?? 'new'
  const requestHref = `/beta-requests?id=${row.id}`
  const notificationHref = notification?.id ? `/inbox?id=${notification.id}` : '/inbox'
  const workflowLabel = row.workflow_type
    ? row.workflow_type.replace(/^hosted-beta-/, '').replaceAll('-', ' ')
    : 'workflow review'

  activities.push({
    key: `request-${row.id}-created`,
    kind: 'request_created',
    timestamp: row.created_at,
    title: 'Hosted beta request captured',
    detail: `${row.company ?? row.email} entered Beam through ${row.source ?? 'the public intake'} for ${workflowLabel}.`,
    actor: row.email,
    tone: 'default',
    href: requestHref,
    upcoming: false,
  })

  if (row.stage_entered_at) {
    activities.push({
      key: `request-${row.id}-stage-${row.stage_entered_at}`,
      kind: 'stage_changed',
      timestamp: row.stage_entered_at,
      title: `Current stage is ${formatBetaRequestStatusLabel(stage)}`,
      detail: row.next_action ?? getBetaRequestNextStep(stage),
      actor: row.owner,
      tone: stage === 'active' || stage === 'closed' ? 'success' : 'default',
      href: requestHref,
      upcoming: false,
    })
  }

  if (row.last_contact_at) {
    activities.push({
      key: `request-${row.id}-contact-${row.last_contact_at}`,
      kind: 'contact_logged',
      timestamp: row.last_contact_at,
      title: 'Last contact recorded',
      detail: row.owner
        ? `Beam has a recorded touchpoint from ${row.owner}.`
        : 'Beam has a recorded touchpoint for this partner request.',
      actor: row.owner,
      tone: 'success',
      href: requestHref,
      upcoming: false,
    })
  }

  if (row.next_meeting_at) {
    const meetingTime = new Date(row.next_meeting_at).getTime()
    const meetingUpcoming = !Number.isNaN(meetingTime) && meetingTime > Date.now()
    activities.push({
      key: `request-${row.id}-meeting-${row.next_meeting_at}`,
      kind: 'meeting_scheduled',
      timestamp: row.next_meeting_at,
      title: meetingUpcoming ? 'Next meeting is scheduled' : 'Meeting time is in the past',
      detail: row.next_action ?? 'A follow-up meeting is attached to this partner request.',
      actor: row.owner,
      tone: meetingUpcoming ? 'default' : 'warning',
      href: requestHref,
      upcoming: meetingUpcoming,
    })
  }

  if (row.reminder_at) {
    const reminderTime = new Date(row.reminder_at).getTime()
    const reminderDue = !Number.isNaN(reminderTime) && reminderTime <= Date.now()
    const attention = getBetaRequestAttention(row)
    activities.push({
      key: `request-${row.id}-reminder-${row.reminder_at}`,
      kind: 'reminder',
      timestamp: row.reminder_at,
      title: reminderDue ? 'Follow-up reminder is due' : 'Follow-up reminder is scheduled',
      detail: attention.followUpDue
        ? (attention.followUpReason ?? 'A follow-up touchpoint is due.')
        : 'Beam has a scheduled reminder for the next partner touchpoint.',
      actor: row.owner,
      tone: reminderDue ? 'warning' : 'default',
      href: requestHref,
      upcoming: !reminderDue,
    })
  }

  const blockedPrerequisites = parseBlockedPrerequisites(row.blocked_prerequisites)
  if (blockedPrerequisites.length > 0) {
    activities.push({
      key: `request-${row.id}-blocked-${row.updated_at}`,
      kind: 'request_updated',
      timestamp: row.updated_at,
      title: 'Go-live blockers recorded',
      detail: `Still blocked on ${blockedPrerequisites.map(formatBlockedPrerequisiteLabel).join(', ')}.`,
      actor: row.owner,
      tone: 'warning',
      href: requestHref,
      upcoming: false,
    })
  }

  if (notification) {
    activities.push({
      key: `notification-${notification.id}-created`,
      kind: 'notification',
      timestamp: notification.created_at,
      title: 'Operator signal opened',
      detail: notification.message,
      actor: notification.actor,
      tone: 'default',
      href: notificationHref,
      upcoming: false,
    })

    if (notification.acknowledged_at) {
      activities.push({
        key: `notification-${notification.id}-acknowledged`,
        kind: 'notification',
        timestamp: notification.acknowledged_at,
        title: 'Operator signal acknowledged',
        detail: notification.next_action ?? 'Someone took ownership of the next response.',
        actor: notification.actor,
        tone: 'default',
        href: notificationHref,
        upcoming: false,
      })
    }

    if (notification.acted_at) {
      activities.push({
        key: `notification-${notification.id}-acted`,
        kind: 'notification',
        timestamp: notification.acted_at,
        title: 'Operator signal marked acted',
        detail: notification.next_action ?? 'A concrete next step was recorded on the operator signal.',
        actor: notification.actor,
        tone: 'success',
        href: notificationHref,
        upcoming: false,
      })
    }
  }

  for (const audit of listAuditLog(db, {
    action: 'admin.beta_request.updated',
    target: String(row.id),
    limit: 40,
  })) {
    activities.push(describeBetaRequestAuditEntry(audit))
  }

  for (const audit of listAuditLog(db, {
    action: 'admin.operator_notification.updated',
    limit: 80,
  })) {
    const details = parseAuditDetails(audit.details)
    if (details?.sourceKey !== betaRequestNotificationSourceKey(row.id)) {
      continue
    }

    const entry = describeNotificationAuditEntry(audit, notification?.id ?? null)
    if (entry) {
      activities.push(entry)
    }
  }

  return activities.sort((left, right) => {
    const leftTime = new Date(left.timestamp).getTime()
    const rightTime = new Date(right.timestamp).getTime()
    if (leftTime !== rightTime) {
      return rightTime - leftTime
    }

    return left.key.localeCompare(right.key)
  })
}

function formatIntentLifecycleLabel(status: string): string {
  return status
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatBuyerDeliveryOutcome(status: string): string {
  switch (status) {
    case 'acked':
      return 'acknowledged'
    case 'dead_letter':
      return 'dead-lettered'
    default:
      return formatIntentLifecycleLabel(status).toLowerCase()
  }
}

function formatProofParty(agent: AgentRow | null, fallbackBeamId: string): BetaRequestProofSummaryParty {
  return {
    beamId: fallbackBeamId,
    displayName: agent?.display_name ?? fallbackBeamId,
    verificationTier: agent?.verification_tier ?? 'unknown',
    trustScore: typeof agent?.trust_score === 'number' ? Number(agent.trust_score.toFixed(2)) : null,
    verified: agent ? agent.verified === 1 || agent.verification_tier !== 'basic' : false,
  }
}

function formatProofPartyLabel(party: BetaRequestProofSummaryParty): string {
  return party.displayName === party.beamId
    ? party.beamId
    : `${party.displayName} (${party.beamId})`
}

function formatTrustScoreLabel(value: number | null): string {
  if (value == null) {
    return 'n/a'
  }

  return `${Math.round(value * 100)}%`
}

function findTraceRouteLabel(trace: IntentTraceEventRow[]): string | null {
  const details = trace
    .map((entry) => parseJsonRecord(entry.details))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .reverse()

  for (const detail of details) {
    const route = typeof detail.route === 'string'
      ? detail.route
      : typeof detail.transport === 'string'
        ? detail.transport
        : typeof detail.deliveryMode === 'string'
          ? detail.deliveryMode
          : typeof detail.via === 'string'
            ? detail.via
            : typeof detail.channel === 'string'
              ? detail.channel
              : null
    if (route) {
      return route
    }
  }

  return null
}

function getBetaRequestProofRecommendation(row: WaitlistRow): string {
  if (row.next_action) {
    return row.next_action
  }

  switch (normalizeBetaRequestStatus(row.status) ?? 'new') {
    case 'reviewing':
      return 'Confirm the operator owner and move this workflow into a scheduled design-partner review.'
    case 'contacted':
      return 'Book the buyer walkthrough and agree on the smallest production workflow to validate next.'
    case 'scheduled':
      return 'Use the pilot review to lock the first design-partner scope, success criteria, and next operator check-in.'
    case 'active':
      return 'Convert this pilot into a scoped design-partner rollout with named owners and a written success checkpoint.'
    case 'closed':
      return 'Reuse this proof summary only as historical evidence; open a fresh request if the workflow changed.'
    default:
      return 'Review the workflow, assign an owner, and agree on the first production-grade handoff to validate.'
  }
}

function toDashboardUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `https://dashboard.beam.directory${normalizedPath}`
}

function buildBetaRequestProofMarkdown(summary: BetaRequestProofSummary): string {
  return [
    '# Beam pilot proof summary',
    '',
    `**Outcome:** ${summary.headline}`,
    '',
    summary.summary,
    '',
    '## Identity proof',
    `- Sender: ${formatProofPartyLabel(summary.identity.sender)} · ${summary.identity.sender.verificationTier} · trust ${formatTrustScoreLabel(summary.identity.sender.trustScore)}`,
    `- Recipient: ${formatProofPartyLabel(summary.identity.recipient)} · ${summary.identity.recipient.verificationTier} · trust ${formatTrustScoreLabel(summary.identity.recipient.trustScore)}`,
    '',
    '## Delivery proof',
    `- Nonce: ${summary.proofIntentNonce}`,
    `- Intent: ${summary.delivery.intentType}`,
    `- Final status: ${formatIntentLifecycleLabel(summary.delivery.status)}`,
    `- Requested at: ${summary.delivery.requestedAt}`,
    `- Completed at: ${summary.delivery.completedAt ?? 'in flight'}`,
    `- Latency: ${summary.delivery.latencyMs == null ? 'n/a' : `${summary.delivery.latencyMs}ms`}`,
    `- Trace stages: ${summary.delivery.stages.join(' -> ')}`,
    `- Route: ${summary.delivery.routeLabel ?? 'not recorded'}`,
    `- Shield decision: ${summary.delivery.shieldDecision ?? 'not recorded'}`,
    '',
    '## Operator visibility',
    `- Signal status: ${summary.operatorVisibility.signalStatus}`,
    `- Signal owner: ${summary.operatorVisibility.signalOwner ?? 'unassigned'}`,
    `- Next action: ${summary.operatorVisibility.nextAction ?? 'not recorded'}`,
    `- Activity entries: ${summary.operatorVisibility.activityCount}`,
    `- Live agents (24h): ${summary.operatorVisibility.liveAgents}`,
    `- Active alerts (24h): ${summary.operatorVisibility.activeAlerts}`,
    `- Trace: ${toDashboardUrl(summary.operatorVisibility.traceHref)}`,
    `- Operator signal: ${summary.operatorVisibility.signalHref ? toDashboardUrl(summary.operatorVisibility.signalHref) : 'not linked yet'}`,
    `- Request record: ${toDashboardUrl(summary.operatorVisibility.requestHref)}`,
    '',
    '## Recommended next step',
    summary.recommendation,
  ].join('\n')
}

function buildBetaRequestProofSummary(
  db: Database,
  row: WaitlistRow,
  notification: OperatorNotificationRow | null | undefined,
  activity: BetaRequestActivityEntry[],
): BetaRequestProofSummary | null {
  if (!row.proof_intent_nonce) {
    return null
  }

  const intentLog = getIntentLogByNonce(db, row.proof_intent_nonce)
  if (!intentLog) {
    return null
  }

  const trace = listIntentTraceEvents(db, row.proof_intent_nonce)
  const sender = formatProofParty(getAgent(db, intentLog.from_beam_id), intentLog.from_beam_id)
  const recipient = formatProofParty(getAgent(db, intentLog.to_beam_id), intentLog.to_beam_id)
  const overview = buildOverviewPayload(db, 24)
  const alerts = buildAlerts(db, 24)
  const shieldDecision = listShieldAuditLog(db, { nonce: row.proof_intent_nonce, limit: 1 })[0]?.decision ?? null
  const stages = Array.from(new Set(trace.map((entry) => entry.stage)))
  const routeLabel = findTraceRouteLabel(trace)
  const requestHref = `/beta-requests?id=${row.id}`
  const signalHref = notification?.id ? `/inbox?id=${notification.id}` : null
  const traceHref = `/intents/${encodeURIComponent(row.proof_intent_nonce)}`
  const latencyText = intentLog.round_trip_latency_ms == null ? 'without a recorded round-trip latency' : `in ${intentLog.round_trip_latency_ms}ms`
  const routeText = routeLabel ? ` over ${routeLabel}` : ''
  const shieldText = shieldDecision ? ` Beam shield recorded a ${shieldDecision} decision for the same nonce.` : ''
  const headline = `Beam verified a pilot handoff from ${sender.displayName} to ${recipient.displayName} that was ${formatBuyerDeliveryOutcome(intentLog.status)}.`
  const summary = `${formatProofPartyLabel(sender)} (${sender.verificationTier}, trust ${formatTrustScoreLabel(sender.trustScore)}) sent ${intentLog.intent_type} to ${formatProofPartyLabel(recipient)} (${recipient.verificationTier}, trust ${formatTrustScoreLabel(recipient.trustScore)}). Beam recorded ${Math.max(stages.length, 1)} lifecycle stage${Math.max(stages.length, 1) === 1 ? '' : 's'} and finished ${formatBuyerDeliveryOutcome(intentLog.status)} ${latencyText}${routeText}.${shieldText} Operators can open the exact trace${signalHref ? ' and linked signal' : ''} in the dashboard; ${overview.summary.liveAgents} agent(s) were live in the last 24 hours and ${alerts.length} active alert(s) were visible during the same window.`
  const result: BetaRequestProofSummary = {
    generatedAt: new Date().toISOString(),
    proofIntentNonce: row.proof_intent_nonce,
    headline,
    summary,
    recommendation: getBetaRequestProofRecommendation(row),
    markdown: '',
    identity: {
      sender,
      recipient,
    },
    delivery: {
      intentType: intentLog.intent_type,
      status: intentLog.status,
      requestedAt: intentLog.requested_at,
      completedAt: intentLog.completed_at,
      latencyMs: intentLog.round_trip_latency_ms,
      traceStageCount: Math.max(stages.length, 1),
      stages: stages.length > 0 ? stages : [intentLog.status],
      routeLabel,
      shieldDecision,
    },
    operatorVisibility: {
      signalStatus: notification?.status ?? 'missing',
      signalOwner: notification?.owner ?? row.owner ?? null,
      nextAction: notification?.next_action ?? row.next_action ?? null,
      activityCount: activity.length,
      liveAgents: overview.summary.liveAgents,
      activeAlerts: alerts.length,
      traceHref,
      signalHref,
      requestHref,
    },
  }
  result.markdown = buildBetaRequestProofMarkdown(result)
  return result
}

function getBetaRequestNextStep(status: string): string {
  switch (status) {
    case 'reviewing':
      return 'Beam is reviewing the workflow and assigning an operator.'
    case 'contacted':
      return 'Beam will follow up directly on the request by email.'
    case 'scheduled':
      return 'Beam has a follow-up call or working session queued for this request.'
    case 'active':
      return 'This request is in an active hosted beta rollout.'
    case 'closed':
      return 'This request is closed. Submit a fresh intake if the workflow changed materially.'
    default:
      return 'Beam will review the workflow, assign an owner, and follow up with the next concrete step.'
  }
}

function escapeCsvValue(value: string | number | null | undefined): string {
  if (value == null) {
    return ''
  }

  const text = String(value)
  if (!/[",\n]/.test(text)) {
    return text
  }

  return `"${text.replaceAll('"', '""')}"`
}

const PUBLIC_CORS_ORIGINS = new Set([
  'https://beam-dashboard.vercel.app',
  'https://dashboard-phi-five-73.vercel.app',
  'https://dashboard.beam.directory',
  'https://beam.directory',
  'https://www.beam.directory',
  'https://docs.beam.directory',
])

function resolveCorsOrigin(origin?: string | null): string | null {
  if (!origin) {
    return null
  }

  if (PUBLIC_CORS_ORIGINS.has(origin)) {
    return origin
  }

  try {
    const parsed = new URL(origin)
    const isLoopbackHost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    if (isLoopbackHost && isHttp) {
      return origin
    }
  } catch {
    return null
  }

  return null
}

function serializeAgent(row: AgentRow, connectedSet: Set<string>): object {
  const { email_token: _emailToken, ...agent } = row
  return {
    ...agent,
    capabilities: JSON.parse(row.capabilities) as string[],
    personal: row.personal === 1,
    verified: row.verified === 1 || row.verification_tier !== 'basic',
    flagged: row.flagged === 1,
    verificationTier: row.verification_tier,
    connected: connectedSet.has(row.beam_id),
  }
}

function loadIntentCatalog(): unknown {
  return loadIntentCatalogDocument()
}

function hasFederationAuth(c: Context): boolean {
  if (c.req.header('x-beam-mtls-verified') === 'true') {
    return true
  }

  const secret = getFederationSharedSecret()
  return Boolean(secret) && c.req.header('x-beam-federation-secret') === secret
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { name: string } | undefined

  return Boolean(row)
}

function getTableColumns(db: Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function getBetaRequestWhereClause(filters: {
  q?: string
  status?: string
  owner?: string
  source?: string
  workflowType?: string
} = {}): { whereSql: string; params: unknown[] } {
  const params: unknown[] = []
  const conditions: string[] = []

  if (filters.q) {
    const needle = `%${filters.q.trim()}%`
    conditions.push(`(
      email LIKE ?
      OR COALESCE(company, '') LIKE ?
      OR COALESCE(source, '') LIKE ?
      OR COALESCE(workflow_type, '') LIKE ?
      OR COALESCE(workflow_summary, '') LIKE ?
      OR COALESCE(owner, '') LIKE ?
      OR COALESCE(operator_notes, '') LIKE ?
    )`)
    params.push(needle, needle, needle, needle, needle, needle, needle)
  }

  if (filters.status && BETA_REQUEST_STATUS_SET.has(filters.status)) {
    conditions.push('status = ?')
    params.push(filters.status)
  }

  if (filters.owner) {
    if (filters.owner.trim().toLowerCase() === 'unassigned') {
      conditions.push(`COALESCE(owner, '') = ''`)
    } else {
      conditions.push('COALESCE(owner, \'\') LIKE ?')
      params.push(`%${filters.owner.trim()}%`)
    }
  }

  if (filters.source) {
    conditions.push('COALESCE(source, \'\') LIKE ?')
    params.push(`%${filters.source.trim()}%`)
  }

  if (filters.workflowType) {
    conditions.push('COALESCE(workflow_type, \'\') LIKE ?')
    params.push(`%${filters.workflowType.trim()}%`)
  }

  return {
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

function listBetaRequestRows(db: Database, filters: {
  q?: string
  status?: string
  owner?: string
  source?: string
  workflowType?: string
  attention?: string
  sort?: string
  limit?: number
} = {}): { rows: WaitlistRow[]; total: number; allRows: WaitlistRow[] } {
  const limit = Math.min(Math.max(Number(filters.limit ?? 200) || 200, 1), 5000)
  const { whereSql, params } = getBetaRequestWhereClause(filters)
  const rows = db.prepare(`
    SELECT
      id,
      email,
      source,
      company,
      agent_count,
      workflow_type,
      workflow_summary,
      proof_intent_nonce,
      status,
      owner,
      operator_notes,
      next_action,
      last_contact_at,
      next_meeting_at,
      reminder_at,
      blocked_prerequisites,
      stage_entered_at,
      created_at,
      updated_at
    FROM waitlist
    ${whereSql}
  `).all(...params) as WaitlistRow[]

  const attentionFilter = normalizeBetaRequestAttention(filters.attention)
  const filteredRows = attentionFilter
    ? rows.filter((row) => getBetaRequestAttention(row).attentionFlags.includes(attentionFilter))
    : rows

  const sort = normalizeBetaRequestSort(filters.sort)
  const sortedRows = [...filteredRows].sort((left, right) => compareBetaRequestRows(left, right, sort))
  return {
    rows: sortedRows.slice(0, limit),
    total: sortedRows.length,
    allRows: sortedRows,
  }
}

function getBetaRequestById(db: Database, id: number): WaitlistRow | null {
  const row = db.prepare(`
    SELECT
      id,
      email,
      source,
      company,
      agent_count,
      workflow_type,
      workflow_summary,
      proof_intent_nonce,
      status,
      owner,
      operator_notes,
      next_action,
      last_contact_at,
      next_meeting_at,
      reminder_at,
      blocked_prerequisites,
      stage_entered_at,
      created_at,
      updated_at
    FROM waitlist
    WHERE id = ?
    LIMIT 1
  `).get(id) as WaitlistRow | undefined

  return row ?? null
}

function listPartnerAnalyticsRows(db: Database, sinceIso: string): WaitlistRow[] {
  return db.prepare(`
    SELECT
      id,
      email,
      source,
      company,
      agent_count,
      workflow_type,
      workflow_summary,
      proof_intent_nonce,
      status,
      owner,
      operator_notes,
      next_action,
      last_contact_at,
      next_meeting_at,
      reminder_at,
      blocked_prerequisites,
      stage_entered_at,
      created_at,
      updated_at
    FROM waitlist
    WHERE created_at >= ?
    ORDER BY created_at DESC, id DESC
  `).all(sinceIso) as WaitlistRow[]
}

function compareStageOrder(left: BetaRequestStatus, right: BetaRequestStatus): number {
  return BETA_REQUEST_STATUSES.indexOf(left) - BETA_REQUEST_STATUSES.indexOf(right)
}

function compareBetaRequestRows(left: WaitlistRow, right: WaitlistRow, sort: BetaRequestSort): number {
  const leftAttention = getBetaRequestAttention(left)
  const rightAttention = getBetaRequestAttention(right)
  const leftStage = leftAttention.stage
  const rightStage = rightAttention.stage
  const leftUpdated = Date.parse(left.updated_at) || 0
  const rightUpdated = Date.parse(right.updated_at) || 0
  const leftCreated = Date.parse(left.created_at) || 0
  const rightCreated = Date.parse(right.created_at) || 0
  const leftContact = Date.parse(getBetaRequestContactTimestamp(left)) || 0
  const rightContact = Date.parse(getBetaRequestContactTimestamp(right)) || 0

  switch (sort) {
    case 'owner': {
      const leftOwner = left.owner?.toLowerCase() ?? ''
      const rightOwner = right.owner?.toLowerCase() ?? ''
      if (!leftOwner && rightOwner) return -1
      if (leftOwner && !rightOwner) return 1
      return leftOwner.localeCompare(rightOwner) || rightUpdated - leftUpdated
    }
    case 'stage':
      return compareStageOrder(leftStage, rightStage) || rightUpdated - leftUpdated
    case 'created_desc':
      return rightCreated - leftCreated
    case 'last_contact_desc':
      return rightContact - leftContact
    case 'updated_desc':
      return rightUpdated - leftUpdated
    case 'attention':
    default: {
      const leftAttentionScore =
        Number(leftAttention.attentionFlags.includes('unowned')) * 4
        + Number(leftAttention.attentionFlags.includes('follow_up_due')) * 2
        + Number(leftAttention.attentionFlags.includes('stale'))
      const rightAttentionScore =
        Number(rightAttention.attentionFlags.includes('unowned')) * 4
        + Number(rightAttention.attentionFlags.includes('follow_up_due')) * 2
        + Number(rightAttention.attentionFlags.includes('stale'))
      return rightAttentionScore - leftAttentionScore
        || compareStageOrder(leftStage, rightStage)
        || rightUpdated - leftUpdated
        || rightCreated - leftCreated
    }
  }
}

function summarizeBetaRequests(rows: WaitlistRow[], total: number) {
  const byStatus = Object.fromEntries(BETA_REQUEST_STATUSES.map((status) => [status, 0])) as Record<BetaRequestStatus, number>
  let unowned = 0
  let active = 0
  let stale = 0
  let followUpDue = 0
  let needsAttention = 0

  for (const row of rows) {
    const attention = getBetaRequestAttention(row)
    byStatus[attention.stage] += 1
    if (attention.attentionFlags.includes('unowned')) {
      unowned += 1
    }
    if (attention.attentionFlags.includes('stale')) {
      stale += 1
    }
    if (attention.attentionFlags.includes('follow_up_due')) {
      followUpDue += 1
    }
    if (attention.attentionFlags.length > 0) {
      needsAttention += 1
    }
    if (attention.stage !== 'closed') {
      active += 1
    }
  }

  return {
    total,
    active,
    unowned,
    stale,
    followUpDue,
    needsAttention,
    byStatus,
  }
}

function buildBetaRequestCsv(
  rows: WaitlistRow[],
  notificationsBySourceKey = new Map<string, OperatorNotificationRow>(),
): string {
  const headers = [
    'id',
    'email',
    'company',
    'source',
    'workflow_type',
    'workflow_summary',
    'proof_intent_nonce',
    'agent_count',
    'status',
    'owner',
    'operator_notes',
    'next_action',
    'last_contact_at',
    'next_meeting_at',
    'reminder_at',
    'blocked_prerequisites',
    'stage_entered_at',
    'stage_age_hours',
    'follow_up_due',
    'notification_status',
    'stale',
    'attention_flags',
    'created_at',
    'updated_at',
  ]

  const lines = [headers.join(',')]
  for (const row of rows) {
    const attention = getBetaRequestAttention(row)
    const notification = notificationsBySourceKey.get(betaRequestNotificationSourceKey(row.id))
    lines.push([
      row.id,
      row.email,
      row.company,
      row.source,
      row.workflow_type,
      row.workflow_summary,
      row.proof_intent_nonce,
      row.agent_count,
      row.status,
      row.owner,
      row.operator_notes,
      row.next_action ?? getBetaRequestNextStep(row.status),
      row.last_contact_at,
      row.next_meeting_at,
      row.reminder_at,
      parseBlockedPrerequisites(row.blocked_prerequisites).join('|'),
      getBetaRequestStageTimestamp(row),
      attention.stageAgeHours.toFixed(1),
      attention.followUpDue ? 'true' : 'false',
      notification?.status ?? null,
      attention.stale ? 'true' : 'false',
      attention.attentionFlags.join('|'),
      row.created_at,
      row.updated_at,
    ].map((value) => escapeCsvValue(value as string | number | null | undefined)).join(','))
  }

  return `${lines.join('\n')}\n`
}

function getBetaRequestNotifications(
  db: Database,
  rows: WaitlistRow[],
): Map<string, OperatorNotificationRow> {
  const notifications = listOperatorNotificationsBySourceKeys(
    db,
    rows.map((row) => betaRequestNotificationSourceKey(row.id)),
  )

  return new Map(notifications.map((entry) => [entry.source_key, entry]))
}

function getBetaRequestNotificationStatus(row: WaitlistRow): OperatorNotificationStatus | null {
  const stage = normalizeBetaRequestStatus(row.status) ?? 'new'
  if (stage === 'new') {
    return 'new'
  }

  if (row.last_contact_at || row.next_action || stage === 'contacted' || stage === 'scheduled' || stage === 'active' || stage === 'closed') {
    return 'acted'
  }

  if (row.owner || stage === 'reviewing') {
    return 'acknowledged'
  }

  return 'new'
}

function ensureBetaRequestNotification(
  db: Database,
  row: WaitlistRow,
  resetStatus = false,
): OperatorNotificationRow {
  const companyLabel = row.company ?? row.email
  const workflowLabel = row.workflow_type
    ? row.workflow_type.replace(/^hosted-beta-/, '').replaceAll('-', ' ')
    : 'workflow review'
  const messageParts = [
    workflowLabel,
    row.agent_count != null ? `${row.agent_count} agent${row.agent_count === 1 ? '' : 's'}` : null,
    row.workflow_summary ?? null,
  ].filter((part): part is string => Boolean(part))

  return upsertOperatorNotification(db, {
    sourceType: 'beta_request',
    sourceKey: betaRequestNotificationSourceKey(row.id),
    betaRequestId: row.id,
    severity: 'warning',
    title: `Hosted beta request from ${companyLabel}`,
    message: messageParts.join(' · '),
    href: `/beta-requests?id=${row.id}`,
    owner: row.owner,
    nextAction: row.next_action ?? getBetaRequestNextStep(row.status),
    resetStatus,
    details: {
      email: row.email,
      company: row.company,
      workflowType: row.workflow_type,
      stage: normalizeBetaRequestStatus(row.status) ?? 'new',
      nextAction: row.next_action ?? getBetaRequestNextStep(row.status),
      nextMeetingAt: row.next_meeting_at,
      reminderAt: row.reminder_at,
      stageEnteredAt: getBetaRequestStageTimestamp(row),
    },
  })
}

function syncBetaRequestNotificationStatus(
  db: Database,
  row: WaitlistRow,
  actor: string,
): OperatorNotificationRow | null {
  const existing = getOperatorNotificationBySourceKey(db, betaRequestNotificationSourceKey(row.id))
  if (!existing) {
    return null
  }

  const targetStatus = getBetaRequestNotificationStatus(row)
  if (!targetStatus || existing.status === targetStatus) {
    return existing
  }

  return updateOperatorNotificationStatus(db, {
    id: existing.id,
    status: targetStatus,
    actor,
  })
}

function summarizeOperatorNotifications(rows: OperatorNotificationRow[]) {
  return {
    total: rows.length,
    byStatus: {
      new: rows.filter((row) => row.status === 'new').length,
      acknowledged: rows.filter((row) => row.status === 'acknowledged').length,
      acted: rows.filter((row) => row.status === 'acted').length,
    },
    bySource: {
      beta_request: rows.filter((row) => row.source_type === 'beta_request').length,
      critical_alert: rows.filter((row) => row.source_type === 'critical_alert').length,
    },
  }
}

function serializeFunnelEvent(row: {
  id: number
  session_id: string
  origin: string
  page_key: string
  event_category: string
  cta_key: string | null
  target_page: string | null
  workflow_type: string | null
  milestone_key: string | null
  created_at: string
}) {
  return {
    id: row.id,
    sessionId: row.session_id,
    origin: row.origin,
    pageKey: row.page_key,
    eventCategory: row.event_category,
    ctaKey: row.cta_key,
    targetPage: row.target_page,
    workflowType: row.workflow_type,
    milestoneKey: row.milestone_key,
    createdAt: row.created_at,
  }
}

function summarizeFunnel(rows: Array<{
  id: number
  session_id: string
  origin: string
  page_key: string
  event_category: string
  cta_key: string | null
  target_page: string | null
  workflow_type: string | null
  milestone_key: string | null
  created_at: string
}>) {
  const pageViews = rows.filter((row) => row.event_category === 'page_view')
  const ctaClicks = rows.filter((row) => row.event_category === 'cta_click')
  const requests = rows.filter((row) => row.event_category === 'request')
  const demos = rows.filter((row) => row.event_category === 'demo_milestone')
  const sessions = new Set(rows.map((row) => row.session_id))
  const milestoneSets = [
    {
      key: 'landing_visit',
      label: 'Landing visited',
      sessionSet: new Set(rows.filter((row) => row.event_category === 'page_view' && row.page_key === 'landing').map((row) => row.session_id)),
      events: rows.filter((row) => row.event_category === 'page_view' && row.page_key === 'landing').length,
    },
    {
      key: 'guided_evaluation',
      label: 'Guided evaluation viewed',
      sessionSet: new Set(rows.filter((row) => row.event_category === 'page_view' && row.page_key === 'guided_evaluation').map((row) => row.session_id)),
      events: rows.filter((row) => row.event_category === 'page_view' && row.page_key === 'guided_evaluation').length,
    },
    {
      key: 'hosted_beta_view',
      label: 'Hosted beta viewed',
      sessionSet: new Set(rows.filter((row) => row.event_category === 'page_view' && row.page_key === 'hosted_beta').map((row) => row.session_id)),
      events: rows.filter((row) => row.event_category === 'page_view' && row.page_key === 'hosted_beta').length,
    },
    {
      key: 'hosted_beta_request',
      label: 'Hosted beta requested',
      sessionSet: new Set(requests.map((row) => row.session_id)),
      events: requests.length,
    },
    {
      key: 'demo_milestone',
      label: 'Demo milestone reached',
      sessionSet: new Set(demos.map((row) => row.session_id)),
      events: demos.length,
    },
  ]
  const landingSet = milestoneSets[0]?.sessionSet ?? new Set<string>()
  const milestoneRows = milestoneSets.map((entry, index, all) => {
    const previousSet = index === 0 ? null : (all[index - 1]?.sessionSet ?? new Set<string>())
    return {
      key: entry.key,
      label: entry.label,
      sessions: entry.sessionSet.size,
      events: entry.events,
      conversionFromPrevious: previousSet ? ratio(intersectionSize(entry.sessionSet, previousSet), previousSet.size) : null,
      conversionFromLanding: ratio(intersectionSize(entry.sessionSet, landingSet), landingSet.size),
    }
  })

  const entryPages = Array.from(
    pageViews.reduce((map, row) => {
      const current = map.get(row.page_key) ?? { pageKey: row.page_key, events: 0, sessions: new Set<string>() }
      current.events += 1
      current.sessions.add(row.session_id)
      map.set(row.page_key, current)
      return map
    }, new Map<string, { pageKey: string; events: number; sessions: Set<string> }>() ).values(),
  )
    .map((entry) => ({
      pageKey: entry.pageKey,
      events: entry.events,
      sessions: entry.sessions.size,
    }))
    .sort((left, right) => right.sessions - left.sessions || right.events - left.events)

  const ctaSummary = Array.from(
    ctaClicks.reduce((map, row) => {
      const key = row.cta_key ?? 'unknown'
      const current = map.get(key) ?? { ctaKey: key, targetPage: row.target_page, events: 0, sessions: new Set<string>() }
      current.events += 1
      current.sessions.add(row.session_id)
      if (!current.targetPage && row.target_page) {
        current.targetPage = row.target_page
      }
      map.set(key, current)
      return map
    }, new Map<string, { ctaKey: string; targetPage: string | null; events: number; sessions: Set<string> }>() ).values(),
  )
    .map((entry) => ({
      ctaKey: entry.ctaKey,
      targetPage: entry.targetPage,
      events: entry.events,
      sessions: entry.sessions.size,
    }))
    .sort((left, right) => right.sessions - left.sessions || right.events - left.events)

  const milestones = Array.from(
    demos.reduce((map, row) => {
      const key = row.milestone_key ?? 'unknown'
      const current = map.get(key) ?? { milestoneKey: key, events: 0, sessions: new Set<string>() }
      current.events += 1
      current.sessions.add(row.session_id)
      map.set(key, current)
      return map
    }, new Map<string, { milestoneKey: string; events: number; sessions: Set<string> }>() ).values(),
  )
    .map((entry) => ({
      milestoneKey: entry.milestoneKey,
      events: entry.events,
      sessions: entry.sessions.size,
    }))
    .sort((left, right) => right.sessions - left.sessions || right.events - left.events)

  const requestsByWorkflow = Array.from(
    requests.reduce((map, row) => {
      const key = row.workflow_type ?? 'unknown'
      const current = map.get(key) ?? { workflowType: key, events: 0, sessions: new Set<string>() }
      current.events += 1
      current.sessions.add(row.session_id)
      map.set(key, current)
      return map
    }, new Map<string, { workflowType: string; events: number; sessions: Set<string> }>() ).values(),
  )
    .map((entry) => ({
      workflowType: entry.workflowType,
      events: entry.events,
      sessions: entry.sessions.size,
    }))
    .sort((left, right) => right.sessions - left.sessions || right.events - left.events)

  const daily = new Map<string, { day: string; landing: Set<string>; guided: Set<string>; request: Set<string>; demo: Set<string> }>()
  for (const row of rows) {
    const day = row.created_at.slice(0, 10)
    const bucket = daily.get(day) ?? {
      day,
      landing: new Set<string>(),
      guided: new Set<string>(),
      request: new Set<string>(),
      demo: new Set<string>(),
    }

    if (row.event_category === 'page_view' && row.page_key === 'landing') {
      bucket.landing.add(row.session_id)
    }
    if (row.event_category === 'page_view' && row.page_key === 'guided_evaluation') {
      bucket.guided.add(row.session_id)
    }
    if (row.event_category === 'request') {
      bucket.request.add(row.session_id)
    }
    if (row.event_category === 'demo_milestone') {
      bucket.demo.add(row.session_id)
    }

    daily.set(day, bucket)
  }

  const timeline = Array.from(daily.values())
    .sort((left, right) => left.day.localeCompare(right.day))
    .map((entry) => ({
      day: entry.day,
      landingSessions: entry.landing.size,
      guidedSessions: entry.guided.size,
      requestSessions: entry.request.size,
      demoSessions: entry.demo.size,
    }))

  return {
    summary: {
      anonymousSessions: sessions.size,
      pageViews: pageViews.length,
      ctaClicks: ctaClicks.length,
      requestEvents: requests.length,
      demoEvents: demos.length,
      landingSessions: milestoneRows[0]?.sessions ?? 0,
      guidedSessions: milestoneRows[1]?.sessions ?? 0,
      hostedBetaSessions: milestoneRows[2]?.sessions ?? 0,
      requestSessions: milestoneRows[3]?.sessions ?? 0,
      demoSessions: milestoneRows[4]?.sessions ?? 0,
      landingToGuidedRate: milestoneRows[1]?.conversionFromLanding ?? null,
      landingToRequestRate: milestoneRows[3]?.conversionFromLanding ?? null,
      requestToDemoRate: ratio(
        intersectionSize(milestoneSets[4]?.sessionSet ?? new Set<string>(), milestoneSets[3]?.sessionSet ?? new Set<string>()),
        milestoneSets[3]?.sessionSet.size ?? 0,
      ),
    },
    milestones: milestoneRows,
    entryPages,
    ctaClicks: ctaSummary,
    demoMilestones: milestones,
    workflows: requestsByWorkflow,
    timeline,
    recentEvents: rows.slice(0, 40).map((row) => serializeFunnelEvent(row)),
  }
}

function toWeekStart(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp.slice(0, 10)
  }

  const day = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - day)
  date.setUTCHours(0, 0, 0, 0)
  return date.toISOString().slice(0, 10)
}

function summarizePartnerMotion(rows: WaitlistRow[]) {
  const byStage = new Map(BETA_REQUEST_STATUSES.map((stage) => [stage, {
    stage,
    count: 0,
    averageAgeHours: null as number | null,
    oldestAgeHours: null as number | null,
    stale: 0,
    followUpDue: 0,
    unowned: 0,
    proofLinked: 0,
  }]))
  const weekly = new Map<string, {
    weekStart: string
    requests: number
    qualified: number
    scheduled: number
    pilotComplete: number
    nextStepReady: number
  }>()
  const workflows = new Map<string, {
    workflowType: string
    requests: number
    qualified: number
    scheduled: number
    pilotComplete: number
    overdue: number
  }>()

  let qualified = 0
  let scheduled = 0
  let pilotComplete = 0
  let nextStepReady = 0
  let overdueFollowUps = 0
  let stalledRequests = 0
  let unowned = 0

  const stalled = rows
    .map((row) => {
      const attention = getBetaRequestAttention(row)
      const stage = attention.stage
      const isQualified = stage !== 'new'
      const isScheduled = ['scheduled', 'active', 'closed'].includes(stage) || Boolean(row.next_meeting_at)
      const isPilotComplete = Boolean(row.proof_intent_nonce) || stage === 'closed'
      const hasNextStep = Boolean(row.next_action || row.next_meeting_at || row.reminder_at)
      const isStalled = attention.stale || attention.followUpDue
      const workflowType = row.workflow_type ?? 'unknown'
      const stageBucket = byStage.get(stage)

      if (isQualified) {
        qualified += 1
      }
      if (isScheduled) {
        scheduled += 1
      }
      if (isPilotComplete) {
        pilotComplete += 1
      }
      if (hasNextStep) {
        nextStepReady += 1
      }
      if (attention.followUpDue) {
        overdueFollowUps += 1
      }
      if (attention.attentionFlags.includes('unowned')) {
        unowned += 1
      }
      if (isStalled) {
        stalledRequests += 1
      }

      if (stageBucket) {
        stageBucket.count += 1
        stageBucket.averageAgeHours = (stageBucket.averageAgeHours ?? 0) + attention.stageAgeHours
        stageBucket.oldestAgeHours = Math.max(stageBucket.oldestAgeHours ?? 0, attention.stageAgeHours)
        stageBucket.stale += Number(attention.stale)
        stageBucket.followUpDue += Number(attention.followUpDue)
        stageBucket.unowned += Number(attention.attentionFlags.includes('unowned'))
        stageBucket.proofLinked += Number(Boolean(row.proof_intent_nonce))
      }

      const weekStart = toWeekStart(row.created_at)
      const weeklyEntry = weekly.get(weekStart) ?? {
        weekStart,
        requests: 0,
        qualified: 0,
        scheduled: 0,
        pilotComplete: 0,
        nextStepReady: 0,
      }
      weeklyEntry.requests += 1
      weeklyEntry.qualified += Number(isQualified)
      weeklyEntry.scheduled += Number(isScheduled)
      weeklyEntry.pilotComplete += Number(isPilotComplete)
      weeklyEntry.nextStepReady += Number(hasNextStep)
      weekly.set(weekStart, weeklyEntry)

      const workflowEntry = workflows.get(workflowType) ?? {
        workflowType,
        requests: 0,
        qualified: 0,
        scheduled: 0,
        pilotComplete: 0,
        overdue: 0,
      }
      workflowEntry.requests += 1
      workflowEntry.qualified += Number(isQualified)
      workflowEntry.scheduled += Number(isScheduled)
      workflowEntry.pilotComplete += Number(isPilotComplete)
      workflowEntry.overdue += Number(attention.followUpDue)
      workflows.set(workflowType, workflowEntry)

      return {
        id: row.id,
        company: row.company,
        email: row.email,
        workflowType: row.workflow_type,
        stage,
        owner: row.owner,
        stageAgeHours: Number(attention.stageAgeHours.toFixed(1)),
        stageAgeLabel: attention.stageAgeLabel,
        followUpDue: attention.followUpDue,
        stale: attention.stale,
        attentionFlags: attention.attentionFlags,
        followUpReason: attention.followUpReason,
        staleReason: attention.staleReason,
        nextAction: row.next_action ?? getBetaRequestNextStep(stage),
        lastContactAt: row.last_contact_at,
        nextMeetingAt: row.next_meeting_at,
        reminderAt: row.reminder_at,
        proofIntentNonce: row.proof_intent_nonce,
      }
    })
    .filter((row) => row.stale || row.followUpDue)
    .sort((left, right) => {
      const rightScore = Number(right.followUpDue) * 10000 + Number(right.stale) * 1000 + right.stageAgeHours
      const leftScore = Number(left.followUpDue) * 10000 + Number(left.stale) * 1000 + left.stageAgeHours
      return rightScore - leftScore
    })
    .slice(0, 12)

  return {
    summary: {
      requests: rows.length,
      qualified,
      scheduled,
      pilotComplete,
      nextStepReady,
      overdueFollowUps,
      stalledRequests,
      unowned,
      qualificationRate: ratio(qualified, rows.length),
      schedulingRate: ratio(scheduled, rows.length),
      pilotCompleteRate: ratio(pilotComplete, rows.length),
      nextStepRate: ratio(nextStepReady, rows.length),
    },
    byStage: Array.from(byStage.values())
      .map((entry) => ({
        ...entry,
        averageAgeHours: entry.count > 0 && entry.averageAgeHours != null
          ? Number((entry.averageAgeHours / entry.count).toFixed(1))
          : null,
        oldestAgeHours: entry.oldestAgeHours == null ? null : Number(entry.oldestAgeHours.toFixed(1)),
      }))
      .filter((entry) => entry.count > 0)
      .sort((left, right) => compareStageOrder(left.stage, right.stage)),
    stalled,
    weekly: Array.from(weekly.values()).sort((left, right) => left.weekStart.localeCompare(right.weekStart)),
    workflows: Array.from(workflows.values())
      .sort((left, right) => right.requests - left.requests || right.overdue - left.overdue),
  }
}

function formatWorkflowTypeLabel(value: string | null | undefined): string {
  if (!value) {
    return 'Unspecified workflow'
  }

  return value.replace(/^hosted-beta-/, '').replaceAll('-', ' ')
}

function getPartnerAlertHref(alerts: AlertItem[]): string | null {
  for (const alert of alerts) {
    for (const link of alert.links) {
      if (link.href) {
        return link.href
      }
    }
  }

  return null
}

function buildPartnerDigestPayload(
  db: Database,
  days = PARTNER_DIGEST_DEFAULT_DAYS,
  ownerFilter?: string | null,
) {
  const rows = listPartnerAnalyticsRows(db, nowMinusDays(days))
  const notifications = getBetaRequestNotifications(db, rows)
  const filteredRows = rows.filter((row) => {
    const stage = normalizeBetaRequestStatus(row.status) ?? 'new'
    if (ownerFilter && (row.owner ?? '').toLowerCase() !== ownerFilter.trim().toLowerCase()) {
      return false
    }

    return stage !== 'closed' || Boolean(row.next_action || row.next_meeting_at || row.reminder_at || row.proof_intent_nonce)
  })

  const actionItems = filteredRows
    .map((row) => {
      const attention = getBetaRequestAttention(row)
      const serialized = serializeBetaRequest(row, notifications.get(betaRequestNotificationSourceKey(row.id)))
      const upcomingMeetingTime = row.next_meeting_at ? Date.parse(row.next_meeting_at) : Number.NaN
      const meetingSoon = !Number.isNaN(upcomingMeetingTime) && upcomingMeetingTime <= (Date.now() + (7 * 24 * 60 * 60 * 1000))
      const reason = attention.followUpDue
        ? (attention.followUpReason ?? 'A partner follow-up is due now.')
        : meetingSoon
          ? 'An upcoming partner meeting needs preparation and a clear next action.'
          : attention.stale
            ? (attention.staleReason ?? 'This partner thread is aging in its current stage.')
            : serialized.nextAction ?? getBetaRequestNextStep(serialized.stage)
      const urgencyScore =
        Number(attention.followUpDue) * 10_000
        + Number(attention.stale) * 5_000
        + Number(meetingSoon) * 1_000
        + Number(serialized.stage === 'active') * 500
        + Math.round(serialized.stageAgeHours)

      return {
        requestId: row.id,
        company: row.company,
        email: row.email,
        workflowType: row.workflow_type,
        stage: serialized.stage,
        owner: row.owner,
        nextAction: serialized.nextAction,
        lastContactAt: row.last_contact_at,
        nextMeetingAt: row.next_meeting_at,
        reminderAt: row.reminder_at,
        proofIntentNonce: row.proof_intent_nonce,
        reason,
        href: `/beta-requests?id=${row.id}`,
        urgencyScore,
      }
    })
    .sort((left, right) => right.urgencyScore - left.urgencyScore || right.requestId - left.requestId)

  const dueNow = actionItems.filter((entry) => {
    const reminderTime = entry.reminderAt ? Date.parse(entry.reminderAt) : Number.NaN
    return !Number.isNaN(reminderTime) && reminderTime <= Date.now()
  }).length
  const upcomingMeetings = actionItems.filter((entry) => entry.nextMeetingAt).length
  const thisWeekMeetings = actionItems.filter((entry) => {
    const meetingTime = entry.nextMeetingAt ? Date.parse(entry.nextMeetingAt) : Number.NaN
    return !Number.isNaN(meetingTime) && meetingTime <= (Date.now() + (7 * 24 * 60 * 60 * 1000))
  }).length
  const ownedRequests = actionItems.filter((entry) => Boolean(entry.owner)).length
  const markdown = [
    '# Beam partner operator digest',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Window: last ${days} day${days === 1 ? '' : 's'}`,
    ownerFilter ? `Owner filter: ${ownerFilter}` : 'Owner filter: all operators',
    '',
    '## Summary',
    `- Active partner threads: ${actionItems.length}`,
    `- Owned partner threads: ${ownedRequests}`,
    `- Follow-up due now: ${dueNow}`,
    `- Meetings scheduled this week: ${thisWeekMeetings}`,
    '',
    '## Action queue',
    ...(actionItems.length === 0
      ? ['- No partner follow-up items were found in this window.']
      : actionItems.slice(0, 12).map((entry, index) => (
        `${index + 1}. ${entry.company ?? entry.email} · ${formatWorkflowTypeLabel(entry.workflowType)} · ${entry.stage}\n` +
        `   Owner: ${entry.owner ?? 'unassigned'}\n` +
        `   Last contact: ${entry.lastContactAt ?? 'not recorded'}\n` +
        `   Next meeting: ${entry.nextMeetingAt ?? 'not scheduled'}\n` +
        `   Next action: ${entry.nextAction ?? 'not recorded'}\n` +
        `   Reason: ${entry.reason}\n` +
        `   Request: ${toDashboardUrl(entry.href)}`
      ))),
  ].join('\n')

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    ownerFilter: ownerFilter ?? null,
    summary: {
      totalThreads: actionItems.length,
      ownedThreads: ownedRequests,
      dueNow,
      upcomingMeetings,
      meetingsThisWeek: thisWeekMeetings,
      unownedThreads: actionItems.length - ownedRequests,
    },
    actionItems: actionItems.slice(0, 20).map(({ urgencyScore: _urgencyScore, ...entry }) => entry),
    markdown,
  }
}

function buildPartnerHealthPayload(
  db: Database,
  options?: {
    days?: number
    hours?: number
  },
) {
  const windowDays = Math.max(1, options?.days ?? PARTNER_HEALTH_DEFAULT_DAYS)
  const alertWindowHours = Math.max(1, options?.hours ?? 24)
  const rows = listPartnerAnalyticsRows(db, nowMinusDays(windowDays))
  const notifications = getBetaRequestNotifications(db, rows)
  const alerts = buildAlertsWithNotificationState(db, alertWindowHours)
  const alertsByNonce = new Map<string, AlertItem[]>()

  for (const alert of alerts) {
    for (const sample of alert.sampleTraces) {
      const existing = alertsByNonce.get(sample.nonce) ?? []
      existing.push(alert)
      alertsByNonce.set(sample.nonce, existing)
    }
  }

  const requests = rows
    .map((row) => {
      const notification = notifications.get(betaRequestNotificationSourceKey(row.id))
      const serialized = serializeBetaRequest(row, notification)
      const intent = row.proof_intent_nonce ? getIntentLogByNonce(db, row.proof_intent_nonce) : null
      const linkedAlerts = row.proof_intent_nonce ? (alertsByNonce.get(row.proof_intent_nonce) ?? []) : []
      const deadLetter = intent?.status === 'dead_letter'
      const failed = intent?.status === 'failed'
      const latencyMs = intent?.round_trip_latency_ms ?? null
      const latencyBreach = latencyMs != null && latencyMs > PARTNER_SLA_LATENCY_MS
      const breachCount = Number(latencyBreach) + Number(serialized.followUpDue) + Number(serialized.stale)
      const incidentCount = linkedAlerts.length + Number(deadLetter) + Number(failed) + Number(serialized.followUpDue)
      const criticalAlertCount = linkedAlerts.filter((alert) => alert.severity === 'critical').length
      const warningAlertCount = linkedAlerts.filter((alert) => alert.severity === 'warning').length

      let healthStatus: PartnerHealthStatus = 'healthy'
      if (deadLetter || failed || criticalAlertCount > 0 || (serialized.followUpDue && serialized.stage === 'active')) {
        healthStatus = 'critical'
      } else if (latencyBreach || warningAlertCount > 0 || serialized.stale || serialized.followUpDue || serialized.attentionFlags.length > 0) {
        healthStatus = 'watch'
      }

      return {
        ...serialized,
        workflowTypeLabel: formatWorkflowTypeLabel(serialized.workflowType),
        healthStatus,
        latestIntentStatus: intent?.status ?? null,
        latestLatencyMs: latencyMs,
        latencyBreach,
        deadLetter,
        incidentCount,
        breachCount,
        alertCount: linkedAlerts.length,
        links: {
          requestHref: `/beta-requests?id=${row.id}`,
          traceHref: row.proof_intent_nonce ? `/intents/${encodeURIComponent(row.proof_intent_nonce)}` : null,
          inboxHref: notification?.id ? `/inbox?id=${notification.id}` : null,
          alertHref: getPartnerAlertHref(linkedAlerts),
        },
      } satisfies PartnerHealthRow
    })
    .filter((row) => row.stage !== 'closed' || row.incidentCount > 0 || row.proofIntentNonce)
    .sort((left, right) => {
      const score = (row: PartnerHealthRow) => (
        (row.healthStatus === 'critical' ? 100_000 : row.healthStatus === 'watch' ? 10_000 : 0)
        + row.incidentCount * 1_000
        + row.breachCount * 500
        + Math.round(row.stageAgeHours)
      )
      return score(right) - score(left) || right.id - left.id
    })

  const workflows = Array.from(requests.reduce((map, row) => {
    const key = row.workflowType ?? 'unknown'
    const existing = map.get(key) ?? {
      workflowType: key,
      label: row.workflowTypeLabel,
      requests: 0,
      healthy: 0,
      watch: 0,
      critical: 0,
      followUpDue: 0,
      deadLetters: 0,
      averageLatencyMs: null as number | null,
      latencySamples: 0,
    }
    existing.requests += 1
    existing.healthy += Number(row.healthStatus === 'healthy')
    existing.watch += Number(row.healthStatus === 'watch')
    existing.critical += Number(row.healthStatus === 'critical')
    existing.followUpDue += Number(row.followUpDue)
    existing.deadLetters += Number(row.deadLetter)
    if (row.latestLatencyMs != null) {
      existing.averageLatencyMs = (existing.averageLatencyMs ?? 0) + row.latestLatencyMs
      existing.latencySamples += 1
    }
    map.set(key, existing)
    return map
  }, new Map<string, {
    workflowType: string
    label: string
    requests: number
    healthy: number
    watch: number
    critical: number
    followUpDue: number
    deadLetters: number
    averageLatencyMs: number | null
    latencySamples: number
  }>()).values())
    .map((entry) => ({
      workflowType: entry.workflowType,
      label: entry.label,
      requests: entry.requests,
      healthy: entry.healthy,
      watch: entry.watch,
      critical: entry.critical,
      followUpDue: entry.followUpDue,
      deadLetters: entry.deadLetters,
      averageLatencyMs: entry.latencySamples > 0 && entry.averageLatencyMs != null
        ? Number((entry.averageLatencyMs / entry.latencySamples).toFixed(1))
        : null,
    }))
    .sort((left, right) => right.critical - left.critical || right.watch - left.watch || right.requests - left.requests)

  const owners = Array.from(requests.reduce((map, row) => {
    const key = row.owner ?? 'unassigned'
    const existing = map.get(key) ?? {
      owner: row.owner,
      requests: 0,
      critical: 0,
      watch: 0,
      healthy: 0,
      followUpDue: 0,
      nextMeetingScheduled: 0,
    }
    existing.requests += 1
    existing.critical += Number(row.healthStatus === 'critical')
    existing.watch += Number(row.healthStatus === 'watch')
    existing.healthy += Number(row.healthStatus === 'healthy')
    existing.followUpDue += Number(row.followUpDue)
    existing.nextMeetingScheduled += Number(Boolean(row.nextMeetingAt))
    map.set(key, existing)
    return map
  }, new Map<string, {
    owner: string | null
    requests: number
    critical: number
    watch: number
    healthy: number
    followUpDue: number
    nextMeetingScheduled: number
  }>()).values())
    .sort((left, right) => right.critical - left.critical || right.followUpDue - left.followUpDue || right.requests - left.requests)

  const incidents = requests
    .filter((row) => row.healthStatus !== 'healthy')
    .slice(0, 20)
    .map((row) => ({
      id: `request-${row.id}`,
      severity: row.healthStatus === 'critical' ? 'critical' : 'warning',
      title: row.deadLetter
        ? 'Partner workflow hit a dead letter'
        : row.latencyBreach
          ? 'Partner workflow breached the latency target'
          : row.followUpDue
            ? 'Partner workflow needs follow-up'
            : 'Partner workflow needs operator review',
      detail: row.followUpReason
        ?? row.staleReason
        ?? (row.deadLetter ? 'The most recent linked proof trace ended in dead letter.' : null)
        ?? (row.latencyBreach ? `The latest linked proof trace took ${row.latestLatencyMs}ms, above the ${PARTNER_SLA_LATENCY_MS}ms target.` : null)
        ?? row.nextAction
        ?? 'Review the partner request and record the next operational step.',
      company: row.company,
      workflowType: row.workflowType,
      owner: row.owner,
      requestId: row.id,
      requestHref: row.links.requestHref,
      traceHref: row.links.traceHref,
      alertHref: row.links.alertHref,
      deadLetter: row.deadLetter,
      followUpDue: row.followUpDue,
    } satisfies PartnerHealthIncident))

  const digestPreview = buildPartnerDigestPayload(db, PARTNER_DIGEST_DEFAULT_DAYS)

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    alertWindowHours,
    slaLatencyMs: PARTNER_SLA_LATENCY_MS,
    summary: {
      activeRequests: requests.length,
      healthy: requests.filter((row) => row.healthStatus === 'healthy').length,
      watch: requests.filter((row) => row.healthStatus === 'watch').length,
      critical: requests.filter((row) => row.healthStatus === 'critical').length,
      latencyBreaches: requests.filter((row) => row.latencyBreach).length,
      deadLetters: requests.filter((row) => row.deadLetter).length,
      openIncidents: incidents.length,
      followUpDue: requests.filter((row) => row.followUpDue).length,
    },
    requests,
    workflows,
    owners,
    incidents,
    digestPreview: {
      summary: digestPreview.summary,
      markdown: digestPreview.markdown,
    },
  }
}

function buildBetaRequestProofPackMarkdown(pack: BetaRequestProofPack): string {
  return [
    '# Beam partner proof pack',
    '',
    `Generated: ${pack.generatedAt}`,
    '',
    `## Workflow`,
    `- Company: ${pack.request.company ?? 'Unknown partner'}`,
    `- Workflow type: ${formatWorkflowTypeLabel(pack.request.workflowType)}`,
    `- Current stage: ${pack.request.currentStage}`,
    `- Workflow summary: ${pack.request.workflowSummary ?? 'No workflow summary provided.'}`,
    '',
    '## Delivery proof',
    `- Headline: ${pack.proof.headline}`,
    `- Intent: ${pack.proof.intentType}`,
    `- Delivery status: ${pack.proof.deliveryStatus}`,
    `- Latency: ${pack.proof.latencyMs == null ? 'n/a' : `${pack.proof.latencyMs}ms`}`,
    `- Trace stages: ${pack.proof.traceStages.join(' -> ')}`,
    `- Trace reference: ${pack.proof.proofIntentNonce}`,
    '',
    '## Identity proof',
    `- Sender: ${formatProofPartyLabel(pack.proof.sender)} · ${pack.proof.sender.verificationTier} · trust ${formatTrustScoreLabel(pack.proof.sender.trustScore)}`,
    `- Recipient: ${formatProofPartyLabel(pack.proof.recipient)} · ${pack.proof.recipient.verificationTier} · trust ${formatTrustScoreLabel(pack.proof.recipient.trustScore)}`,
    '',
    '## Recommendation',
    pack.proof.recommendation,
    '',
    '## Evidence references',
    `- Trace nonce: ${pack.evidence.traceReference}`,
    `- Request reference: ${pack.evidence.requestReference}`,
    `- Release truth: ${pack.evidence.releaseUrl}`,
    `- Public status: ${pack.evidence.statusUrl}`,
    '',
    '## Redaction notes',
    ...pack.redaction.excludedFields.map((entry) => `- Excluded: ${entry}`),
    ...pack.redaction.notes.map((entry) => `- Note: ${entry}`),
  ].join('\n')
}

function buildBetaRequestProofPack(row: WaitlistRow, summary: BetaRequestProofSummary): BetaRequestProofPack {
  const pack: BetaRequestProofPack = {
    generatedAt: new Date().toISOString(),
    audience: 'external',
    request: {
      id: row.id,
      company: row.company,
      workflowType: row.workflow_type,
      workflowSummary: row.workflow_summary,
      currentStage: normalizeBetaRequestStatus(row.status) ?? 'new',
    },
    proof: {
      headline: summary.headline,
      summary: summary.summary,
      recommendation: getBetaRequestProofRecommendation({
        ...row,
        next_action: null,
      }),
      proofIntentNonce: summary.proofIntentNonce,
      intentType: summary.delivery.intentType,
      deliveryStatus: summary.delivery.status,
      latencyMs: summary.delivery.latencyMs,
      traceStages: summary.delivery.stages,
      sender: summary.identity.sender,
      recipient: summary.identity.recipient,
    },
    evidence: {
      releaseUrl: 'https://api.beam.directory/release',
      statusUrl: 'https://beam.directory/status.html',
      traceReference: summary.proofIntentNonce,
      requestReference: `beta-request:${row.id}`,
    },
    redaction: {
      excludedFields: [
        'request email',
        'operator owner',
        'operator notes',
        'operator signal state',
        'internal inbox and trace URLs',
      ],
      notes: [
        'This export is designed for external recap and commercial next-step conversations.',
        'Operator-only state remains available in the Beam dashboard, not in this artifact.',
      ],
    },
    markdown: '',
  }
  pack.markdown = buildBetaRequestProofPackMarkdown(pack)
  return pack
}

function getWaitlistEntries(db: Database): { available: boolean; waitlist: Array<{ email: string; company: string | null; signupDate: string | null; status: string | null; owner: string | null }>; total: number } {
  if (!tableExists(db, 'waitlist')) {
    return { available: false, waitlist: [], total: 0 }
  }

  const columns = getTableColumns(db, 'waitlist')
  const emailExpr = columns.has('email') ? 'email' : columns.has('contact_email') ? 'contact_email' : ''
  if (!emailExpr) {
    return { available: true, waitlist: [], total: 0 }
  }

  const companyExpr = columns.has('company')
    ? 'company'
    : columns.has('organization')
      ? 'organization'
      : columns.has('source')
        ? 'source'
        : 'NULL'
  const signupDateExpr = columns.has('created_at')
    ? 'created_at'
    : columns.has('signup_date')
      ? 'signup_date'
      : columns.has('createdAt')
        ? 'createdAt'
        : 'NULL'
  const statusExpr = columns.has('status')
    ? 'status'
    : 'NULL'
  const ownerExpr = columns.has('owner')
    ? 'owner'
    : 'NULL'
  const orderByExpr = columns.has('created_at')
    ? 'created_at'
    : columns.has('signup_date')
      ? 'signup_date'
      : columns.has('createdAt')
        ? 'createdAt'
        : 'rowid'

  const rows = db.prepare(`
    SELECT
      ${emailExpr} AS email,
      ${companyExpr} AS company,
      ${signupDateExpr} AS signupDate,
      ${statusExpr} AS status,
      ${ownerExpr} AS owner
    FROM waitlist
    ORDER BY ${orderByExpr} DESC
  `).all() as Array<{ email: string; company: string | null; signupDate: string | null; status: string | null; owner: string | null }>

  return {
    available: true,
    waitlist: rows,
    total: rows.length,
  }
}

function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Beam Directory Admin</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0a0f;
        --card: rgba(255,255,255,0.03);
        --accent: #F75C03;
        --text: #e2e8f0;
        --muted: #64748b;
        --border: rgba(255,255,255,0.08);
        --success: #22c55e;
        --warning: #f59e0b;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, rgba(247,92,3,0.12), transparent 28%), var(--bg);
        color: var(--text);
      }

      .shell {
        max-width: 1440px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }

      .hero {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: flex-end;
        margin-bottom: 24px;
        flex-wrap: wrap;
      }

      h1, h2, h3, p { margin: 0; }
      h1 {
        font-size: 32px;
        line-height: 1.1;
        letter-spacing: -0.03em;
      }

      .subtle {
        color: var(--muted);
        margin-top: 8px;
        font-size: 14px;
      }

      .meta {
        display: flex;
        gap: 12px;
        align-items: center;
        color: var(--muted);
        font-size: 13px;
      }

      .pill, .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--border);
        background: rgba(255,255,255,0.02);
        border-radius: 999px;
        padding: 8px 12px;
      }

      .badge {
        color: var(--accent);
        border-color: rgba(247,92,3,0.35);
        background: rgba(247,92,3,0.08);
        font-weight: 600;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 18px;
        overflow: hidden;
        backdrop-filter: blur(12px);
        min-height: 260px;
      }

      .card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 18px 20px;
        border-bottom: 1px solid var(--border);
      }

      .card-body {
        padding: 12px 0;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        text-align: left;
        padding: 12px 20px;
        font-size: 14px;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        vertical-align: top;
      }

      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      tr:last-child td { border-bottom: none; }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text);
        white-space: nowrap;
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--muted);
        box-shadow: 0 0 0 3px rgba(255,255,255,0.03);
      }

      .dot.online { background: var(--success); }
      .dot.stale { background: var(--warning); }

      .muted { color: var(--muted); }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        font-size: 13px;
      }

      .empty, .error {
        padding: 24px 20px;
        color: var(--muted);
        font-size: 14px;
      }

      .error { color: #fca5a5; }

      @media (max-width: 980px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="hero">
        <div>
          <div class="badge">Beam Directory Admin</div>
          <h1>Network health at a glance</h1>
          <p class="subtle">Live visibility into agents, intents, waitlist demand, and pairwise trust.</p>
        </div>
        <div class="meta">
          <div class="pill">Auto-refresh every 30s</div>
          <div class="pill">Last updated <span id="last-updated">—</span></div>
        </div>
      </div>

      <div class="grid">
        <section class="card">
          <div class="card-header">
            <div>
              <h2>Connected Agents</h2>
              <p class="subtle">Registered agents with current connection state.</p>
            </div>
            <div class="badge" id="agents-count">0</div>
          </div>
          <div class="card-body" id="agents-content"></div>
        </section>

        <section class="card">
          <div class="card-header">
            <div>
              <h2>Recent Intents</h2>
              <p class="subtle">Most recent relay attempts with round-trip latency.</p>
            </div>
            <div class="badge" id="intents-count">0</div>
          </div>
          <div class="card-body" id="intents-content"></div>
        </section>

        <section class="card">
          <div class="card-header">
            <div>
              <h2>Waitlist Signups</h2>
              <p class="subtle">Interest from teams tracking Beam access.</p>
            </div>
            <div class="badge" id="waitlist-count">0</div>
          </div>
          <div class="card-body" id="waitlist-content"></div>
        </section>

        <section class="card">
          <div class="card-header">
            <div>
              <h2>Trust Scores</h2>
              <p class="subtle">Latest pairwise trust values inferred from relay outcomes.</p>
            </div>
            <div class="badge" id="trust-count">0</div>
          </div>
          <div class="card-body" id="trust-content"></div>
        </section>
      </div>
    </div>

    <script>
      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function formatTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return escapeHtml(value);
        return date.toLocaleString();
      }

      function formatLatency(value) {
        return typeof value === 'number' ? value.toLocaleString() + ' ms' : '—';
      }

      function setCount(id, value) {
        document.getElementById(id).textContent = String(value ?? 0);
      }

      function setBody(id, html) {
        document.getElementById(id).innerHTML = html;
      }

      function renderEmpty(message) {
        return '<div class="empty">' + escapeHtml(message) + '</div>';
      }

      function renderError(message) {
        return '<div class="error">' + escapeHtml(message) + '</div>';
      }

      function renderTable(headers, rows) {
        return '<table><thead><tr>'
          + headers.map((header) => '<th>' + escapeHtml(header) + '</th>').join('')
          + '</tr></thead><tbody>'
          + rows.join('')
          + '</tbody></table>';
      }

      function renderAgents(payload) {
        const agents = Array.isArray(payload.agents) ? payload.agents : [];
        setCount('agents-count', payload.total ?? agents.length);
        if (!agents.length) {
          setBody('agents-content', renderEmpty('No agents registered yet.'));
          return;
        }

        const rows = agents.map((agent) => {
          const statusClass = agent.connected ? 'online' : 'stale';
          const statusLabel = agent.connected ? 'Online' : 'Offline';
          return '<tr>'
            + '<td class="mono">' + escapeHtml(agent.beamId) + '</td>'
            + '<td>' + escapeHtml(agent.name) + '</td>'
            + '<td><span class="status"><span class="dot ' + statusClass + '"></span>' + statusLabel + '</span></td>'
            + '<td>' + escapeHtml(formatTime(agent.lastSeen)) + '</td>'
            + '</tr>';
        });

        setBody('agents-content', renderTable(['Beam ID', 'Name', 'Status', 'Last Seen'], rows));
      }

      function renderIntents(payload) {
        const intents = Array.isArray(payload.intents) ? payload.intents : [];
        setCount('intents-count', payload.total ?? intents.length);
        if (!intents.length) {
          setBody('intents-content', renderEmpty('No intent activity recorded yet.'));
          return;
        }

        const rows = intents.map((intent) => '<tr>'
          + '<td class="mono">' + escapeHtml(intent.from) + '</td>'
          + '<td class="mono">' + escapeHtml(intent.to) + '</td>'
          + '<td>' + escapeHtml(intent.intentType) + '</td>'
          + '<td>' + escapeHtml(formatTime(intent.timestamp)) + '</td>'
          + '<td>' + escapeHtml(formatLatency(intent.roundTripLatencyMs)) + '</td>'
          + '</tr>');

        setBody('intents-content', renderTable(['From', 'To', 'Intent', 'Timestamp', 'Latency'], rows));
      }

      function renderWaitlist(payload) {
        const waitlist = Array.isArray(payload.waitlist) ? payload.waitlist : [];
        setCount('waitlist-count', payload.total ?? waitlist.length);
        if (payload.available === false) {
          setBody('waitlist-content', renderEmpty('Waitlist table is not available in this deployment yet.'));
          return;
        }
        if (!waitlist.length) {
          setBody('waitlist-content', renderEmpty('No waitlist signups found.'));
          return;
        }

        const rows = waitlist.map((entry) => '<tr>'
          + '<td>' + escapeHtml(entry.email) + '</td>'
          + '<td>' + escapeHtml(formatTime(entry.signupDate)) + '</td>'
          + '<td>' + escapeHtml(entry.company ?? '—') + '</td>'
          + '</tr>');

        setBody('waitlist-content', renderTable(['Email', 'Signup Date', 'Company'], rows));
      }

      function renderTrust(payload) {
        const trust = Array.isArray(payload.trustScores) ? payload.trustScores : [];
        setCount('trust-count', payload.total ?? trust.length);
        if (!trust.length) {
          setBody('trust-content', renderEmpty('No pairwise trust scores recorded yet.'));
          return;
        }

        const rows = trust.map((entry) => '<tr>'
          + '<td class="mono">' + escapeHtml(entry.from) + '</td>'
          + '<td class="mono">' + escapeHtml(entry.to) + '</td>'
          + '<td>' + escapeHtml(Number(entry.score ?? 0).toFixed(2)) + '</td>'
          + '<td>' + escapeHtml(formatTime(entry.lastUpdated)) + '</td>'
          + '</tr>');

        setBody('trust-content', renderTable(['From', 'To', 'Score', 'Last Updated'], rows));
      }

      async function fetchJson(path) {
        const response = await fetch(path, {
          cache: 'no-store',
          credentials: 'same-origin',
        });

        if (!response.ok) {
          let message = 'Request failed';
          try {
            const payload = await response.json();
            message = payload.error || message;
          } catch {}
          throw new Error(message);
        }

        return response.json();
      }

      async function refresh() {
        try {
          const [agents, intents, waitlist, trust] = await Promise.all([
            fetchJson('/admin/agents'),
            fetchJson('/admin/intents?limit=50'),
            fetchJson('/admin/waitlist'),
            fetchJson('/admin/trust'),
          ]);
          renderAgents(agents);
          renderIntents(intents);
          renderWaitlist(waitlist);
          renderTrust(trust);
          document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to load dashboard data';
          setBody('agents-content', renderError(message));
          setBody('intents-content', renderError(message));
          setBody('waitlist-content', renderError(message));
          setBody('trust-content', renderError(message));
        }
      }

      refresh();
      setInterval(refresh, 30_000);
    </script>
  </body>
</html>`
}

export function createApp(db: Database): Hono {
  const app = new Hono()
  const releaseInfo = getReleaseInfo(serverStartedAt)
  seedAclsFromCatalog(db)

  app.use('*', cors({
    origin: (origin) => resolveCorsOrigin(origin) ?? '',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
    ],
    credentials: true,
  }))

  app.use('*', createRateLimitMiddleware(db))

  // Beam Shield — Wall 1: Body size limit (64KB)
  app.use('*', async (c, next) => {
    const contentLength = parseInt(c.req.header('content-length') ?? '0', 10)
    if (contentLength > 65536) {
      return c.json({ error: 'Payload too large (max 64KB)', errorCode: 'SHIELD_PAYLOAD_TOO_LARGE' }, 413)
    }
    await next()
  })

  // Beam Shield — Wall 2: Trust Gate (per-agent config from DB)
  app.use('*', createTrustGateMiddleware(db, {
    defaultMinTrust: 0.3,
    defaultRateLimit: 20,
  }))

  app.route('/admin/auth', adminAuthRouter(db))

  app.get('/dashboard', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    c.header('Cache-Control', 'no-store')
    return c.html(renderDashboardHtml())
  })

  app.get('/admin/agents', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const rows = db.prepare('SELECT * FROM agents ORDER BY last_seen DESC, beam_id ASC').all() as AgentRow[]
      const connected = new Set(getConnectedBeamIds())
      c.header('Cache-Control', 'no-store')
      return c.json({
        agents: rows.map((row) => ({
          beamId: row.beam_id,
          name: row.display_name,
          connected: connected.has(row.beam_id),
          lastSeen: row.last_seen,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Admin agents error:', err)
      return c.json({ error: 'Failed to load agents', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/intents', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)

    try {
      const rows = listRecentIntentLogs(db, limit)
      c.header('Cache-Control', 'no-store')
      return c.json({
        intents: rows.map((row) => ({
          from: row.from_beam_id,
          to: row.to_beam_id,
          intentType: row.intent_type,
          timestamp: row.requested_at,
          roundTripLatencyMs: row.round_trip_latency_ms,
          status: row.status,
          errorCode: row.error_code,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Admin intents error:', err)
      return c.json({ error: 'Failed to load intents', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.delete('/admin/waitlist', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) return auth
    try {
      const result = db.prepare('DELETE FROM waitlist').run()
      logAuditEvent(db, {
        action: 'admin.waitlist.cleared',
        actor: auth.session.email,
        target: 'waitlist',
        details: { deleted: result.changes, role: auth.session.role },
      })
      return c.json({ deleted: result.changes })
    } catch (err) {
      console.error('Admin waitlist clear error:', err)
      return c.json({ error: 'Failed to clear waitlist', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/beta-requests', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const filters: BetaRequestFilters = {
        q: c.req.query('q') ?? undefined,
        status: c.req.query('status') ?? undefined,
        owner: c.req.query('owner') ?? undefined,
        source: c.req.query('source') ?? undefined,
        workflowType: c.req.query('workflowType') ?? undefined,
        attention: c.req.query('attention') ?? undefined,
        sort: c.req.query('sort') ?? undefined,
        limit: c.req.query('limit') ? Number.parseInt(c.req.query('limit') as string, 10) : undefined,
      }

      const { rows, total, allRows } = listBetaRequestRows(db, filters)
      const notifications = getBetaRequestNotifications(db, rows)
      c.header('Cache-Control', 'no-store')
      return c.json({
        requests: rows.map((row) => serializeBetaRequest(row, notifications.get(betaRequestNotificationSourceKey(row.id)))),
        total,
        summary: summarizeBetaRequests(allRows, total),
      })
    } catch (err) {
      console.error('Admin beta requests error:', err)
      return c.json({ error: 'Failed to load beta requests', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/beta-requests/export', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const format = (c.req.query('format') ?? 'json').trim().toLowerCase()
    if (format !== 'json' && format !== 'csv') {
      return c.json({ error: 'format must be json or csv', errorCode: 'INVALID_EXPORT_FORMAT' }, 400)
    }

    try {
      const filters: BetaRequestFilters = {
        q: c.req.query('q') ?? undefined,
        status: c.req.query('status') ?? undefined,
        owner: c.req.query('owner') ?? undefined,
        source: c.req.query('source') ?? undefined,
        workflowType: c.req.query('workflowType') ?? undefined,
        attention: c.req.query('attention') ?? undefined,
        sort: c.req.query('sort') ?? undefined,
        limit: c.req.query('limit') ? Number.parseInt(c.req.query('limit') as string, 10) : 5000,
      }

      const { rows, total, allRows } = listBetaRequestRows(db, filters)
      const notifications = getBetaRequestNotifications(db, rows)
      const timestamp = new Date().toISOString().replaceAll(':', '-')

      logAuditEvent(db, {
        action: 'admin.beta_requests.exported',
        actor: auth.session.email,
        target: 'beta_requests',
        details: {
          format,
          total,
          filters,
          role: auth.session.role,
        },
      })

      c.header('Cache-Control', 'no-store')
      if (format === 'csv') {
        c.header('Content-Type', 'text/csv; charset=utf-8')
        c.header('Content-Disposition', `attachment; filename="beam-beta-requests-${timestamp}.csv"`)
        return c.body(buildBetaRequestCsv(rows, notifications))
      }

      c.header('Content-Type', 'application/json; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="beam-beta-requests-${timestamp}.json"`)
      return c.body(JSON.stringify({
        exportedAt: new Date().toISOString(),
        total,
        summary: summarizeBetaRequests(allRows, total),
        requests: rows.map((row) => serializeBetaRequest(row, notifications.get(betaRequestNotificationSourceKey(row.id)))),
      }, null, 2))
    } catch (err) {
      console.error('Admin beta request export error:', err)
      return c.json({ error: 'Failed to export beta requests', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/beta-requests/:id', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const id = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid beta request id', errorCode: 'INVALID_BETA_REQUEST_ID' }, 400)
    }

    try {
      const row = getBetaRequestById(db, id)
      if (!row) {
        return c.json({ error: 'Beta request not found', errorCode: 'NOT_FOUND' }, 404)
      }
      const notification = getOperatorNotificationBySourceKey(db, betaRequestNotificationSourceKey(row.id))
      const activity = buildBetaRequestActivityTimeline(db, row, notification)
      c.header('Cache-Control', 'no-store')
      return c.json({
        request: serializeBetaRequest(row, notification),
        activity,
        proofSummary: buildBetaRequestProofSummary(db, row, notification, activity),
      })
    } catch (err) {
      console.error('Admin beta request detail error:', err)
      return c.json({ error: 'Failed to load beta request', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.patch('/admin/beta-requests/:id', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const id = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid beta request id', errorCode: 'INVALID_BETA_REQUEST_ID' }, 400)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const patch: BetaRequestUpdateInput = {}

    if ('status' in raw) {
      const status = normalizeBetaRequestStatus(raw.status)
      if (!status) {
        return c.json({ error: 'Invalid beta request status', errorCode: 'INVALID_BETA_REQUEST_STATUS' }, 400)
      }
      patch.status = status
    }

    if ('owner' in raw) {
      patch.owner = normalizeOptionalString(raw.owner)
    }

    if ('operatorNotes' in raw) {
      patch.operatorNotes = normalizeOptionalString(raw.operatorNotes)
    }

    if ('nextAction' in raw) {
      patch.nextAction = normalizeOptionalString(raw.nextAction)
    }

    if ('lastContactAt' in raw) {
      const lastContactAt = normalizeOptionalIsoDateTime(raw.lastContactAt)
      if (raw.lastContactAt != null && raw.lastContactAt !== '' && !lastContactAt) {
        return c.json({ error: 'Invalid lastContactAt timestamp', errorCode: 'INVALID_LAST_CONTACT' }, 400)
      }
      patch.lastContactAt = lastContactAt
    }

    if ('nextMeetingAt' in raw) {
      const nextMeetingAt = normalizeOptionalIsoDateTime(raw.nextMeetingAt)
      if (raw.nextMeetingAt != null && raw.nextMeetingAt !== '' && !nextMeetingAt) {
        return c.json({ error: 'Invalid nextMeetingAt timestamp', errorCode: 'INVALID_NEXT_MEETING' }, 400)
      }
      patch.nextMeetingAt = nextMeetingAt
    }

    if ('reminderAt' in raw) {
      const reminderAt = normalizeOptionalIsoDateTime(raw.reminderAt)
      if (raw.reminderAt != null && raw.reminderAt !== '' && !reminderAt) {
        return c.json({ error: 'Invalid reminderAt timestamp', errorCode: 'INVALID_REMINDER' }, 400)
      }
      patch.reminderAt = reminderAt
    }

    if ('proofIntentNonce' in raw) {
      const proofIntentNonce = normalizeOptionalNonce(raw.proofIntentNonce)
      if (raw.proofIntentNonce != null && raw.proofIntentNonce !== '' && !proofIntentNonce) {
        return c.json({ error: 'Invalid proofIntentNonce', errorCode: 'INVALID_PROOF_INTENT_NONCE' }, 400)
      }
      patch.proofIntentNonce = proofIntentNonce
    }

    if ('blockedPrerequisites' in raw) {
      const blockedPrerequisites = normalizeBlockedPrerequisites(raw.blockedPrerequisites)
      if (raw.blockedPrerequisites !== null && !blockedPrerequisites) {
        return c.json({ error: 'Invalid blockedPrerequisites', errorCode: 'INVALID_BLOCKED_PREREQUISITES' }, 400)
      }
      patch.blockedPrerequisites = blockedPrerequisites ?? []
    }

    if (
      !('status' in patch)
      && !('owner' in patch)
      && !('operatorNotes' in patch)
      && !('nextAction' in patch)
      && !('lastContactAt' in patch)
      && !('nextMeetingAt' in patch)
      && !('reminderAt' in patch)
      && !('proofIntentNonce' in patch)
      && !('blockedPrerequisites' in patch)
    ) {
      return c.json({ error: 'No supported fields to update', errorCode: 'EMPTY_PATCH' }, 400)
    }

    try {
      const existing = getBetaRequestById(db, id)
      if (!existing) {
        return c.json({ error: 'Beta request not found', errorCode: 'NOT_FOUND' }, 404)
      }

      const nextStatus = patch.status ?? (normalizeBetaRequestStatus(existing.status) ?? 'new')
      const nextOwner = 'owner' in patch ? patch.owner ?? null : existing.owner
      const nextOperatorNotes = 'operatorNotes' in patch ? patch.operatorNotes ?? null : existing.operator_notes
      const nextAction = 'nextAction' in patch ? patch.nextAction ?? null : existing.next_action
      let nextLastContactAt = 'lastContactAt' in patch ? patch.lastContactAt ?? null : existing.last_contact_at
      const nextMeetingAt = 'nextMeetingAt' in patch ? patch.nextMeetingAt ?? null : existing.next_meeting_at
      const nextReminderAt = 'reminderAt' in patch ? patch.reminderAt ?? null : existing.reminder_at
      const nextProofIntentNonce = 'proofIntentNonce' in patch ? patch.proofIntentNonce ?? null : existing.proof_intent_nonce
      const nextBlockedPrerequisites = 'blockedPrerequisites' in patch
        ? (patch.blockedPrerequisites ?? [])
        : parseBlockedPrerequisites(existing.blocked_prerequisites)
      const updatedAt = new Date().toISOString()
      const nextStageEnteredAt = 'status' in patch && patch.status && patch.status !== existing.status
        ? updatedAt
        : (existing.stage_entered_at ?? existing.updated_at ?? existing.created_at)

      if (nextProofIntentNonce && !getIntentLogByNonce(db, nextProofIntentNonce)) {
        return c.json({ error: 'Linked proof intent was not found', errorCode: 'PROOF_INTENT_NOT_FOUND' }, 404)
      }

      if (!('lastContactAt' in patch) && ['contacted', 'scheduled', 'active'].includes(nextStatus) && !nextLastContactAt) {
        nextLastContactAt = updatedAt
      }

      db.prepare(`
        UPDATE waitlist
        SET status = ?, owner = ?, operator_notes = ?, next_action = ?, last_contact_at = ?, next_meeting_at = ?, reminder_at = ?, proof_intent_nonce = ?, blocked_prerequisites = ?, stage_entered_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nextStatus, nextOwner, nextOperatorNotes, nextAction, nextLastContactAt, nextMeetingAt, nextReminderAt, nextProofIntentNonce, serializeBlockedPrerequisites(nextBlockedPrerequisites), nextStageEnteredAt, updatedAt, id)

      const updated = getBetaRequestById(db, id)
      if (!updated) {
        return c.json({ error: 'Beta request not found after update', errorCode: 'NOT_FOUND' }, 404)
      }

      ensureBetaRequestNotification(db, updated)
      syncBetaRequestNotificationStatus(db, updated, auth.session.email)
      const notification = getOperatorNotificationBySourceKey(db, betaRequestNotificationSourceKey(updated.id))

      logAuditEvent(db, {
        action: 'admin.beta_request.updated',
        actor: auth.session.email,
        target: String(id),
        details: {
          role: auth.session.role,
          status: nextStatus,
          owner: nextOwner,
          operatorNotesChanged: 'operatorNotes' in patch,
          nextActionChanged: 'nextAction' in patch,
          lastContactChanged: 'lastContactAt' in patch,
          nextMeetingChanged: 'nextMeetingAt' in patch,
          reminderChanged: 'reminderAt' in patch,
          proofIntentChanged: 'proofIntentNonce' in patch,
          blockedPrerequisitesChanged: 'blockedPrerequisites' in patch,
          blockedPrerequisiteCount: nextBlockedPrerequisites.length,
          blockedPrerequisites: nextBlockedPrerequisites,
          proofIntentNonce: nextProofIntentNonce,
        },
      })

      c.header('Cache-Control', 'no-store')
      return c.json({
        ok: true,
        request: serializeBetaRequest(updated, notification),
      })
    } catch (err) {
      console.error('Admin beta request update error:', err)
      return c.json({ error: 'Failed to update beta request', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/beta-requests/:id/proof-pack', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const id = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid beta request id', errorCode: 'INVALID_BETA_REQUEST_ID' }, 400)
    }

    const format = (c.req.query('format') ?? 'json').trim().toLowerCase()
    if (format !== 'json' && format !== 'markdown') {
      return c.json({ error: 'format must be json or markdown', errorCode: 'INVALID_EXPORT_FORMAT' }, 400)
    }

    try {
      const row = getBetaRequestById(db, id)
      if (!row) {
        return c.json({ error: 'Beta request not found', errorCode: 'NOT_FOUND' }, 404)
      }

      const notification = getOperatorNotificationBySourceKey(db, betaRequestNotificationSourceKey(row.id))
      const activity = buildBetaRequestActivityTimeline(db, row, notification)
      const proofSummary = buildBetaRequestProofSummary(db, row, notification, activity)
      if (!proofSummary) {
        return c.json({ error: 'No proof summary is available for this request yet', errorCode: 'PROOF_PACK_UNAVAILABLE' }, 409)
      }

      const pack = buildBetaRequestProofPack(row, proofSummary)
      const timestamp = new Date().toISOString().replaceAll(':', '-')

      logAuditEvent(db, {
        action: 'admin.beta_request.proof_pack.exported',
        actor: auth.session.email,
        target: String(id),
        details: {
          role: auth.session.role,
          format,
          proofIntentNonce: proofSummary.proofIntentNonce,
        },
      })

      c.header('Cache-Control', 'no-store')
      if (format === 'markdown') {
        c.header('Content-Type', 'text/markdown; charset=utf-8')
        c.header('Content-Disposition', `attachment; filename="beam-proof-pack-${id}-${timestamp}.md"`)
        return c.body(pack.markdown)
      }

      c.header('Content-Type', 'application/json; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="beam-proof-pack-${id}-${timestamp}.json"`)
      return c.body(JSON.stringify(pack, null, 2))
    } catch (err) {
      console.error('Admin beta request proof pack error:', err)
      return c.json({ error: 'Failed to build proof pack', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/partner-health', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const days = Math.max(1, Number.parseInt(c.req.query('days') ?? String(PARTNER_HEALTH_DEFAULT_DAYS), 10) || PARTNER_HEALTH_DEFAULT_DAYS)
    const hours = Math.max(1, Number.parseInt(c.req.query('hours') ?? '24', 10) || 24)

    try {
      c.header('Cache-Control', 'no-store')
      return c.json(buildPartnerHealthPayload(db, { days, hours }))
    } catch (err) {
      console.error('Admin partner health error:', err)
      return c.json({ error: 'Failed to build partner health payload', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/partner-digest', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const days = Math.max(1, Number.parseInt(c.req.query('days') ?? String(PARTNER_DIGEST_DEFAULT_DAYS), 10) || PARTNER_DIGEST_DEFAULT_DAYS)
    const owner = normalizeOptionalString(c.req.query('owner'))
    const format = (c.req.query('format') ?? 'json').trim().toLowerCase()
    if (format !== 'json' && format !== 'markdown') {
      return c.json({ error: 'format must be json or markdown', errorCode: 'INVALID_EXPORT_FORMAT' }, 400)
    }

    try {
      const digest = buildPartnerDigestPayload(db, days, owner)
      c.header('Cache-Control', 'no-store')

      if (format === 'markdown') {
        const timestamp = new Date().toISOString().replaceAll(':', '-')
        c.header('Content-Type', 'text/markdown; charset=utf-8')
        c.header('Content-Disposition', `attachment; filename="beam-partner-digest-${timestamp}.md"`)
        return c.body(digest.markdown)
      }

      return c.json(digest)
    } catch (err) {
      console.error('Admin partner digest error:', err)
      return c.json({ error: 'Failed to build partner digest', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.post('/admin/partner-digest/deliver', async (c) => {
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

    const days = Math.max(1, Number.parseInt(String(body.days ?? PARTNER_DIGEST_DEFAULT_DAYS), 10) || PARTNER_DIGEST_DEFAULT_DAYS)
    const requestedEmail = normalizeOptionalString(body.email)
    const owner = normalizeOptionalString(body.owner)
    const targetEmail = requestedEmail ?? auth.session.email

    if (requestedEmail && auth.session.role !== 'admin' && requestedEmail !== auth.session.email) {
      return c.json({ error: 'Only admins can deliver digests to a different mailbox', errorCode: 'FORBIDDEN' }, 403)
    }

    try {
      const digest = buildPartnerDigestPayload(db, days, owner)
      const delivered = await sendOperatorDigestEmail({
        email: targetEmail,
        subject: `Beam partner digest · ${new Date().toISOString().slice(0, 10)}`,
        markdown: digest.markdown,
      })

      if (!delivered) {
        return c.json({ error: 'Operator email delivery is not configured', errorCode: 'EMAIL_DELIVERY_UNAVAILABLE' }, 503)
      }

      logAuditEvent(db, {
        action: 'admin.partner_digest.delivered',
        actor: auth.session.email,
        target: targetEmail,
        details: {
          role: auth.session.role,
          days,
          owner,
          deliveredTo: targetEmail,
        },
      })

      c.header('Cache-Control', 'no-store')
      return c.json({
        ok: true,
        email: targetEmail,
        deliveredAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error('Admin partner digest delivery error:', err)
      return c.json({ error: 'Failed to deliver partner digest', errorCode: 'EMAIL_DELIVERY_FAILED' }, 500)
    }
  })

  app.get('/admin/operator-notifications', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const filters: OperatorNotificationFilters = {
        q: c.req.query('q') ?? undefined,
        status: normalizeOperatorNotificationStatus(c.req.query('status')) ?? undefined,
        source: normalizeOperatorNotificationSource(c.req.query('source')) ?? undefined,
        limit: c.req.query('limit') ? Number.parseInt(c.req.query('limit') as string, 10) : undefined,
        hours: c.req.query('hours') ? Number.parseInt(c.req.query('hours') as string, 10) : undefined,
      }

      buildAlertsWithNotificationState(db, Number.isFinite(filters.hours) ? Math.max(1, filters.hours as number) : 24)
      const rows = listOperatorNotifications(db, {
        q: filters.q,
        status: filters.status,
        sourceType: filters.source,
        limit: Math.min(Math.max(Number(filters.limit ?? 200) || 200, 1), 5000),
      })

      c.header('Cache-Control', 'no-store')
      return c.json({
        notifications: rows.map((row) => serializeOperatorNotification(row)),
        total: rows.length,
        summary: summarizeOperatorNotifications(rows),
      })
    } catch (err) {
      console.error('Operator notifications error:', err)
      return c.json({ error: 'Failed to load operator notifications', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.patch('/admin/operator-notifications/:id', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const id = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid operator notification id', errorCode: 'INVALID_NOTIFICATION_ID' }, 400)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const status = 'status' in raw ? (normalizeOperatorNotificationStatus(raw.status) ?? undefined) : undefined
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid operator notification status', errorCode: 'INVALID_NOTIFICATION_STATUS' }, 400)
    }
    const owner = 'owner' in raw ? normalizeOptionalString(raw.owner) : undefined
    const nextAction = 'nextAction' in raw ? normalizeOptionalString(raw.nextAction) : undefined

    if (!('status' in raw) && !('owner' in raw) && !('nextAction' in raw)) {
      return c.json({ error: 'No supported fields to update', errorCode: 'EMPTY_PATCH' }, 400)
    }

    const updated = updateOperatorNotificationStatus(db, {
      id,
      status,
      actor: auth.session.email,
      owner,
      nextAction,
    })
    if (!updated) {
      return c.json({ error: 'Operator notification not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.operator_notification.updated',
      actor: auth.session.email,
      target: String(id),
      details: {
        status,
        owner,
        nextAction,
        role: auth.session.role,
        sourceType: updated.source_type,
        sourceKey: updated.source_key,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      notification: serializeOperatorNotification(updated),
    })
  })

  app.get('/admin/funnel', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const days = Math.max(1, Math.min(180, Number.parseInt(c.req.query('days') ?? '30', 10) || 30))

    try {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
      const rows = listFunnelEvents(db, {
        since,
        limit: 10000,
      })
      const summary = summarizeFunnel(rows)
      const partnerRows = listPartnerAnalyticsRows(db, since)

      c.header('Cache-Control', 'no-store')
      return c.json({
        days,
        generatedAt: new Date().toISOString(),
        ...summary,
        partnerMotion: summarizePartnerMotion(partnerRows),
      })
    } catch (err) {
      console.error('Funnel summary error:', err)
      return c.json({ error: 'Failed to load funnel analytics', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/waitlist', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const waitlist = getWaitlistEntries(db)
      c.header('Cache-Control', 'no-store')
      return c.json(waitlist)
    } catch (err) {
      console.error('Admin waitlist error:', err)
      return c.json({ error: 'Failed to load waitlist', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/trust', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const rows = listTrustScores(db)
      c.header('Cache-Control', 'no-store')
      return c.json({
        trustScores: rows.map((row) => ({
          from: row.source_beam_id,
          to: row.target_beam_id,
          score: row.score,
          lastUpdated: row.last_updated,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Admin trust error:', err)
      return c.json({ error: 'Failed to load trust scores', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/admin/audit', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const limit = Number.parseInt(c.req.query('limit') ?? '100', 10)

    try {
      const rows = listAuditLog(db, {
        limit,
        action: c.req.query('action') ?? undefined,
        actor: c.req.query('actor') ?? undefined,
        target: c.req.query('target') ?? undefined,
      })
      c.header('Cache-Control', 'no-store')
      return c.json({
        entries: rows.map((row) => ({
          id: row.id,
          action: row.action,
          actor: row.actor,
          target: row.target,
          timestamp: row.timestamp,
          details: row.details ? JSON.parse(row.details) as unknown : null,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Admin audit error:', err)
      return c.json({ error: 'Failed to load audit log', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.route('/admin/workspaces', workspacesRouter(db))
  app.route('/admin/openclaw', openClawAdminRouter(db))
  app.route('/openclaw/hosts', openClawPublicRouter(db))

  // List all agents with connection status (before sub-router to avoid conflict)
  app.get('/directory/agents', (c) => {
    const adminSession = getAdminSessionFromRequest(db, c.req.raw)
    if (isPrivateDirectoryMode() && !hasFederationAuth(c) && !adminSession) {
      return c.json({ error: 'Directory is private', errorCode: 'PRIVATE_DIRECTORY' }, 403)
    }

    try {
      const includeUnlisted = c.req.query('includeUnlisted') === 'true' && Boolean(adminSession)
      const rows = includeUnlisted
        ? db.prepare('SELECT * FROM agents ORDER BY trust_score DESC, beam_id ASC').all() as AgentRow[]
        : db.prepare("SELECT * FROM agents WHERE visibility = 'public' ORDER BY trust_score DESC, beam_id ASC").all() as AgentRow[]
      const totalCount = (db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as { cnt: number }).cnt
      const connected = new Set(getConnectedBeamIds())
      return c.json({
        agents: rows.map((row) => serializeAgent(row, connected)),
        total: totalCount,
        listed: rows.length,
      })
    } catch (err) {
      console.error('List agents error:', err)
      return c.json({ error: 'Failed to list agents', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.route('/orgs', orgsRouter(db))
  app.route('/agents', agentsRouter(db))
  app.route('/agents', verificationRouter(db))
  app.route('/agents', businessVerificationRouter(db))
  app.route('/agents', agentKeysRouter(db))
  app.route('/agents', delegationsRouter(db))
  app.route('/agents', reportsRouter(db))
  app.route('/agents', credentialsRouter())
  app.route('/agents', didRouter(db))

  // Top-level DID resolution for W3C compliance: /did/did:beam:*
  app.get('/did/:didString{.+}', async (c) => {
    const didString = c.req.param('didString')

    // First check stored DID documents
    const stored = getDIDDocument(db, didString)
    if (stored) return c.json(stored)

    // On-demand generation: convert DID → beam_id → lookup agent → generate
    const { generateDIDDocumentWithKeys, didToBeamId } = await import('./did.js')
    const beamId = didToBeamId(didString)
    if (beamId) {
      const agent = getAgent(db, beamId)
      if (agent) {
        const newDoc = generateDIDDocumentWithKeys(agent, listAgentKeys(db, beamId))
        upsertDIDDocument(db, newDoc)
        return c.json(newDoc)
      }
    }

    return c.json({ error: 'Not found', errorCode: 'NOT_FOUND' }, 404)
  })
  app.route('/federation', federationRouter(db))
  app.route('/billing', billingRouter(db))
  app.route('/shield', shieldRouter(db))
  app.route('/observability', observabilityRouter(db))
  app.route('/keys', revokedKeysRouter(db))

  app.get('/admin/roles', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const rows = listDirectoryRoles(db, getLocalDirectoryUrl())
    return c.json({
      roles: rows.map((row) => ({
        email: row.user_id,
        role: row.role,
      })),
      total: rows.length,
    })
  })

  app.post('/admin/roles', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const body = await c.req.json().catch(() => ({})) as { email?: string; role?: 'admin' | 'operator' | 'viewer' }
    const email = String(body.email ?? '').trim().toLowerCase()
    const role = body.role
    if (!email || !email.includes('@') || (role !== 'admin' && role !== 'operator' && role !== 'viewer')) {
      return c.json({ error: 'email and role are required', errorCode: 'INVALID_ROLE_ASSIGNMENT' }, 400)
    }

    const assigned = assignDirectoryRole(db, {
      userId: email,
      role,
      directoryUrl: getLocalDirectoryUrl(),
    })

    logAuditEvent(db, {
      action: 'admin.role.assigned',
      actor: auth.session.email,
      target: email,
      details: {
        role: assigned.role,
        directoryUrl: assigned.directory_url,
      },
    })

    return c.json({
      email: assigned.user_id,
      role: assigned.role,
      directoryUrl: assigned.directory_url,
    }, 201)
  })

  app.delete('/admin/roles/:email', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const email = decodeURIComponent(c.req.param('email') ?? '').trim().toLowerCase()
    if (!email || !email.includes('@')) {
      return c.json({ error: 'Valid email required', errorCode: 'INVALID_EMAIL' }, 400)
    }

    const deleted = deleteDirectoryRole(db, {
      userId: email,
      directoryUrl: getLocalDirectoryUrl(),
    })

    if (!deleted) {
      return c.json({ error: 'Role assignment not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.role.revoked',
      actor: auth.session.email,
      target: email,
      details: {
        directoryUrl: getLocalDirectoryUrl(),
      },
    })

    return new Response(null, { status: 204 })
  })

  app.post('/acl', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const targetBeamId = String(raw.targetBeamId ?? '')
    const intentType = String(raw.intentType ?? '')
    const allowedFrom = String(raw.allowedFrom ?? '')

    if (!targetBeamId || !intentType || !allowedFrom) {
      return c.json({ error: 'targetBeamId, intentType and allowedFrom are required', errorCode: 'INVALID_ACL' }, 400)
    }

    try {
      const acl = createAcl(db, { targetBeamId, intentType, allowedFrom })
      return c.json(acl, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create ACL entry'
      return c.json({ error: message, errorCode: 'ACL_ERROR' }, 400)
    }
  })

  app.get('/acl/:beamId', (c) => {
    const beamId = decodeURIComponent(c.req.param('beamId'))
    try {
      const rows = listAclsForBeam(db, beamId)
      return c.json({ acl: rows, total: rows.length })
    } catch (err) {
      console.error('List ACL error:', err)
      return c.json({ error: 'Failed to list ACL entries', errorCode: 'ACL_ERROR' }, 500)
    }
  })

  app.delete('/acl/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid ACL id', errorCode: 'INVALID_ACL_ID' }, 400)
    }

    try {
      const removed = deleteAcl(db, id)
      if (!removed) {
        return c.json({ error: `ACL id ${id} not found`, errorCode: 'NOT_FOUND' }, 404)
      }
      return c.json({ ok: true, id })
    } catch (err) {
      console.error('Delete ACL error:', err)
      return c.json({ error: 'Failed to delete ACL entry', errorCode: 'ACL_ERROR' }, 500)
    }
  })

  app.post('/waitlist', async (c) => {

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const email = String(raw.email ?? '').trim().toLowerCase()
    const source = typeof raw.source === 'string' && raw.source.trim().length > 0
      ? raw.source.trim()
      : null
    const company = typeof raw.company === 'string' && raw.company.trim().length > 0
      ? raw.company.trim()
      : null

    let agentCount: number | null = null
    if (raw.agentCount !== undefined && raw.agentCount !== null && raw.agentCount !== '') {
      const parsedAgentCount = Number(raw.agentCount)
      if (!Number.isInteger(parsedAgentCount) || parsedAgentCount < 0) {
        return c.json({ error: 'agentCount must be a non-negative integer', errorCode: 'INVALID_AGENT_COUNT' }, 400)
      }
      agentCount = parsedAgentCount
    }

    if (!email || !email.includes('@')) {
      return c.json({ error: 'A valid email is required', errorCode: 'INVALID_EMAIL' }, 400)
    }

    const workflowType = normalizeOptionalString(raw.workflowType)
      ?? (
        typeof raw.source === 'string' && raw.source.trim().startsWith('hosted-beta-')
          ? raw.source.trim()
          : null
      )
    const workflowSummary = normalizeOptionalString(raw.workflowSummary) ?? normalizeOptionalString(raw.notes)
    const analyticsSessionId = normalizeSessionId(raw.analyticsSessionId ?? raw.sessionId)
    const analyticsPageKey = normalizeFunnelPageKey(raw.pageKey) ?? 'hosted_beta'

    const signup: WaitlistSignupInput = {
      email,
      source,
      company,
      agentCount,
      workflowType,
      workflowSummary,
    }

    const timestamp = new Date().toISOString()

    try {
      const existing = db.prepare(`
        SELECT id, email, source, company, agent_count, workflow_type, workflow_summary, status, owner, operator_notes, next_action, last_contact_at, next_meeting_at, reminder_at, blocked_prerequisites, stage_entered_at, created_at, updated_at
        FROM waitlist
        WHERE email = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(signup.email) as WaitlistRow | undefined

      if (existing) {
        const nextSource = signup.source ?? existing.source
        const nextCompany = signup.company ?? existing.company
        const nextAgentCount = signup.agentCount ?? existing.agent_count
        const nextWorkflowType = signup.workflowType ?? existing.workflow_type
        const nextWorkflowSummary = signup.workflowSummary ?? existing.workflow_summary
        const nextStatus = (normalizeBetaRequestStatus(existing.status) ?? 'new') === 'closed'
          ? 'new'
          : (normalizeBetaRequestStatus(existing.status) ?? 'new')
        const resetNotification = nextStatus === 'new' && (normalizeBetaRequestStatus(existing.status) ?? 'new') === 'closed'

        db.prepare(`
          UPDATE waitlist
          SET source = ?, company = ?, agent_count = ?, workflow_type = ?, workflow_summary = ?, status = ?, stage_entered_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          nextSource,
          nextCompany,
          nextAgentCount,
          nextWorkflowType,
          nextWorkflowSummary,
          nextStatus,
          nextStatus !== existing.status ? timestamp : (existing.stage_entered_at ?? existing.updated_at ?? existing.created_at),
          timestamp,
          existing.id,
        )

        const updated = getBetaRequestById(db, existing.id)
        if (!updated) {
          return c.json({ error: 'Failed to load updated beta request', errorCode: 'DB_ERROR' }, 500)
        }

        if (resetNotification) {
          ensureBetaRequestNotification(db, updated, true)
        }
        const notification = getOperatorNotificationBySourceKey(db, betaRequestNotificationSourceKey(updated.id))
        if (analyticsSessionId && workflowType) {
          insertFunnelEvent(db, {
            sessionId: analyticsSessionId,
            origin: resolveCorsOrigin(c.req.header('origin')) ?? 'https://beam.directory',
            pageKey: analyticsPageKey,
            eventCategory: 'request',
            workflowType,
            milestoneKey: 'hosted_beta_request_submitted',
          })
        }

        return c.json({
          ok: true,
          status: 'already_registered',
          id: updated.id,
          email: updated.email,
          source: updated.source,
          company: updated.company,
          agentCount: updated.agent_count,
          workflowType: updated.workflow_type,
          workflowSummary: updated.workflow_summary,
          requestStatus: normalizeBetaRequestStatus(updated.status) ?? 'new',
          owner: updated.owner,
          operatorNotes: updated.operator_notes,
          nextAction: updated.next_action ?? getBetaRequestNextStep(updated.status),
          lastContactAt: updated.last_contact_at,
          nextMeetingAt: updated.next_meeting_at,
          reminderAt: updated.reminder_at,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
          request: serializeBetaRequest(updated, notification),
          nextStep: updated.next_action ?? getBetaRequestNextStep(updated.status),
        }, 200)
      }

      const result = db.prepare(`
        INSERT INTO waitlist (
          email,
          source,
          company,
          agent_count,
          workflow_type,
          workflow_summary,
          status,
          owner,
          operator_notes,
          next_action,
          last_contact_at,
          next_meeting_at,
          reminder_at,
          stage_entered_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'new', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
      `).run(
        signup.email,
        signup.source,
        signup.company,
        signup.agentCount,
        signup.workflowType,
        signup.workflowSummary,
        timestamp,
        timestamp,
        timestamp,
      )

      console.log(
        `[waitlist] new signup email=${signup.email} source=${signup.source ?? '-'} company=${signup.company ?? '-'} agentCount=${signup.agentCount ?? '-'} workflowType=${signup.workflowType ?? '-'} createdAt=${timestamp}`
      )

      logAuditEvent(db, {
        action: 'beta_request.created',
        actor: signup.email,
        target: signup.company ?? signup.email,
        details: {
          source: signup.source,
          workflowType: signup.workflowType,
          agentCount: signup.agentCount,
        },
      })

      const created = getBetaRequestById(db, Number(result.lastInsertRowid))
      if (!created) {
        return c.json({ error: 'Failed to load saved beta request', errorCode: 'DB_ERROR' }, 500)
      }
      const notification = ensureBetaRequestNotification(db, created, true)
      if (analyticsSessionId && workflowType) {
        insertFunnelEvent(db, {
          sessionId: analyticsSessionId,
          origin: resolveCorsOrigin(c.req.header('origin')) ?? 'https://beam.directory',
          pageKey: analyticsPageKey,
          eventCategory: 'request',
          workflowType,
          milestoneKey: 'hosted_beta_request_submitted',
        })
      }

      return c.json({
        ok: true,
        status: 'registered',
        id: created.id,
        email: created.email,
        source: created.source,
        company: created.company,
        agentCount: created.agent_count,
        workflowType: created.workflow_type,
        workflowSummary: created.workflow_summary,
        requestStatus: normalizeBetaRequestStatus(created.status) ?? 'new',
        owner: created.owner,
        operatorNotes: created.operator_notes,
        nextAction: created.next_action ?? getBetaRequestNextStep(created.status),
        lastContactAt: created.last_contact_at,
        nextMeetingAt: created.next_meeting_at,
        reminderAt: created.reminder_at,
        createdAt: created.created_at,
        updatedAt: created.updated_at,
        request: serializeBetaRequest(created, notification),
        nextStep: created.next_action ?? getBetaRequestNextStep(created.status),
      }, 201)
    } catch (err) {
      console.error('Waitlist signup error:', err)
      return c.json({ error: 'Failed to save waitlist signup', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/waitlist', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    try {
      const { rows, total, allRows } = listBetaRequestRows(db, { limit: 5000 })
      const notifications = getBetaRequestNotifications(db, rows)

      return c.json({
        waitlist: rows.map((row) => serializeBetaRequest(row, notifications.get(betaRequestNotificationSourceKey(row.id)))),
        signups: rows.map((row) => serializeBetaRequest(row, notifications.get(betaRequestNotificationSourceKey(row.id)))),
        requests: rows.map((row) => serializeBetaRequest(row, notifications.get(betaRequestNotificationSourceKey(row.id)))),
        total,
        summary: summarizeBetaRequests(allRows, total),
      })
    } catch (err) {
      console.error('List waitlist error:', err)
      return c.json({ error: 'Failed to list waitlist signups', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.post('/analytics/events', async (c) => {
    const requestOrigin = c.req.header('origin') ?? null
    const origin = resolveCorsOrigin(requestOrigin)
    if (!origin) {
      return c.json({ error: 'Origin not allowed', errorCode: 'FORBIDDEN_ORIGIN' }, 403)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const sessionId = normalizeSessionId(raw.sessionId)
    if (!sessionId) {
      return c.json({ error: 'Invalid sessionId', errorCode: 'INVALID_SESSION_ID' }, 400)
    }

    const pageKey = normalizeFunnelPageKey(raw.pageKey)
    if (!pageKey) {
      return c.json({ error: 'Invalid pageKey', errorCode: 'INVALID_PAGE_KEY' }, 400)
    }

    const eventCategory = normalizeFunnelEventCategory(raw.eventCategory)
    if (!eventCategory) {
      return c.json({ error: 'Invalid eventCategory', errorCode: 'INVALID_EVENT_CATEGORY' }, 400)
    }

    const ctaKey = 'ctaKey' in raw ? normalizeFunnelKey(raw.ctaKey) : null
    const targetPage = 'targetPage' in raw ? normalizeFunnelPageKey(raw.targetPage) : null
    const workflowType = 'workflowType' in raw ? normalizeWorkflowType(raw.workflowType) : null
    const milestoneKey = 'milestoneKey' in raw ? normalizeMilestoneKey(raw.milestoneKey) : null

    if (eventCategory === 'cta_click' && !ctaKey) {
      return c.json({ error: 'ctaKey is required for cta_click events', errorCode: 'INVALID_CTA_KEY' }, 400)
    }

    if (eventCategory === 'request' && !workflowType) {
      return c.json({ error: 'workflowType is required for request events', errorCode: 'INVALID_WORKFLOW_TYPE' }, 400)
    }

    if (eventCategory === 'demo_milestone' && !milestoneKey) {
      return c.json({ error: 'milestoneKey is required for demo_milestone events', errorCode: 'INVALID_MILESTONE_KEY' }, 400)
    }

    try {
      const event = insertFunnelEvent(db, {
        sessionId,
        origin,
        pageKey,
        eventCategory,
        ctaKey,
        targetPage,
        workflowType,
        milestoneKey,
      })

      c.header('Cache-Control', 'no-store')
      return c.json({
        ok: true,
        event: serializeFunnelEvent(event),
      }, 202)
    } catch (err) {
      console.error('Analytics ingest error:', err)
      return c.json({ error: 'Failed to record analytics event', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.post('/intents/send', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body', errorCode: 'INVALID_JSON' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const payloadCandidate = (
      raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
    )
      ? raw.payload
      : (
        raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
      )
        ? raw.params
        : undefined

    const frame: IntentFrame = {
      v: '1',
      from: String(raw.from ?? ''),
      to: String(raw.to ?? ''),
      intent: String(raw.intent ?? ''),
      payload: payloadCandidate ? payloadCandidate as Record<string, unknown> : {},
      signature: typeof raw.signature === 'string' ? raw.signature : undefined,
      nonce: typeof raw.nonce === 'string' && raw.nonce.length > 0 ? raw.nonce : randomUUID(),
      timestamp: typeof raw.timestamp === 'string' && raw.timestamp.length > 0 ? raw.timestamp : new Date().toISOString(),
    }

    try {
      // Meter relayed intent
      const period = new Date().toISOString().slice(0, 7)
      db.prepare(
        `INSERT INTO usage_metering (beam_id, period, intent_count, relayed_count)
         VALUES (?, ?, 1, 1)
         ON CONFLICT(beam_id, period) DO UPDATE SET intent_count = intent_count + 1, relayed_count = relayed_count + 1`
      ).run(frame.from, period)

      const result = await relayIntentFromHttp(db, frame, 60_000)
      return c.json(result)
    } catch (err) {
      if (err instanceof RelayError) {
        if (err.code === 'OFFLINE') {
          return c.json({ error: 'agent_offline', errorCode: 'OFFLINE' }, 503)
        }
        if (err.code === 'TIMEOUT') {
          return c.json({ error: err.message, errorCode: 'TIMEOUT' }, 504)
        }
        if (err.code === 'BAD_REQUEST') {
          return c.json({ error: err.message, errorCode: 'INVALID_INTENT' }, 400)
        }
        if (err.code === 'FORBIDDEN') {
          return c.json({ error: err.message, errorCode: 'FORBIDDEN' }, 403)
        }
        if (err.code === 'RATE_LIMITED') {
          return c.json({ error: err.message, errorCode: 'RATE_LIMITED' }, 429)
        }
        if (err.code === 'IN_PROGRESS') {
          return c.json({ error: err.message, errorCode: 'IN_PROGRESS' }, 409)
        }
      }

      console.error('Relay intent HTTP error:', err)
      return c.json({ error: 'Failed to relay intent', errorCode: 'RELAY_ERROR' }, 500)
    }
  })

  app.get('/intents/catalog', (c) => {
    try {
      return c.json(loadIntentCatalog())
    } catch (err) {
      console.error('Catalog load error:', err)
      return c.json({ error: 'Catalog unavailable', errorCode: 'CATALOG_UNAVAILABLE' }, 500)
    }
  })

  app.get('/intents/recent', (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)

    try {
      const rows = listRecentIntentLogs(db, limit)
      c.header('Cache-Control', 'no-store')
      return c.json({
        intents: rows.map((row) => ({
          nonce: row.nonce,
          from: row.from_beam_id,
          to: row.to_beam_id,
          intentType: row.intent_type,
          timestamp: row.requested_at,
          completedAt: row.completed_at,
          roundTripLatencyMs: row.round_trip_latency_ms,
          status: row.status,
          errorCode: row.error_code,
        })),
        total: rows.length,
      })
    } catch (err) {
      console.error('Recent intents error:', err)
      return c.json({ error: 'Failed to load recent intents', errorCode: 'DB_ERROR' }, 500)
    }
  })

  app.get('/health', (c) => {
    const timestamp = new Date().toISOString()

    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined

      return c.json({
        status: 'ok',
        protocol: 'beam/1',
        connectedAgents: getConnectedCount(),
        timestamp,
        uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
        version: releaseInfo.version,
        gitSha: releaseInfo.gitSha,
        deployedAt: releaseInfo.deployedAt,
        release: releaseInfo,
        db: {
          status: row?.ok === 1 ? 'ok' : 'error',
        },
      })
    } catch (error) {
      return c.json({
        status: 'error',
        protocol: 'beam/1',
        connectedAgents: getConnectedCount(),
        timestamp,
        uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
        version: releaseInfo.version,
        gitSha: releaseInfo.gitSha,
        deployedAt: releaseInfo.deployedAt,
        release: releaseInfo,
        db: {
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown database error',
        },
      }, 503)
    }
  })

  app.get('/release', (c) => {
    return c.json({
      protocol: 'beam/1',
      release: releaseInfo,
      reportedAt: new Date().toISOString(),
    })
  })

  app.get('/stats', (c) => {
    let agents = 0
    let intentsProcessed = 0
    let waitlistSize = 0

    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM agents').get() as { count: number } | undefined
      agents = row?.count ?? 0
    } catch {
      agents = 0
    }

    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM intent_log').get() as { count: number } | undefined
      intentsProcessed = row?.count ?? 0
    } catch {
      intentsProcessed = 0
    }

    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM waitlist').get() as { count: number } | undefined
      waitlistSize = row?.count ?? 0
    } catch {
      waitlistSize = 0
    }

    return c.json({
      agents,
      intentsProcessed,
      uptime: Math.floor(process.uptime()),
      waitlistSize,
      version: releaseInfo.version,
      gitSha: releaseInfo.gitSha,
      deployedAt: releaseInfo.deployedAt,
      release: releaseInfo,
    })
  })

  app.notFound((c) => c.json({ error: 'Not found', errorCode: 'NOT_FOUND' }, 404))

  app.onError((err, c) => {
    console.error('Unhandled server error:', err)
    return c.json({ error: 'Internal server error', errorCode: 'INTERNAL_ERROR' }, 500)
  })

  return app
}

export function startServer(db: Database, port = 3100): HttpServer {
  const recovery = recoverInterruptedIntentsOnStartup(db)
  const app = createApp(db)
  const wss = createWebSocketServer(db)
  const recoverySweep = startRecoveredIntentTimeoutSweep(db)

  const server = serve(
    { fetch: app.fetch, port },
    (info) => {
      console.log(`Beam Directory Server running on http://localhost:${info.port}`)
      console.log(`WebSocket endpoint: ws://localhost:${info.port}/ws`)
      if (recovery.failedInterrupted > 0 || recovery.resumedAwaitingResult > 0 || recovery.timedOutAwaitingResult > 0) {
        console.log(
          `[beam-directory] Recovery summary: failed=${recovery.failedInterrupted}, ` +
          `resumed=${recovery.resumedAwaitingResult}, timed_out=${recovery.timedOutAwaitingResult}`,
        )
      }
    }
  ) as unknown as HttpServer

  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/ws')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  server.on('close', () => {
    stopRecoveredIntentTimeoutSweep(recoverySweep)
  })

  return server
}
