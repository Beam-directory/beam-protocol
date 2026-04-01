import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import { createAgentApiKey, hashApiKey } from '../api-key.js'
import {
  createWorkspace,
  createWorkspaceIdentityBinding,
  createWorkspacePartnerChannel,
  createWorkspaceThread,
  createWorkspaceThreadParticipant,
  getAgent,
  getIntentLogByNonce,
  getOrg,
  getWorkspaceById,
  getWorkspaceBySlug,
  getWorkspaceIdentityBindingByBeamId,
  getWorkspaceIdentityBindingById,
  getWorkspacePartnerChannelByBeamId,
  getWorkspacePartnerChannelById,
  getWorkspacePolicyDocument,
  getWorkspaceSummary,
  getWorkspaceThreadById,
  getWorkspaceThreadByLinkedIntentNonce,
  listAgentKeys,
  listOpenClawResolvedRoutesByBeamId,
  listWorkspaceIdentityBindings,
  listWorkspaceIdentityBindingsByBeamId,
  listWorkspacePartnerChannels,
  listWorkspaceThreadParticipants,
  listWorkspaceThreads,
  listWorkspaces,
  logAuditEvent,
  registerAgent,
  updateWorkspaceThread,
  updateWorkspacePartnerChannel,
  updateWorkspacePolicyDocument,
  updateWorkspaceIdentityBinding,
} from '../db.js'
import type {
  AuditLogRow,
  IntentFrame,
  IntentLogRow,
  WorkspaceIdentityBindingRow,
  WorkspaceIdentityBindingStatus,
  WorkspaceIdentityBindingType,
  WorkspaceIdentityLifecycleStatus,
  OpenClawHostHealth,
  OpenClawRouteRuntimeState,
  OpenClawRouteSource,
  WorkspacePartnerChannelHealth,
  WorkspacePartnerChannelRow,
  WorkspacePartnerChannelStatus,
  WorkspacePolicy,
  WorkspacePolicyRuleExternalInitiation,
  WorkspacePrincipalType,
  WorkspaceRow,
  WorkspaceTimelineEventKind,
  WorkspaceThreadKind,
  WorkspaceThreadParticipantRole,
  WorkspaceThreadScope,
  WorkspaceThreadStatus,
  WorkspaceThreadParticipantRow,
  WorkspaceThreadRow,
} from '../types.js'
import { serializeAgentKeyState } from '../utils/serialize.js'
import { evaluateWorkspacePolicy } from '../workspace-policy.js'
import { RelayError, isAgentConnected, relayIntentFromHttp } from '../websocket.js'
import { sendOperatorDigestEmail } from '../email.js'
import { validateIntentPayload } from '../validation.js'
import { toBeamDID } from '../did.js'

const WORKSPACE_STATUS_SET = new Set<WorkspaceRow['status']>(['active', 'paused', 'archived'])
const WORKSPACE_THREAD_SCOPE_SET = new Set<WorkspaceThreadScope>(['internal', 'handoff'])
const WORKSPACE_BINDING_TYPE_SET = new Set<WorkspaceIdentityBindingType>(['agent', 'service', 'partner'])
const WORKSPACE_BINDING_STATUS_SET = new Set<WorkspaceIdentityBindingStatus>(['active', 'paused'])
const WORKSPACE_THREAD_KIND_SET = new Set<WorkspaceThreadKind>(['internal', 'handoff'])
const WORKSPACE_THREAD_STATUS_SET = new Set<WorkspaceThreadStatus>(['open', 'blocked', 'closed'])
const WORKSPACE_THREAD_PARTICIPANT_ROLE_SET = new Set<WorkspaceThreadParticipantRole>(['owner', 'participant', 'observer', 'approver'])
const WORKSPACE_PRINCIPAL_TYPE_SET = new Set<WorkspacePrincipalType>(['human', 'agent', 'service', 'partner'])
const WORKSPACE_PARTNER_CHANNEL_STATUS_SET = new Set<WorkspacePartnerChannelStatus>(['active', 'trial', 'blocked'])
const WORKSPACE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const WORKSPACE_OVERVIEW_STALE_AFTER_HOURS = 24
const WORKSPACE_OVERVIEW_RECENT_HANDOFF_LIMIT = 8
const WORKSPACE_OVERVIEW_INTENT_SCAN_LIMIT = 96
const WORKSPACE_TIMELINE_LIMIT_DEFAULT = 100
const WORKSPACE_TIMELINE_LIMIT_MAX = 250
const WORKSPACE_DIGEST_DEFAULT_DAYS = 7

type SerializedWorkspace = {
  id: number
  slug: string
  name: string
  orgName: string | null
  description: string | null
  status: WorkspaceRow['status']
  defaultThreadScope: WorkspaceThreadScope
  externalHandoffsEnabled: boolean
  createdAt: string
  updatedAt: string
  summary: {
    identities: number
    externalInitiators: number
    members: number
    partnerChannels: number
  }
  policyConfigured: boolean
}

type SerializedWorkspaceIdentityBinding = {
  id: number
  workspaceId: number
  beamId: string
  bindingType: WorkspaceIdentityBindingType
  owner: string | null
  runtimeType: string | null
  policyProfile: string | null
  defaultThreadScope: WorkspaceThreadScope
  canInitiateExternal: boolean
  status: WorkspaceIdentityBindingStatus
  notes: string | null
  createdAt: string
  updatedAt: string
  lastSeenAgeHours: number | null
  ownershipState: 'owned' | 'unowned'
  lifecycleStatus: WorkspaceIdentityLifecycleStatus
  hostId: number | null
  hostLabel: string | null
  hostHealth: OpenClawHostHealth | 'conflict' | null
  routeSource: OpenClawRouteSource | null
  runtimeSessionState: OpenClawRouteRuntimeState | null
  runtime: {
    mode: 'runtime-backed' | 'service' | 'partner' | 'manual'
    connector: string | null
    label: string | null
    connected: boolean
    httpEndpoint: string | null
    deliveryMode: 'websocket' | 'http' | 'hybrid' | 'unavailable' | null
  }
  identity: {
    existsLocally: boolean
    beamId: string
    did: {
      id: string
      resolutionUrl: string
      agentUrl: string
      keysUrl: string
    }
    displayName: string | null
    org: string | null
    personal: boolean
    verificationTier: string | null
    trustScore: number | null
    lastSeen: string | null
    capabilities: string[]
    keyState: {
      active: object | null
      revoked: object[]
      keys: object[]
      total: number
    } | null
  }
  workspacePolicy: {
    effective: SerializedWorkspacePolicyPreview
    bindingRule: {
      externalInitiation: WorkspacePolicyRuleExternalInitiation
      allowedPartners: string[]
    } | null
  }
}

type SerializedWorkspaceIdentityCredential = {
  format: 'beam-local-identity/v1'
  beamId: string
  did: string
  displayName: string | null
  workspaceSlug: string
  directoryUrl: string
  generatedAt: string
  publicKey: string
  privateKey: string
  apiKey: string
  urls: {
    didResolution: string
    agent: string
    keys: string
  }
}

type SerializedWorkspacePartnerChannel = {
  id: number
  workspaceId: number
  partnerBeamId: string
  label: string | null
  owner: string | null
  status: WorkspacePartnerChannelStatus
  healthStatus: WorkspacePartnerChannelHealth
  notes: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastIntentNonce: string | null
  createdAt: string
  updatedAt: string
  stats: {
    recentSuccesses: number
    recentFailures: number
    totalObserved: number
  }
  partner: {
    existsLocally: boolean
    displayName: string | null
    org: string | null
    verificationTier: string | null
    trustScore: number | null
    lastSeen: string | null
  }
  workspaceRoute: {
    workspaceId: number
    workspaceSlug: string
    workspaceName: string
    bindingId: number
    bindingType: WorkspaceIdentityBindingType
    bindingStatus: WorkspaceIdentityBindingStatus
    displayName: string | null
    runtimeType: string | null
    runtime: SerializedWorkspaceIdentityBinding['runtime']
  } | null
  trace: {
    nonce: string
    status: IntentLogRow['status']
    intentType: string
    requestedAt: string
    completedAt: string | null
    errorCode: string | null
    href: string
  } | null
}

type SerializedWorkspaceThreadSync = {
  workspaceId: number
  workspaceSlug: string
  workspaceName: string
  threadId: number
  threadHref: string
  bindingId: number
  beamId: string
  disposition: 'created' | 'updated'
} | null

type WorkspaceTimelineEntry = {
  id: number
  kind: WorkspaceTimelineEventKind
  action: string
  actor: string
  target: string
  timestamp: string
  summary: string
  details: Record<string, unknown> | null
  href: string | null
  traceHref: string | null
}

type WorkspaceDigestActionItem = {
  id: string
  category: 'approval' | 'identity' | 'partner_channel' | 'thread'
  severity: 'warning' | 'critical'
  title: string
  detail: string
  owner: string | null
  href: string | null
  nextAction: string
}

type WorkspaceOverviewAttentionCode =
  | 'identity_missing'
  | 'stale_check_in'
  | 'binding_paused'
  | 'workspace_handoffs_disabled'
  | 'manual_review_required'

type WorkspaceOverviewAttentionItem = {
  binding: SerializedWorkspaceIdentityBinding
  reasonCode: WorkspaceOverviewAttentionCode
  reason: string
  lastSeenAgeHours: number | null
}

type WorkspaceOverviewHandoffDirection = 'outbound' | 'inbound'

type WorkspaceOverviewHandoff = {
  nonce: string
  intentType: string
  status: IntentLogRow['status']
  requestedAt: string
  completedAt: string | null
  latencyMs: number | null
  errorCode: string | null
  direction: WorkspaceOverviewHandoffDirection
  fromBeamId: string
  toBeamId: string
  workspaceSide: {
    beamId: string
    displayName: string | null
    bindingType: WorkspaceIdentityBindingType | null
  }
  counterparty: {
    beamId: string
    displayName: string | null
    bindingType: WorkspaceIdentityBindingType | null
    inWorkspace: boolean
  }
}

type SerializedWorkspaceThreadParticipant = {
  id: number
  threadId: number
  principalId: string
  principalType: WorkspacePrincipalType
  displayName: string | null
  beamId: string | null
  workspaceBindingId: number | null
  role: WorkspaceThreadParticipantRole
  createdAt: string
  updatedAt: string
  identity: {
    existsLocally: boolean
    displayName: string | null
    org: string | null
    verificationTier: string | null
    trustScore: number | null
    lastSeen: string | null
  } | null
}

type SerializedWorkspaceThread = {
  id: number
  workspaceId: number
  kind: WorkspaceThreadKind
  title: string
  summary: string | null
  owner: string | null
  status: WorkspaceThreadStatus
  workflowType: string | null
  draftIntentType: string | null
  draftPayload: Record<string, unknown> | null
  linkedIntentNonce: string | null
  lastActivityAt: string
  createdAt: string
  updatedAt: string
  participantCount: number
  trace: {
    nonce: string
    status: IntentLogRow['status']
    intentType: string
    fromBeamId: string
    toBeamId: string
    requestedAt: string
    completedAt: string | null
    latencyMs: number | null
    errorCode: string | null
    href: string
  } | null
}

type SerializedWorkspacePolicyPreview = {
  beamId: string
  bindingType: WorkspaceIdentityBindingType
  policyProfile: string | null
  externalInitiation: 'allow' | 'deny'
  allowedPartners: string[]
  approvalRequired: boolean
  approvers: string[]
  matchedBindingRules: number
  matchedWorkflowRules: number
  workflowType: string | null
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOptionalObject(value: unknown, fieldName: string): Record<string, unknown> | null {
  if (value == null) {
    return null
  }

  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`)
  }

  return value
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
}

function normalizeWorkspaceStatus(value: unknown): WorkspaceRow['status'] | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceRow['status']
  return WORKSPACE_STATUS_SET.has(normalized) ? normalized : null
}

function normalizeWorkspaceThreadScope(value: unknown): WorkspaceThreadScope | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceThreadScope
  return WORKSPACE_THREAD_SCOPE_SET.has(normalized) ? normalized : null
}

function normalizeBindingType(value: unknown): WorkspaceIdentityBindingType | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceIdentityBindingType
  return WORKSPACE_BINDING_TYPE_SET.has(normalized) ? normalized : null
}

function normalizeBindingStatus(value: unknown): WorkspaceIdentityBindingStatus | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceIdentityBindingStatus
  return WORKSPACE_BINDING_STATUS_SET.has(normalized) ? normalized : null
}

function normalizePartnerChannelStatus(value: unknown): WorkspacePartnerChannelStatus | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspacePartnerChannelStatus
  return WORKSPACE_PARTNER_CHANNEL_STATUS_SET.has(normalized) ? normalized : null
}

function normalizeThreadKind(value: unknown): WorkspaceThreadKind | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceThreadKind
  return WORKSPACE_THREAD_KIND_SET.has(normalized) ? normalized : null
}

function normalizeThreadStatus(value: unknown): WorkspaceThreadStatus | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceThreadStatus
  return WORKSPACE_THREAD_STATUS_SET.has(normalized) ? normalized : null
}

function normalizePrincipalType(value: unknown): WorkspacePrincipalType | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspacePrincipalType
  return WORKSPACE_PRINCIPAL_TYPE_SET.has(normalized) ? normalized : null
}

function normalizeThreadParticipantRole(value: unknown): WorkspaceThreadParticipantRole | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase() as WorkspaceThreadParticipantRole
  return WORKSPACE_THREAD_PARTICIPANT_ROLE_SET.has(normalized) ? normalized : null
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }

  return null
}

function normalizeExternalInitiationRule(value: unknown): WorkspacePolicyRuleExternalInitiation | null {
  if (value === 'inherit' || value === 'allow' || value === 'deny') {
    return value
  }

  return null
}

function normalizeStringList(value: unknown): string[] | null {
  if (value == null) {
    return []
  }

  if (Array.isArray(value)) {
    const normalized = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)

    return normalized.length === value.length ? [...new Set(normalized)] : null
  }

  if (typeof value === 'string') {
    return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))]
  }

  return null
}

function normalizeWorkspaceSlug(value: unknown, fallback: string): string | null {
  const candidate = typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : slugify(fallback)
  if (!candidate || !WORKSPACE_SLUG_RE.test(candidate)) {
    return null
  }

  return candidate
}

function getDirectoryBaseUrl(): string {
  return (process.env['BEAM_DIRECTORY_BASE_URL'] ?? 'https://beam.directory').replace(/\/$/, '')
}

function buildWorkspaceIdentityDid(beamId: string): SerializedWorkspaceIdentityBinding['identity']['did'] {
  const did = toBeamDID(beamId)
  const baseUrl = getDirectoryBaseUrl()
  return {
    id: did,
    resolutionUrl: `${baseUrl}/did/${encodeURIComponent(did)}`,
    agentUrl: `${baseUrl}/agents/${encodeURIComponent(beamId)}`,
    keysUrl: `${baseUrl}/agents/${encodeURIComponent(beamId)}/keys`,
  }
}

function hoursSince(value: string | null): number | null {
  if (!value) {
    return null
  }

  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return null
  }

  return Math.round(((Date.now() - timestamp) / 3_600_000) * 10) / 10
}

function isLocalWorkspaceBinding(row: WorkspaceIdentityBindingRow): boolean {
  return row.binding_type !== 'partner'
}

function classifyWorkspaceHandoffDirection(
  fromBinding: WorkspaceIdentityBindingRow | undefined,
  toBinding: WorkspaceIdentityBindingRow | undefined,
): WorkspaceOverviewHandoffDirection | null {
  if (fromBinding && !toBinding) {
    return fromBinding.binding_type === 'partner' ? null : 'outbound'
  }

  if (!fromBinding && toBinding) {
    return toBinding.binding_type === 'partner' ? null : 'inbound'
  }

  if (fromBinding && toBinding) {
    if (fromBinding.binding_type !== 'partner' && toBinding.binding_type === 'partner') {
      return 'outbound'
    }

    if (fromBinding.binding_type === 'partner' && toBinding.binding_type !== 'partner') {
      return 'inbound'
    }
  }

  return null
}

function getDisplayNameForBeamId(
  db: Database,
  beamId: string,
  binding: WorkspaceIdentityBindingRow | null = null,
): string | null {
  const agent = getAgent(db, beamId)
  if (agent?.display_name) {
    return agent.display_name
  }

  if (binding) {
    return binding.beam_id.split('@')[0] ?? null
  }

  return null
}

function parseRuntimeMetadata(
  bindingType: WorkspaceIdentityBindingType,
  runtimeType: string | null,
): SerializedWorkspaceIdentityBinding['runtime'] {
  if (bindingType === 'partner') {
    return {
      mode: 'partner',
      connector: null,
      label: runtimeType,
      connected: false,
      httpEndpoint: null,
      deliveryMode: null,
    }
  }

  if (bindingType === 'service') {
    const [connector, ...rest] = runtimeType?.split(':').map((entry) => entry.trim()).filter(Boolean) ?? []
    return {
      mode: 'service',
      connector: connector ?? null,
      label: rest.join(' · ') || runtimeType,
      connected: false,
      httpEndpoint: null,
      deliveryMode: null,
    }
  }

  if (runtimeType) {
    const [connector, ...rest] = runtimeType.split(':').map((entry) => entry.trim()).filter(Boolean)
    return {
      mode: 'runtime-backed',
      connector: connector ?? null,
      label: rest.join(' · ') || runtimeType,
      connected: false,
      httpEndpoint: null,
      deliveryMode: null,
    }
  }

  return {
    mode: 'manual',
    connector: null,
    label: null,
    connected: false,
    httpEndpoint: null,
    deliveryMode: null,
  }
}

function resolveWorkspaceHostRouteMetadata(
  db: Database,
  beamId: string,
): {
  hostId: number | null
  hostLabel: string | null
  hostHealth: OpenClawHostHealth | 'conflict' | null
  routeSource: OpenClawRouteSource | null
  runtimeSessionState: OpenClawRouteRuntimeState | null
  connectionMode: SerializedWorkspaceIdentityBinding['runtime']['deliveryMode']
  httpEndpoint: string | null
  connected: boolean
} {
  const routes = listOpenClawResolvedRoutesByBeamId(db, beamId)
  if (routes.length === 0) {
    return {
      hostId: null,
      hostLabel: null,
      hostHealth: null,
      routeSource: null,
      runtimeSessionState: null,
      connectionMode: null,
      httpEndpoint: null,
      connected: false,
    }
  }

  const conflict = routes.some((route) => route.runtime_session_state === 'conflict')
  const preferredRoute = routes.find((route) => route.runtime_session_state !== 'ended') ?? routes[0]
  const deliveryMode = preferredRoute.connection_mode ?? null
  const connected = preferredRoute.runtime_session_state === 'live'

  if (conflict) {
    return {
      hostId: null,
      hostLabel: `${routes.length} hosts`,
      hostHealth: 'conflict',
      routeSource: preferredRoute.route_source,
      runtimeSessionState: 'conflict',
      connectionMode: deliveryMode,
      httpEndpoint: preferredRoute.http_endpoint,
      connected: false,
    }
  }

  return {
    hostId: preferredRoute.host_id,
    hostLabel: preferredRoute.host_label ?? preferredRoute.hostname,
    hostHealth: preferredRoute.host_health_status,
    routeSource: preferredRoute.route_source,
    runtimeSessionState: preferredRoute.runtime_session_state,
    connectionMode: deliveryMode,
    httpEndpoint: preferredRoute.http_endpoint,
    connected,
  }
}

function classifyWorkspaceIdentityLifecycle(
  binding: WorkspaceIdentityBindingRow,
  options: {
    existsLocally: boolean
    lastSeenAgeHours: number | null
    keyState: object | null
    owner: string | null
  },
): WorkspaceIdentityLifecycleStatus {
  if (!options.owner) {
    return 'unowned'
  }

  if (binding.status !== 'active') {
    return 'paused'
  }

  if (!options.existsLocally && binding.binding_type !== 'partner') {
    return 'missing'
  }

  const keyState = options.keyState as {
    active?: object | null
    revoked?: object[]
  } | null

  if (options.existsLocally && keyState && !keyState.active && Array.isArray(keyState.revoked) && keyState.revoked.length > 0) {
    return 'revoked'
  }

  if (options.lastSeenAgeHours !== null && options.lastSeenAgeHours >= WORKSPACE_OVERVIEW_STALE_AFTER_HOURS) {
    return 'stale'
  }

  return 'healthy'
}

function timelineKindFromAction(action: string): WorkspaceTimelineEventKind {
  if (action.startsWith('admin.workspace_policy')) {
    return 'policy'
  }
  if (action.startsWith('admin.workspace_identity')) {
    return 'identity'
  }
  if (action.startsWith('admin.workspace_partner_channel')) {
    return 'partner_channel'
  }
  if (action.startsWith('admin.workspace_thread')) {
    return 'thread'
  }
  if (action.startsWith('admin.workspace_digest')) {
    return 'digest'
  }
  return 'workspace'
}

function parseAuditDetails(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function extractTraceHref(details: Record<string, unknown> | null): string | null {
  const nonceCandidates = [
    details?.['linkedIntentNonce'],
    details?.['lastIntentNonce'],
    details?.['proofIntentNonce'],
    details?.['nonce'],
  ]

  for (const value of nonceCandidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return `/intents/${encodeURIComponent(value)}`
    }
  }

  return null
}

function summarizeWorkspaceAuditAction(action: string, details: Record<string, unknown> | null): string {
  switch (action) {
    case 'admin.workspace.created':
      return 'Workspace created.'
    case 'admin.workspace_policy.updated':
      return 'Workspace policy updated.'
    case 'admin.workspace_identity.created':
      return 'Workspace identity binding added.'
    case 'admin.workspace_identity.updated':
      return 'Workspace identity binding updated.'
    case 'admin.workspace_identity.policy_updated':
      return 'Workspace identity policy updated.'
    case 'admin.workspace_identity.credential_reissued':
      return 'Local Beam credential reissued.'
    case 'admin.workspace_thread.created':
      return 'Workspace thread created.'
    case 'admin.workspace_thread.dispatched':
      return 'Workspace handoff dispatched.'
    case 'admin.workspace_thread.synced':
      return 'Inbound workspace handoff synced.'
    case 'admin.workspace_partner_channel.created':
      return 'Partner channel added.'
    case 'admin.workspace_partner_channel.updated':
      return 'Partner channel updated.'
    case 'admin.workspace_digest.delivered':
      return 'Workspace digest delivered.'
    default:
      if (typeof details?.['workflowType'] === 'string') {
        return `Workspace action for ${details['workflowType']}.`
      }
      return action
    }
}

function serializeWorkspace(db: Database, row: WorkspaceRow): SerializedWorkspace {
  const summary = getWorkspaceSummary(db, row.id)
  const { policy } = getWorkspacePolicyDocument(db, row.id)

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    orgName: row.org_name,
    description: row.description,
    status: row.status,
    defaultThreadScope: row.default_thread_scope,
    externalHandoffsEnabled: row.external_handoffs_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    summary: {
      identities: summary.identityCount,
      externalInitiators: summary.externalInitiatorCount,
      members: summary.memberCount,
      partnerChannels: summary.partnerChannelCount,
    },
    policyConfigured: policy.bindingRules.length > 0 || policy.workflowRules.length > 0 || policy.defaults.allowedPartners.length > 0 || policy.defaults.externalInitiation !== 'binding' || Boolean(policy.metadata.notes),
  }
}

function serializeWorkspaceIdentityBinding(db: Database, row: WorkspaceIdentityBindingRow): SerializedWorkspaceIdentityBinding {
  const agent = getAgent(db, row.beam_id)
  const keyState = agent
    ? serializeAgentKeyState(listAgentKeys(db, row.beam_id)) as SerializedWorkspaceIdentityBinding['identity']['keyState']
    : null
  const lastSeenAgeHours = hoursSince(agent?.last_seen ?? null)
  const runtime = parseRuntimeMetadata(row.binding_type, row.runtime_type)
  const hostRoute = resolveWorkspaceHostRouteMetadata(db, row.beam_id)
  const connected = hostRoute.routeSource
    ? hostRoute.connected
    : agent
      ? isAgentConnected(agent.beam_id)
      : false
  const httpEndpoint = hostRoute.httpEndpoint ?? agent?.http_endpoint ?? null
  const deliveryMode = agent
    ? connected && httpEndpoint
      ? 'hybrid'
      : connected
        ? 'websocket'
        : httpEndpoint
          ? 'http'
          : 'unavailable'
    : hostRoute.connectionMode
  const lifecycleStatus = classifyWorkspaceIdentityLifecycle(row, {
    existsLocally: Boolean(agent),
    lastSeenAgeHours,
    keyState,
    owner: row.owner,
  })
  const { policy } = getWorkspacePolicyDocument(db, row.workspace_id)
  const effectivePolicy = buildWorkspacePolicyPreview(policy, row)
  const bindingRule = [...policy.bindingRules].reverse().find((rule) => rule.beamId === row.beam_id) ?? null

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    beamId: row.beam_id,
    bindingType: row.binding_type,
    owner: row.owner,
    runtimeType: row.runtime_type,
    policyProfile: row.policy_profile,
    defaultThreadScope: row.default_thread_scope,
    canInitiateExternal: row.can_initiate_external === 1,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAgeHours,
    ownershipState: row.owner ? 'owned' : 'unowned',
    lifecycleStatus,
    hostId: hostRoute.hostId,
    hostLabel: hostRoute.hostLabel,
    hostHealth: hostRoute.hostHealth,
    routeSource: hostRoute.routeSource,
    runtimeSessionState: hostRoute.runtimeSessionState,
    runtime: {
      ...runtime,
      connected,
      httpEndpoint,
      deliveryMode,
    },
    identity: agent ? {
      existsLocally: true,
      beamId: agent.beam_id,
      did: buildWorkspaceIdentityDid(agent.beam_id),
      displayName: agent.display_name,
      org: agent.org,
      personal: agent.personal === 1,
      verificationTier: agent.verification_tier,
      trustScore: agent.trust_score,
      lastSeen: agent.last_seen,
      capabilities: JSON.parse(agent.capabilities) as string[],
      keyState,
    } : {
      existsLocally: false,
      beamId: row.beam_id,
      did: buildWorkspaceIdentityDid(row.beam_id),
      displayName: null,
      org: null,
      personal: false,
      verificationTier: null,
      trustScore: null,
      lastSeen: null,
      capabilities: [],
      keyState,
    },
    workspacePolicy: {
      effective: effectivePolicy,
      bindingRule: bindingRule
        ? {
            externalInitiation: bindingRule.externalInitiation,
            allowedPartners: bindingRule.allowedPartners,
          }
        : null,
    },
  }
}

function countWorkspacePartnerTraffic(
  db: Database,
  localBeamIds: string[],
  partnerBeamId: string,
): {
  recentSuccesses: number
  recentFailures: number
  totalObserved: number
} {
  if (localBeamIds.length === 0) {
    return {
      recentSuccesses: 0,
      recentFailures: 0,
      totalObserved: 0,
    }
  }

  const placeholders = localBeamIds.map(() => '?').join(', ')
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const row = db.prepare(`
    SELECT
      COUNT(*) AS totalObserved,
      SUM(CASE WHEN status = 'acked' AND requested_at >= ? THEN 1 ELSE 0 END) AS recentSuccesses,
      SUM(CASE WHEN status IN ('failed', 'dead_letter') AND requested_at >= ? THEN 1 ELSE 0 END) AS recentFailures
    FROM intent_log
    WHERE (
      (from_beam_id IN (${placeholders}) AND to_beam_id = ?)
      OR
      (to_beam_id IN (${placeholders}) AND from_beam_id = ?)
    )
  `).get(
    cutoff,
    cutoff,
    ...localBeamIds,
    partnerBeamId,
    ...localBeamIds,
    partnerBeamId,
  ) as {
    totalObserved: number | null
    recentSuccesses: number | null
    recentFailures: number | null
  } | undefined

  return {
    recentSuccesses: row?.recentSuccesses ?? 0,
    recentFailures: row?.recentFailures ?? 0,
    totalObserved: row?.totalObserved ?? 0,
  }
}

function classifyWorkspacePartnerChannelHealth(
  row: WorkspacePartnerChannelRow,
  stats: {
    recentSuccesses: number
    recentFailures: number
    totalObserved: number
  },
): WorkspacePartnerChannelHealth {
  if (row.status === 'blocked') {
    return 'critical'
  }

  if (row.last_failure_at && (!row.last_success_at || row.last_failure_at > row.last_success_at)) {
    return stats.recentFailures > 0 ? 'critical' : 'watch'
  }

  if (stats.recentFailures > 0) {
    return 'watch'
  }

  if (row.status === 'trial' || stats.totalObserved === 0) {
    return 'watch'
  }

  return 'healthy'
}

function resolveWorkspacePartnerRoute(
  db: Database,
  row: WorkspacePartnerChannelRow,
): SerializedWorkspacePartnerChannel['workspaceRoute'] {
  const routeBinding = listWorkspaceIdentityBindingsByBeamId(db, row.partner_beam_id, {
    excludeWorkspaceId: row.workspace_id,
  }).find((binding) => binding.binding_type !== 'partner')

  if (!routeBinding) {
    return null
  }

  const routeWorkspace = getWorkspaceById(db, routeBinding.workspace_id)
  if (!routeWorkspace) {
    return null
  }

  const routeIdentity = getAgent(db, routeBinding.beam_id)
  const runtime = parseRuntimeMetadata(routeBinding.binding_type, routeBinding.runtime_type)

  return {
    workspaceId: routeWorkspace.id,
    workspaceSlug: routeWorkspace.slug,
    workspaceName: routeWorkspace.name,
    bindingId: routeBinding.id,
    bindingType: routeBinding.binding_type,
    bindingStatus: routeBinding.status,
    displayName: routeIdentity?.display_name ?? null,
    runtimeType: routeBinding.runtime_type,
    runtime: {
      ...runtime,
      connected: routeBinding.binding_type !== 'partner' && isAgentConnected(routeBinding.beam_id),
    },
  }
}

function serializeWorkspacePartnerChannel(
  db: Database,
  row: WorkspacePartnerChannelRow,
  localBeamIds: string[],
): SerializedWorkspacePartnerChannel {
  const partner = getAgent(db, row.partner_beam_id)
  const stats = countWorkspacePartnerTraffic(db, localBeamIds, row.partner_beam_id)
  const healthStatus = classifyWorkspacePartnerChannelHealth(row, stats)
  const trace = row.last_intent_nonce ? getIntentLogByNonce(db, row.last_intent_nonce) : null
  const workspaceRoute = resolveWorkspacePartnerRoute(db, row)

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    partnerBeamId: row.partner_beam_id,
    label: row.label,
    owner: row.owner,
    status: row.status,
    healthStatus,
    notes: row.notes,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastIntentNonce: row.last_intent_nonce,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats,
    partner: {
      existsLocally: Boolean(partner),
      displayName: partner?.display_name ?? null,
      org: partner?.org ?? null,
      verificationTier: partner?.verification_tier ?? null,
      trustScore: partner?.trust_score ?? null,
      lastSeen: partner?.last_seen ?? null,
    },
    workspaceRoute,
    trace: trace ? {
      nonce: trace.nonce,
      status: trace.status,
      intentType: trace.intent_type,
      requestedAt: trace.requested_at,
      completedAt: trace.completed_at,
      errorCode: trace.error_code,
      href: `/intents/${encodeURIComponent(trace.nonce)}`,
    } : null,
  }
}

function listWorkspaceTimelineEntries(
  db: Database,
  workspace: WorkspaceRow,
  limit = WORKSPACE_TIMELINE_LIMIT_DEFAULT,
): WorkspaceTimelineEntry[] {
  const boundedLimit = Math.max(1, Math.min(WORKSPACE_TIMELINE_LIMIT_MAX, Math.trunc(limit)))
  const rows = db.prepare(`
    SELECT *
    FROM audit_log
    WHERE target = ? OR target LIKE ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(
    workspace.slug,
    `${workspace.slug}:%`,
    boundedLimit,
  ) as AuditLogRow[]

  return rows.map((row) => {
    const details = parseAuditDetails(row.details)
    const kind = timelineKindFromAction(row.action)
    const traceHref = extractTraceHref(details)
    let href: string | null = `/workspaces?workspace=${encodeURIComponent(workspace.slug)}`
    if (kind === 'thread') {
      const threadId = row.target.slice(`${workspace.slug}:`.length)
      if (/^\d+$/.test(threadId)) {
        href = `/workspaces?workspace=${encodeURIComponent(workspace.slug)}&thread=${encodeURIComponent(threadId)}`
      }
    }

    return {
      id: row.id,
      kind,
      action: row.action,
      actor: row.actor,
      target: row.target,
      timestamp: row.timestamp,
      summary: summarizeWorkspaceAuditAction(row.action, details),
      details,
      href,
      traceHref,
    }
  })
}

function buildWorkspaceDigestPayload(db: Database, workspace: WorkspaceRow, days = WORKSPACE_DIGEST_DEFAULT_DAYS) {
  const generatedAt = new Date().toISOString()
  const overview = buildWorkspaceOverview(db, workspace)
  const bindings = listWorkspaceIdentityBindings(db, workspace.id)
  const localBeamIds = bindings
    .filter((binding) => binding.binding_type !== 'partner')
    .map((binding) => binding.beam_id)
  const partnerChannels = listWorkspacePartnerChannels(db, workspace.id).map((row) => serializeWorkspacePartnerChannel(db, row, localBeamIds))
  const threads = listWorkspaceThreads(db, workspace.id).map((row) => serializeWorkspaceThread(db, row, listWorkspaceThreadParticipants(db, row.id)))
  const timeline = listWorkspaceTimelineEntries(db, workspace, 12)

  const actionItems: WorkspaceDigestActionItem[] = []

  for (const item of overview.blockedExternalMotion) {
    actionItems.push({
      id: `approval-${item.binding.id}-${item.reasonCode}`,
      category: 'approval',
      severity: item.reasonCode === 'workspace_handoffs_disabled' ? 'critical' : 'warning',
      title: `${item.binding.beamId} cannot initiate external motion`,
      detail: item.reason,
      owner: item.binding.owner,
      href: `/workspaces?workspace=${encodeURIComponent(workspace.slug)}`,
      nextAction: item.reasonCode === 'manual_review_required'
        ? 'Approve external initiation or add a matching workflow rule.'
        : 'Resume the binding or re-enable workspace external handoffs.',
    })
  }

  for (const item of overview.staleBindings) {
    actionItems.push({
      id: `identity-${item.binding.id}-${item.reasonCode}`,
      category: 'identity',
      severity: item.reasonCode === 'identity_missing' ? 'critical' : 'warning',
      title: `${item.binding.beamId} needs identity attention`,
      detail: item.reason,
      owner: item.binding.owner,
      href: `/workspaces?workspace=${encodeURIComponent(workspace.slug)}`,
      nextAction: item.reasonCode === 'identity_missing'
        ? 'Re-register the runtime or remove the stale binding.'
        : 'Check the runtime heartbeat and confirm the owner is still current.',
    })
  }

  for (const channel of partnerChannels) {
    if (channel.healthStatus === 'healthy' && channel.owner) {
      continue
    }

    actionItems.push({
      id: `partner-${channel.id}`,
      category: 'partner_channel',
      severity: channel.healthStatus === 'critical' ? 'critical' : 'warning',
      title: `${channel.label || channel.partnerBeamId} partner channel needs follow-up`,
      detail: channel.status === 'blocked'
        ? 'The channel is blocked and cannot be used for new partner-facing motion.'
        : channel.owner
          ? 'The channel is degraded or still in trial and should be reviewed before the next handoff.'
          : 'The channel has no owner and should be assigned before the next external workflow.',
      owner: channel.owner,
      href: `/workspaces?workspace=${encodeURIComponent(workspace.slug)}`,
      nextAction: channel.status === 'blocked'
        ? 'Confirm whether to reopen the partner channel or keep it blocked.'
        : 'Assign an owner, review recent trace evidence, and confirm the partner allowlist.',
    })
  }

  for (const thread of threads) {
    if (thread.status === 'closed') {
      continue
    }
    if (thread.status === 'blocked' || !thread.owner) {
      actionItems.push({
        id: `thread-${thread.id}`,
        category: 'thread',
        severity: thread.status === 'blocked' ? 'critical' : 'warning',
        title: `${thread.title} needs operator follow-up`,
        detail: thread.status === 'blocked'
          ? 'This workspace thread is blocked and will not progress until an operator resolves it.'
          : 'This workspace thread has no owner yet and risks getting dropped.',
        owner: thread.owner,
        href: `/workspaces?workspace=${encodeURIComponent(workspace.slug)}&thread=${thread.id}`,
        nextAction: thread.status === 'blocked'
          ? 'Review the linked policy or partner channel decision and unblock or close the thread.'
          : 'Assign an owner and confirm the next operator action.',
      })
    }
  }

  const escalations = actionItems.filter((item) => item.severity === 'critical')

  const markdownLines = [
    `# Beam workspace digest · ${workspace.name}`,
    '',
    `Generated: ${generatedAt}`,
    `Window: last ${days} day${days === 1 ? '' : 's'}`,
    '',
    '## Summary',
    `- Active identities: ${overview.summary.activeIdentities}/${overview.summary.totalIdentities}`,
    `- External-ready identities: ${overview.summary.externalReadyIdentities}`,
    `- Stale identities: ${overview.summary.staleIdentities}`,
    `- Pending approvals: ${overview.summary.pendingApprovals}`,
    `- Blocked external motion: ${overview.summary.blockedExternalMotion}`,
    `- Partner channels: ${partnerChannels.length}`,
    `- Open threads: ${threads.filter((thread) => thread.status !== 'closed').length}`,
    '',
    '## Action Items',
  ]

  if (actionItems.length === 0) {
    markdownLines.push('- No workspace action items right now.')
  } else {
    for (const item of actionItems) {
      markdownLines.push(`- [${item.severity.toUpperCase()}] ${item.title}: ${item.detail} Next: ${item.nextAction}${item.owner ? ` Owner: ${item.owner}.` : ''}${item.href ? ` Surface: ${item.href}` : ''}`)
    }
  }

  markdownLines.push('', '## Recent Timeline')

  if (timeline.length === 0) {
    markdownLines.push('- No workspace timeline entries yet.')
  } else {
    for (const entry of timeline) {
      markdownLines.push(`- ${entry.timestamp} · ${entry.summary} (${entry.actor})`)
    }
  }

  return {
    workspace: serializeWorkspace(db, workspace),
    generatedAt,
    days,
    summary: {
      actionItems: actionItems.length,
      escalations: escalations.length,
      partnerChannels: partnerChannels.length,
      openThreads: threads.filter((thread) => thread.status !== 'closed').length,
      staleIdentities: overview.summary.staleIdentities,
      blockedExternalMotion: overview.summary.blockedExternalMotion,
    },
    actionItems,
    escalations,
    partnerChannels,
    timeline,
    markdown: markdownLines.join('\n'),
  }
}

function serializeWorkspaceThreadParticipant(
  db: Database,
  row: WorkspaceThreadParticipantRow,
): SerializedWorkspaceThreadParticipant {
  const identity = row.beam_id ? getAgent(db, row.beam_id) : null
  return {
    id: row.id,
    threadId: row.thread_id,
    principalId: row.principal_id,
    principalType: row.principal_type,
    displayName: row.display_name,
    beamId: row.beam_id,
    workspaceBindingId: row.workspace_binding_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    identity: identity ? {
      existsLocally: true,
      displayName: identity.display_name,
      org: identity.org,
      verificationTier: identity.verification_tier,
      trustScore: identity.trust_score,
      lastSeen: identity.last_seen,
    } : row.beam_id ? {
      existsLocally: false,
      displayName: row.display_name,
      org: null,
      verificationTier: null,
      trustScore: null,
      lastSeen: null,
    } : null,
  }
}

function serializeWorkspaceThread(
  db: Database,
  row: WorkspaceThreadRow,
  participants: WorkspaceThreadParticipantRow[],
): SerializedWorkspaceThread {
  const intent = row.linked_intent_nonce ? getIntentLogByNonce(db, row.linked_intent_nonce) : null
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    owner: row.owner,
    status: row.status,
    workflowType: row.workflow_type,
    draftIntentType: row.draft_intent_type,
    draftPayload: parseJsonObject(row.draft_payload_json),
    linkedIntentNonce: row.linked_intent_nonce,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    participantCount: participants.length,
    trace: intent ? {
      nonce: intent.nonce,
      status: intent.status,
      intentType: intent.intent_type,
      fromBeamId: intent.from_beam_id,
      toBeamId: intent.to_beam_id,
      requestedAt: intent.requested_at,
      completedAt: intent.completed_at,
      latencyMs: intent.round_trip_latency_ms,
      errorCode: intent.error_code,
      href: `/intents/${encodeURIComponent(intent.nonce)}`,
    } : null,
  }
}

function syncRoutedWorkspaceThread(
  db: Database,
  input: {
    actor: string
    actorRole: 'admin' | 'operator' | 'viewer'
    sourceWorkspace: WorkspaceRow
    sourceThread: WorkspaceThreadRow
    sourceSenderBinding: WorkspaceIdentityBindingRow
    partnerChannel: WorkspacePartnerChannelRow
    linkedIntentNonce: string
    intentType: string
    draftPayload: Record<string, unknown>
  },
): SerializedWorkspaceThreadSync {
  const targetRoute = resolveWorkspacePartnerRoute(db, input.partnerChannel)
  if (!targetRoute) {
    return null
  }

  const targetWorkspace = getWorkspaceById(db, targetRoute.workspaceId)
  if (!targetWorkspace) {
    return null
  }

  const targetBinding = getWorkspaceIdentityBindingById(db, targetRoute.bindingId)
  if (!targetBinding || targetBinding.workspace_id !== targetWorkspace.id || targetBinding.binding_type === 'partner') {
    return null
  }

  const existingThread = getWorkspaceThreadByLinkedIntentNonce(db, targetWorkspace.id, input.linkedIntentNonce)
  const now = new Date().toISOString()
  const targetOwner = targetBinding.owner ?? null
  const syncedSummary = input.sourceThread.summary?.trim() || `Inbound handoff from ${input.sourceWorkspace.name}.`

  const syncedThread = existingThread
    ? updateWorkspaceThread(db, {
        id: existingThread.id,
        title: input.sourceThread.title,
        summary: syncedSummary,
        owner: targetOwner,
        status: 'open',
        workflowType: input.sourceThread.workflow_type,
        draftIntentType: input.intentType,
        draftPayloadJson: JSON.stringify(input.draftPayload),
        linkedIntentNonce: input.linkedIntentNonce,
        lastActivityAt: now,
      })
    : createWorkspaceThread(db, {
        workspaceId: targetWorkspace.id,
        kind: 'handoff',
        title: input.sourceThread.title,
        summary: syncedSummary,
        owner: targetOwner,
        status: 'open',
        workflowType: input.sourceThread.workflow_type,
        draftIntentType: input.intentType,
        draftPayloadJson: JSON.stringify(input.draftPayload),
        linkedIntentNonce: input.linkedIntentNonce,
        lastActivityAt: now,
      })

  if (!syncedThread) {
    return null
  }

  if (!existingThread) {
    const sourceIdentity = getAgent(db, input.sourceSenderBinding.beam_id)
    const targetIdentity = getAgent(db, targetBinding.beam_id)

    createWorkspaceThreadParticipant(db, {
      threadId: syncedThread.id,
      principalId: targetBinding.beam_id,
      principalType: targetBinding.binding_type === 'service' ? 'service' : 'agent',
      displayName: targetIdentity?.display_name ?? targetBinding.beam_id,
      beamId: targetBinding.beam_id,
      workspaceBindingId: targetBinding.id,
      role: targetOwner ? 'owner' : 'participant',
    })

    createWorkspaceThreadParticipant(db, {
      threadId: syncedThread.id,
      principalId: input.sourceSenderBinding.beam_id,
      principalType: 'partner',
      displayName: sourceIdentity?.display_name ?? input.sourceWorkspace.name,
      beamId: input.sourceSenderBinding.beam_id,
      role: 'participant',
    })
  }

  logAuditEvent(db, {
    action: 'admin.workspace_thread.synced',
    actor: input.actor,
    target: `${targetWorkspace.slug}:${syncedThread.id}`,
    details: {
      role: input.actorRole,
      linkedIntentNonce: input.linkedIntentNonce,
      intentType: input.intentType,
      workflowType: input.sourceThread.workflow_type,
      sourceWorkspaceSlug: input.sourceWorkspace.slug,
      sourceWorkspaceName: input.sourceWorkspace.name,
      sourceThreadId: input.sourceThread.id,
      fromBeamId: input.sourceSenderBinding.beam_id,
      toBeamId: input.partnerChannel.partner_beam_id,
      disposition: existingThread ? 'updated' : 'created',
    },
  })

  return {
    workspaceId: targetWorkspace.id,
    workspaceSlug: targetWorkspace.slug,
    workspaceName: targetWorkspace.name,
    threadId: syncedThread.id,
    threadHref: `/workspaces?workspace=${encodeURIComponent(targetWorkspace.slug)}&thread=${encodeURIComponent(String(syncedThread.id))}`,
    bindingId: targetBinding.id,
    beamId: targetBinding.beam_id,
    disposition: existingThread ? 'updated' : 'created',
  }
}

function buildWorkspacePolicyPreview(
  policy: WorkspacePolicy,
  binding: WorkspaceIdentityBindingRow,
  workflowType: string | null = null,
): SerializedWorkspacePolicyPreview {
  const evaluation = evaluateWorkspacePolicy(policy, binding, {
    workflowType,
  })

  return {
    beamId: evaluation.beamId,
    bindingType: evaluation.bindingType,
    policyProfile: evaluation.policyProfile,
    externalInitiation: evaluation.externalInitiation,
    allowedPartners: evaluation.allowedPartners,
    approvalRequired: evaluation.approvalRequired,
    approvers: evaluation.approvers,
    matchedBindingRules: evaluation.matchedBindingRules,
    matchedWorkflowRules: evaluation.matchedWorkflowRules,
    workflowType,
  }
}

function buildWorkspacePolicyEnvelope(db: Database, workspace: WorkspaceRow) {
  const bindings = listWorkspaceIdentityBindings(db, workspace.id)
  const locals = bindings.filter(isLocalWorkspaceBinding)
  const { policy, updatedAt, updatedBy } = getWorkspacePolicyDocument(db, workspace.id)
  const workflows = [...new Set(policy.workflowRules.map((rule) => rule.workflowType))]

  return {
    workspace: serializeWorkspace(db, workspace),
    policy,
    updatedAt,
    updatedBy,
    previews: {
      bindings: locals.map((binding) => buildWorkspacePolicyPreview(policy, binding)),
      workflows: workflows.map((workflowType) => ({
        workflowType,
        bindings: locals.map((binding) => buildWorkspacePolicyPreview(policy, binding, workflowType)),
      })),
    },
  }
}

function listRecentWorkspaceExternalHandoffs(
  db: Database,
  bindings: WorkspaceIdentityBindingRow[],
  limit = WORKSPACE_OVERVIEW_RECENT_HANDOFF_LIMIT,
): WorkspaceOverviewHandoff[] {
  if (bindings.length === 0) {
    return []
  }

  const beamIds = [...new Set(bindings.map((row) => row.beam_id))]
  const placeholders = beamIds.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT *
    FROM intent_log
    WHERE from_beam_id IN (${placeholders}) OR to_beam_id IN (${placeholders})
    ORDER BY requested_at DESC, id DESC
    LIMIT ?
  `).all(...beamIds, ...beamIds, WORKSPACE_OVERVIEW_INTENT_SCAN_LIMIT) as IntentLogRow[]

  const bindingByBeamId = new Map(bindings.map((row) => [row.beam_id, row]))
  const handoffs: WorkspaceOverviewHandoff[] = []

  for (const row of rows) {
    const fromBinding = bindingByBeamId.get(row.from_beam_id)
    const toBinding = bindingByBeamId.get(row.to_beam_id)
    const direction = classifyWorkspaceHandoffDirection(fromBinding, toBinding)
    if (!direction) {
      continue
    }

    const workspaceBinding = direction === 'outbound'
      ? (fromBinding && fromBinding.binding_type !== 'partner' ? fromBinding : fromBinding ?? null)
      : (toBinding && toBinding.binding_type !== 'partner' ? toBinding : toBinding ?? null)

    const counterpartyBeamId = direction === 'outbound' ? row.to_beam_id : row.from_beam_id
    const counterpartyBinding = bindingByBeamId.get(counterpartyBeamId) ?? null

    handoffs.push({
      nonce: row.nonce,
      intentType: row.intent_type,
      status: row.status,
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
      latencyMs: row.round_trip_latency_ms,
      errorCode: row.error_code,
      direction,
      fromBeamId: row.from_beam_id,
      toBeamId: row.to_beam_id,
      workspaceSide: {
        beamId: workspaceBinding?.beam_id ?? (direction === 'outbound' ? row.from_beam_id : row.to_beam_id),
        displayName: getDisplayNameForBeamId(
          db,
          workspaceBinding?.beam_id ?? (direction === 'outbound' ? row.from_beam_id : row.to_beam_id),
          workspaceBinding,
        ),
        bindingType: workspaceBinding?.binding_type ?? null,
      },
      counterparty: {
        beamId: counterpartyBeamId,
        displayName: getDisplayNameForBeamId(db, counterpartyBeamId, counterpartyBinding),
        bindingType: counterpartyBinding?.binding_type ?? null,
        inWorkspace: Boolean(counterpartyBinding),
      },
    })

    if (handoffs.length >= limit) {
      break
    }
  }

  return handoffs
}

function buildWorkspaceOverview(db: Database, workspace: WorkspaceRow) {
  const bindings = listWorkspaceIdentityBindings(db, workspace.id)
  const staleBindings: WorkspaceOverviewAttentionItem[] = []
  const blockedExternalMotion: WorkspaceOverviewAttentionItem[] = []

  let activeIdentities = 0
  let localIdentities = 0
  let partnerIdentities = 0
  let externalReadyIdentities = 0
  let pendingApprovals = 0

  for (const row of bindings) {
    const binding = serializeWorkspaceIdentityBinding(db, row)
    const lastSeenAgeHours = hoursSince(binding.identity.lastSeen)
    const isLocal = isLocalWorkspaceBinding(row)

    if (row.status === 'active') {
      activeIdentities += 1
    }
    if (isLocal) {
      localIdentities += 1
    } else {
      partnerIdentities += 1
    }
    if (isLocal && row.status === 'active' && row.can_initiate_external === 1 && workspace.external_handoffs_enabled === 1) {
      externalReadyIdentities += 1
    }

    if (isLocal) {
      if (!binding.identity.existsLocally) {
        staleBindings.push({
          binding,
          reasonCode: 'identity_missing',
          reason: 'This workspace binding points to a local identity that is no longer registered in the directory.',
          lastSeenAgeHours: null,
        })
      } else if (lastSeenAgeHours !== null && lastSeenAgeHours >= WORKSPACE_OVERVIEW_STALE_AFTER_HOURS) {
        staleBindings.push({
          binding,
          reasonCode: 'stale_check_in',
          reason: `This identity has not checked in within ${WORKSPACE_OVERVIEW_STALE_AFTER_HOURS} hours.`,
          lastSeenAgeHours,
        })
      }

      if (row.status !== 'active') {
        blockedExternalMotion.push({
          binding,
          reasonCode: 'binding_paused',
          reason: 'This identity binding is paused and cannot initiate external handoffs.',
          lastSeenAgeHours,
        })
      } else if (workspace.external_handoffs_enabled !== 1) {
        blockedExternalMotion.push({
          binding,
          reasonCode: 'workspace_handoffs_disabled',
          reason: 'Workspace-level external handoffs are disabled, so outbound motion is blocked.',
          lastSeenAgeHours,
        })
      } else if (row.can_initiate_external !== 1) {
        blockedExternalMotion.push({
          binding,
          reasonCode: 'manual_review_required',
          reason: 'This identity can work internally, but external motion still requires manual approval.',
          lastSeenAgeHours,
        })
        pendingApprovals += 1
      }
    }
  }

  const recentExternalHandoffs = listRecentWorkspaceExternalHandoffs(db, bindings)

  staleBindings.sort((left, right) => {
    if (left.reasonCode === 'identity_missing' && right.reasonCode !== 'identity_missing') {
      return -1
    }
    if (left.reasonCode !== 'identity_missing' && right.reasonCode === 'identity_missing') {
      return 1
    }
    return (right.lastSeenAgeHours ?? 0) - (left.lastSeenAgeHours ?? 0)
  })

  blockedExternalMotion.sort((left, right) => {
    const priority = (item: WorkspaceOverviewAttentionItem) => {
      switch (item.reasonCode) {
        case 'workspace_handoffs_disabled':
          return 0
        case 'binding_paused':
          return 1
        case 'manual_review_required':
          return 2
        default:
          return 3
      }
    }

    return priority(left) - priority(right)
  })

  return {
    generatedAt: new Date().toISOString(),
    staleAfterHours: WORKSPACE_OVERVIEW_STALE_AFTER_HOURS,
    summary: {
      totalIdentities: bindings.length,
      activeIdentities,
      localIdentities,
      partnerIdentities,
      externalReadyIdentities,
      staleIdentities: staleBindings.length,
      pendingApprovals,
      blockedExternalMotion: blockedExternalMotion.length,
      recentExternalHandoffs: recentExternalHandoffs.length,
    },
    staleBindings,
    blockedExternalMotion,
    recentExternalHandoffs,
  }
}

function isUniqueConstraintError(err: unknown, target: string): boolean {
  return err instanceof Error && err.message.includes(`UNIQUE constraint failed: ${target}`)
}

export function workspacesRouter(db: Database): Hono {
  const router = new Hono()

  router.get('/', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const rows = listWorkspaces(db)
    c.header('Cache-Control', 'no-store')
    return c.json({
      workspaces: rows.map((row) => serializeWorkspace(db, row)),
      total: rows.length,
    })
  })

  router.post('/', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
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
    const name = normalizeOptionalString(raw.name)
    if (!name) {
      return c.json({ error: 'name is required', errorCode: 'INVALID_WORKSPACE_NAME' }, 400)
    }

    const slug = normalizeWorkspaceSlug(raw.slug, name)
    if (!slug) {
      return c.json({ error: 'slug must contain lowercase letters, numbers, and dashes only', errorCode: 'INVALID_WORKSPACE_SLUG' }, 400)
    }

    const orgName = normalizeOptionalString(raw.orgName)
    if (orgName && !getOrg(db, orgName)) {
      return c.json({ error: 'orgName was not found', errorCode: 'ORG_NOT_FOUND' }, 404)
    }

    const description = normalizeOptionalString(raw.description)
    const status = 'status' in raw ? normalizeWorkspaceStatus(raw.status) : 'active'
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid workspace status', errorCode: 'INVALID_WORKSPACE_STATUS' }, 400)
    }

    const defaultThreadScope = 'defaultThreadScope' in raw
      ? normalizeWorkspaceThreadScope(raw.defaultThreadScope)
      : 'internal'
    if ('defaultThreadScope' in raw && !defaultThreadScope) {
      return c.json({ error: 'Invalid defaultThreadScope', errorCode: 'INVALID_WORKSPACE_SCOPE' }, 400)
    }

    const externalHandoffsEnabled = 'externalHandoffsEnabled' in raw
      ? normalizeBoolean(raw.externalHandoffsEnabled)
      : false
    if ('externalHandoffsEnabled' in raw && externalHandoffsEnabled === null) {
      return c.json({ error: 'externalHandoffsEnabled must be boolean', errorCode: 'INVALID_EXTERNAL_HANDOFFS_ENABLED' }, 400)
    }

    try {
      const workspace = createWorkspace(db, {
        slug,
        name,
        orgName,
        description,
        status: status ?? 'active',
        defaultThreadScope: defaultThreadScope ?? 'internal',
        externalHandoffsEnabled: externalHandoffsEnabled ?? false,
      })

      logAuditEvent(db, {
        action: 'admin.workspace.created',
        actor: auth.session.email,
        target: workspace.slug,
        details: {
          role: auth.session.role,
          orgName: workspace.org_name,
          defaultThreadScope: workspace.default_thread_scope,
          externalHandoffsEnabled: workspace.external_handoffs_enabled === 1,
        },
      })

      c.header('Cache-Control', 'no-store')
      return c.json({ workspace: serializeWorkspace(db, workspace) }, 201)
    } catch (err) {
      if (isUniqueConstraintError(err, 'workspaces.slug')) {
        return c.json({ error: 'Workspace slug already exists', errorCode: 'WORKSPACE_SLUG_TAKEN' }, 409)
      }

      console.error('Workspace create error:', err)
      return c.json({ error: 'Failed to create workspace', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.get('/:slug', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({ workspace: serializeWorkspace(db, workspace) })
  })

  router.get('/:slug/overview', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      workspace: serializeWorkspace(db, workspace),
      ...buildWorkspaceOverview(db, workspace),
    })
  })

  router.get('/:slug/partner-channels', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const localBeamIds = listWorkspaceIdentityBindings(db, workspace.id)
      .filter((binding) => binding.binding_type !== 'partner')
      .map((binding) => binding.beam_id)
    const channels = listWorkspacePartnerChannels(db, workspace.id).map((row) => serializeWorkspacePartnerChannel(db, row, localBeamIds))

    c.header('Cache-Control', 'no-store')
    return c.json({
      workspace: serializeWorkspace(db, workspace),
      channels,
      total: channels.length,
    })
  })

  router.post('/:slug/partner-channels', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
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
    const partnerBeamId = normalizeOptionalString(raw.partnerBeamId)
    if (!partnerBeamId) {
      return c.json({ error: 'partnerBeamId is required', errorCode: 'INVALID_PARTNER_BEAM_ID' }, 400)
    }

    const status = 'status' in raw ? normalizePartnerChannelStatus(raw.status) : 'trial'
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid partner channel status', errorCode: 'INVALID_PARTNER_CHANNEL_STATUS' }, 400)
    }

    if (getWorkspacePartnerChannelByBeamId(db, workspace.id, partnerBeamId)) {
      return c.json({ error: 'Workspace partner channel already exists', errorCode: 'WORKSPACE_PARTNER_CHANNEL_EXISTS' }, 409)
    }

    try {
      const channel = createWorkspacePartnerChannel(db, {
        workspaceId: workspace.id,
        partnerBeamId,
        label: normalizeOptionalString(raw.label),
        owner: normalizeOptionalString(raw.owner),
        status: status ?? 'trial',
        notes: normalizeOptionalString(raw.notes),
      })

      logAuditEvent(db, {
        action: 'admin.workspace_partner_channel.created',
        actor: auth.session.email,
        target: `${workspace.slug}:${partnerBeamId}`,
        details: {
          role: auth.session.role,
          owner: channel.owner,
          status: channel.status,
        },
      })

      const localBeamIds = listWorkspaceIdentityBindings(db, workspace.id)
        .filter((binding) => binding.binding_type !== 'partner')
        .map((binding) => binding.beam_id)

      c.header('Cache-Control', 'no-store')
      return c.json({
        channel: serializeWorkspacePartnerChannel(db, channel, localBeamIds),
      }, 201)
    } catch (err) {
      if (isUniqueConstraintError(err, 'workspace_partner_channels.workspace_id, workspace_partner_channels.partner_beam_id')) {
        return c.json({ error: 'Workspace partner channel already exists', errorCode: 'WORKSPACE_PARTNER_CHANNEL_EXISTS' }, 409)
      }

      console.error('Workspace partner channel create error:', err)
      return c.json({ error: 'Failed to create workspace partner channel', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.patch('/:slug/partner-channels/:id', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const channelId = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return c.json({ error: 'Invalid partner channel id', errorCode: 'INVALID_PARTNER_CHANNEL_ID' }, 400)
    }

    const existing = getWorkspacePartnerChannelById(db, channelId)
    if (!existing || existing.workspace_id !== workspace.id) {
      return c.json({ error: 'Workspace partner channel not found', errorCode: 'NOT_FOUND' }, 404)
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
    const status = 'status' in raw ? normalizePartnerChannelStatus(raw.status) : existing.status
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid partner channel status', errorCode: 'INVALID_PARTNER_CHANNEL_STATUS' }, 400)
    }

    const lastIntentNonce = 'lastIntentNonce' in raw ? normalizeOptionalString(raw.lastIntentNonce) : existing.last_intent_nonce
    if (lastIntentNonce && !getIntentLogByNonce(db, lastIntentNonce)) {
      return c.json({ error: 'lastIntentNonce was not found', errorCode: 'INTENT_NOT_FOUND' }, 404)
    }

    const updated = updateWorkspacePartnerChannel(db, {
      id: existing.id,
      label: 'label' in raw ? normalizeOptionalString(raw.label) : existing.label,
      owner: 'owner' in raw ? normalizeOptionalString(raw.owner) : existing.owner,
      status: status ?? existing.status,
      notes: 'notes' in raw ? normalizeOptionalString(raw.notes) : existing.notes,
      lastSuccessAt: 'lastSuccessAt' in raw ? normalizeOptionalString(raw.lastSuccessAt) : undefined,
      lastFailureAt: 'lastFailureAt' in raw ? normalizeOptionalString(raw.lastFailureAt) : undefined,
      lastIntentNonce: 'lastIntentNonce' in raw ? lastIntentNonce : undefined,
    })

    if (!updated) {
      return c.json({ error: 'Workspace partner channel not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.workspace_partner_channel.updated',
      actor: auth.session.email,
      target: `${workspace.slug}:${existing.partner_beam_id}`,
      details: {
        role: auth.session.role,
        owner: updated.owner,
        status: updated.status,
        lastIntentNonce: updated.last_intent_nonce,
      },
    })

    const localBeamIds = listWorkspaceIdentityBindings(db, workspace.id)
      .filter((binding) => binding.binding_type !== 'partner')
      .map((binding) => binding.beam_id)

    c.header('Cache-Control', 'no-store')
    return c.json({
      channel: serializeWorkspacePartnerChannel(db, updated, localBeamIds),
    })
  })

  router.get('/:slug/threads', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const rows = listWorkspaceThreads(db, workspace.id)
    c.header('Cache-Control', 'no-store')
    return c.json({
      workspace: serializeWorkspace(db, workspace),
      threads: rows.map((row) => serializeWorkspaceThread(db, row, listWorkspaceThreadParticipants(db, row.id))),
      total: rows.length,
    })
  })

  router.get('/:slug/threads/:id', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const threadId = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(threadId) || threadId <= 0) {
      return c.json({ error: 'Invalid thread id', errorCode: 'INVALID_THREAD_ID' }, 400)
    }

    const thread = getWorkspaceThreadById(db, threadId)
    if (!thread || thread.workspace_id !== workspace.id) {
      return c.json({ error: 'Workspace thread not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const participants = listWorkspaceThreadParticipants(db, thread.id)
    c.header('Cache-Control', 'no-store')
    return c.json({
      workspace: serializeWorkspace(db, workspace),
      thread: serializeWorkspaceThread(db, thread, participants),
      participants: participants.map((row) => serializeWorkspaceThreadParticipant(db, row)),
    })
  })

  router.post('/:slug/threads', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
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
    const kind = normalizeThreadKind(raw.kind)
    if (!kind) {
      return c.json({ error: 'Invalid thread kind', errorCode: 'INVALID_THREAD_KIND' }, 400)
    }

    const title = normalizeOptionalString(raw.title)
    if (!title) {
      return c.json({ error: 'title is required', errorCode: 'INVALID_THREAD_TITLE' }, 400)
    }

    const summary = normalizeOptionalString(raw.summary)
    const owner = normalizeOptionalString(raw.owner)
    const status = 'status' in raw ? normalizeThreadStatus(raw.status) : 'open'
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid thread status', errorCode: 'INVALID_THREAD_STATUS' }, 400)
    }

    const workflowType = normalizeOptionalString(raw.workflowType)
    const draftIntentType = normalizeOptionalString(raw.draftIntentType)
    let draftPayload: Record<string, unknown> | null = null
    try {
      draftPayload = normalizeOptionalObject(raw.draftPayload, 'draftPayload')
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'draftPayload must be an object',
        errorCode: 'INVALID_DRAFT_PAYLOAD',
      }, 400)
    }
    const linkedIntentNonce = normalizeOptionalString(raw.linkedIntentNonce)
    if (kind === 'handoff' && !linkedIntentNonce && (status ?? 'open') !== 'blocked') {
      return c.json({ error: 'linkedIntentNonce is required for non-blocked handoff threads', errorCode: 'MISSING_THREAD_NONCE' }, 400)
    }
    if (kind === 'internal' && linkedIntentNonce) {
      return c.json({ error: 'Internal threads cannot link directly to a Beam trace', errorCode: 'INTERNAL_THREAD_CANNOT_LINK_TRACE' }, 400)
    }
    if (kind === 'internal' && (draftIntentType || draftPayload)) {
      return c.json({ error: 'Internal threads cannot carry Beam intent drafts', errorCode: 'INTERNAL_THREAD_CANNOT_DRAFT_INTENT' }, 400)
    }
    if (draftPayload && !draftIntentType) {
      return c.json({ error: 'draftIntentType is required when draftPayload is provided', errorCode: 'MISSING_DRAFT_INTENT_TYPE' }, 400)
    }
    if (kind === 'handoff' && !linkedIntentNonce && draftIntentType && !draftPayload) {
      return c.json({ error: 'draftPayload is required when draftIntentType is provided for a blocked handoff thread', errorCode: 'MISSING_DRAFT_PAYLOAD' }, 400)
    }

    const linkedIntent = linkedIntentNonce ? getIntentLogByNonce(db, linkedIntentNonce) : null
    if (linkedIntentNonce && !linkedIntent) {
      return c.json({ error: 'linkedIntentNonce was not found', errorCode: 'INTENT_NOT_FOUND' }, 404)
    }
    if (linkedIntent && draftIntentType && linkedIntent.intent_type !== draftIntentType) {
      return c.json({
        error: `draftIntentType ${draftIntentType} does not match linked trace intent ${linkedIntent.intent_type}`,
        errorCode: 'DRAFT_INTENT_TRACE_MISMATCH',
      }, 400)
    }
    if (draftIntentType && draftPayload) {
      const payloadValidation = validateIntentPayload(draftIntentType, draftPayload)
      if (!payloadValidation.valid) {
        return c.json({
          error: payloadValidation.error ?? 'Invalid draft payload',
          errorCode: 'INVALID_DRAFT_PAYLOAD',
        }, 400)
      }
    }

    const rawParticipants = Array.isArray(raw.participants) ? raw.participants : []
    const participantInputs = rawParticipants.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`participants[${index}] must be an object`)
      }

      const participant = entry as Record<string, unknown>
      const principalId = normalizeOptionalString(participant.principalId)
      if (!principalId) {
        throw new Error(`participants[${index}].principalId is required`)
      }

      const principalType = normalizePrincipalType(participant.principalType)
      if (!principalType) {
        throw new Error(`participants[${index}].principalType is invalid`)
      }

      const role = 'role' in participant ? normalizeThreadParticipantRole(participant.role) : 'participant'
      if ('role' in participant && !role) {
        throw new Error(`participants[${index}].role is invalid`)
      }

      const bindingId = participant.workspaceBindingId == null ? null : Number.parseInt(String(participant.workspaceBindingId), 10)
      if (participant.workspaceBindingId != null && (!Number.isFinite(bindingId) || (bindingId ?? 0) <= 0)) {
        throw new Error(`participants[${index}].workspaceBindingId is invalid`)
      }

      const binding = bindingId ? getWorkspaceIdentityBindingById(db, bindingId) : null
      if (binding && binding.workspace_id !== workspace.id) {
        throw new Error(`participants[${index}].workspaceBindingId does not belong to this workspace`)
      }

      const beamId = normalizeOptionalString(participant.beamId) ?? binding?.beam_id ?? null
      const displayName = normalizeOptionalString(participant.displayName)

      return {
        principalId,
        principalType,
        role: role ?? 'participant',
        workspaceBindingId: binding?.id ?? null,
        beamId,
        displayName,
      }
    })

    let thread: WorkspaceThreadRow
    try {
      thread = createWorkspaceThread(db, {
        workspaceId: workspace.id,
        kind,
        title,
        summary,
        owner,
        status: status ?? 'open',
        workflowType,
        draftIntentType,
        draftPayloadJson: draftPayload ? JSON.stringify(draftPayload) : null,
        linkedIntentNonce,
        lastActivityAt: linkedIntent?.requested_at,
      })

      for (const participant of participantInputs) {
        createWorkspaceThreadParticipant(db, {
          threadId: thread.id,
          principalId: participant.principalId,
          principalType: participant.principalType,
          displayName: participant.displayName,
          beamId: participant.beamId,
          workspaceBindingId: participant.workspaceBindingId,
          role: participant.role,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create workspace thread'
      if (message.includes('participants[')) {
        return c.json({ error: message, errorCode: 'INVALID_THREAD_PARTICIPANT' }, 400)
      }

      console.error('Workspace thread create error:', err)
      return c.json({ error: 'Failed to create workspace thread', errorCode: 'DB_ERROR' }, 500)
    }

    const participants = listWorkspaceThreadParticipants(db, thread.id)
    logAuditEvent(db, {
      action: 'admin.workspace_thread.created',
      actor: auth.session.email,
      target: `${workspace.slug}:${thread.id}`,
      details: {
        role: auth.session.role,
        kind: thread.kind,
        workflowType: thread.workflow_type,
        draftIntentType: thread.draft_intent_type,
        linkedIntentNonce: thread.linked_intent_nonce,
        participants: participants.length,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      thread: serializeWorkspaceThread(db, thread, participants),
      participants: participants.map((row) => serializeWorkspaceThreadParticipant(db, row)),
    }, 201)
  })

  router.post('/:slug/threads/:id/dispatch', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const threadId = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(threadId) || threadId <= 0) {
      return c.json({ error: 'Invalid thread id', errorCode: 'INVALID_THREAD_ID' }, 400)
    }

    const thread = getWorkspaceThreadById(db, threadId)
    if (!thread || thread.workspace_id !== workspace.id) {
      return c.json({ error: 'Workspace thread not found', errorCode: 'NOT_FOUND' }, 404)
    }

    if (thread.kind !== 'handoff') {
      return c.json({ error: 'Only handoff threads can dispatch Beam messages', errorCode: 'THREAD_NOT_HANDOFF' }, 400)
    }

    if (thread.linked_intent_nonce) {
      return c.json({ error: 'This handoff thread is already linked to a Beam trace', errorCode: 'THREAD_ALREADY_LINKED' }, 409)
    }

    if (thread.status === 'closed') {
      return c.json({ error: 'Closed workspace threads cannot dispatch handoffs', errorCode: 'THREAD_CLOSED' }, 409)
    }

    if (workspace.external_handoffs_enabled !== 1) {
      return c.json({ error: 'Workspace external handoffs are disabled', errorCode: 'WORKSPACE_EXTERNAL_DISABLED' }, 409)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      body = {}
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be an object', errorCode: 'INVALID_BODY' }, 400)
    }

    const raw = body as Record<string, unknown>
    const participants = listWorkspaceThreadParticipants(db, thread.id)
    const senderParticipant = participants.find((participant) => (
      participant.workspace_binding_id != null
      && participant.principal_type !== 'partner'
      && typeof participant.beam_id === 'string'
      && participant.beam_id.length > 0
    ))
    if (!senderParticipant?.workspace_binding_id || !senderParticipant.beam_id) {
      return c.json({ error: 'Thread is missing a local workspace identity to send the handoff', errorCode: 'THREAD_MISSING_SENDER' }, 409)
    }

    const senderBinding = getWorkspaceIdentityBindingById(db, senderParticipant.workspace_binding_id)
    if (!senderBinding || senderBinding.workspace_id !== workspace.id || senderBinding.binding_type === 'partner') {
      return c.json({ error: 'Thread sender binding is invalid for this workspace', errorCode: 'INVALID_SENDER_BINDING' }, 409)
    }

    if (senderBinding.status !== 'active') {
      return c.json({ error: 'Thread sender binding is paused', errorCode: 'SENDER_BINDING_PAUSED' }, 409)
    }

    const partnerParticipant = participants.find((participant) => (
      participant.principal_type === 'partner'
      && typeof participant.beam_id === 'string'
      && participant.beam_id.length > 0
    ))
    if (!partnerParticipant?.beam_id) {
      return c.json({ error: 'Thread is missing a partner participant', errorCode: 'THREAD_MISSING_PARTNER' }, 409)
    }

    const partnerChannel = getWorkspacePartnerChannelByBeamId(db, workspace.id, partnerParticipant.beam_id)
    if (!partnerChannel) {
      return c.json({ error: 'Partner participant is not attached to an active workspace partner channel', errorCode: 'PARTNER_CHANNEL_NOT_FOUND' }, 409)
    }

    if (partnerChannel.status === 'blocked') {
      return c.json({ error: 'Partner channel is blocked', errorCode: 'PARTNER_CHANNEL_BLOCKED' }, 409)
    }

    const { policy } = getWorkspacePolicyDocument(db, workspace.id)
    const policyPreview = evaluateWorkspacePolicy(policy, senderBinding, {
      workflowType: thread.workflow_type,
      partnerBeamId: partnerChannel.partner_beam_id,
    })
    if (policyPreview.externalInitiation !== 'allow') {
      return c.json({ error: 'Workspace policy denied this external handoff', errorCode: 'WORKSPACE_POLICY_DENIED' }, 403)
    }

    const fallbackMessage = thread.summary?.trim() || thread.title.trim()
    const requestedIntentType = normalizeOptionalString(raw.intentType)
    const effectiveIntentType = requestedIntentType ?? thread.draft_intent_type ?? 'conversation.message'
    let requestedPayload: Record<string, unknown> | null = null
    try {
      requestedPayload = normalizeOptionalObject(raw.payload, 'payload')
    } catch (err) {
      return c.json({
        error: err instanceof Error ? err.message : 'payload must be an object',
        errorCode: 'INVALID_DISPATCH_PAYLOAD',
      }, 400)
    }
    const storedDraftPayload = requestedIntentType && requestedIntentType !== thread.draft_intent_type
      ? null
      : parseJsonObject(thread.draft_payload_json)
    const message = normalizeOptionalString(raw.message)
    const language = normalizeOptionalString(raw.language)
    let draftPayload = requestedPayload ?? storedDraftPayload
    if (!draftPayload && effectiveIntentType === 'conversation.message') {
      const conversationPayload = isRecord(storedDraftPayload) ? storedDraftPayload : {}
      const resolvedMessage = message
        ?? normalizeOptionalString(conversationPayload.message)
        ?? fallbackMessage
      if (!resolvedMessage) {
        return c.json({ error: 'A message is required to dispatch a conversation.message handoff', errorCode: 'MISSING_HANDOFF_MESSAGE' }, 400)
      }
      draftPayload = {
        ...conversationPayload,
        message: resolvedMessage,
        ...(language
          ? { language }
          : normalizeOptionalString(conversationPayload.language)
            ? { language: normalizeOptionalString(conversationPayload.language) }
            : {}),
      }
    }

    if (!draftPayload) {
      return c.json({
        error: `A payload is required to dispatch intent ${effectiveIntentType}`,
        errorCode: 'MISSING_DISPATCH_PAYLOAD',
      }, 400)
    }

    const workspaceContext = {
      workspace: {
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
      },
      thread: {
        id: thread.id,
        title: thread.title,
        summary: thread.summary,
        workflowType: thread.workflow_type,
        owner: thread.owner,
      },
      approval: {
        action: 'workspace_thread_dispatch',
        approvedBy: auth.session.email,
        approvalRequired: policyPreview.approvalRequired,
        approvers: policyPreview.approvers,
      },
      partnerChannel: {
        id: partnerChannel.id,
        label: partnerChannel.label,
        status: partnerChannel.status,
      },
      participants: participants
        .filter((participant) => participant.beam_id)
        .map((participant) => ({
          beamId: participant.beam_id,
          role: participant.role,
          principalType: participant.principal_type,
        })),
    }
    const payload = effectiveIntentType === 'conversation.message'
      ? {
          ...draftPayload,
          context: {
            ...(isRecord(draftPayload.context) ? draftPayload.context : {}),
            beam: workspaceContext,
          },
        }
      : {
          ...draftPayload,
          beamContext: {
            ...(isRecord(draftPayload.beamContext) ? draftPayload.beamContext : {}),
            ...workspaceContext,
          },
        }
    const payloadValidation = validateIntentPayload(effectiveIntentType, payload)
    if (!payloadValidation.valid) {
      return c.json({
        error: payloadValidation.error ?? 'Invalid payload',
        errorCode: 'INVALID_DISPATCH_PAYLOAD',
      }, 400)
    }

    const nonce = randomUUID()
    const timestamp = new Date().toISOString()
    const frame: IntentFrame = {
      v: '1',
      nonce,
      timestamp,
      from: senderBinding.beam_id,
      to: partnerChannel.partner_beam_id,
      intent: effectiveIntentType,
      payload,
    }

    const finalizeDispatch = (result: {
      nonce: string
      success: boolean
      error: string | null
      errorCode: string | null
    }) => {
      const now = new Date().toISOString()
      const updatedThread = updateWorkspaceThread(db, {
        id: thread.id,
        status: 'open',
        draftIntentType: effectiveIntentType,
        draftPayloadJson: JSON.stringify(draftPayload),
        linkedIntentNonce: result.nonce,
        lastActivityAt: now,
      })
      const updatedChannel = updateWorkspacePartnerChannel(db, {
        id: partnerChannel.id,
        label: partnerChannel.label,
        owner: partnerChannel.owner,
        status: partnerChannel.status,
        notes: partnerChannel.notes,
        lastIntentNonce: result.nonce,
        ...(result.success
          ? { lastSuccessAt: now }
          : { lastFailureAt: now }),
      })

      let workspaceSync: SerializedWorkspaceThreadSync = null
      try {
        workspaceSync = syncRoutedWorkspaceThread(db, {
          actor: auth.session.email,
          actorRole: auth.session.role,
          sourceWorkspace: workspace,
          sourceThread: thread,
          sourceSenderBinding: senderBinding,
          partnerChannel,
          linkedIntentNonce: result.nonce,
          intentType: effectiveIntentType,
          draftPayload,
        })
      } catch (err) {
        console.error('Workspace route sync error:', err)
      }

      logAuditEvent(db, {
        action: 'admin.workspace_thread.dispatched',
        actor: auth.session.email,
        target: `${workspace.slug}:${thread.id}`,
        details: {
          role: auth.session.role,
          linkedIntentNonce: result.nonce,
          workflowType: thread.workflow_type,
          intentType: effectiveIntentType,
          fromBeamId: senderBinding.beam_id,
          toBeamId: partnerChannel.partner_beam_id,
          partnerChannelId: partnerChannel.id,
          approvalRequired: policyPreview.approvalRequired,
          approvers: policyPreview.approvers,
          success: result.success,
          errorCode: result.errorCode,
          workspaceSyncSlug: workspaceSync?.workspaceSlug ?? null,
          workspaceSyncThreadId: workspaceSync?.threadId ?? null,
        },
      })

      const currentThread = updatedThread ?? thread
      const currentParticipants = listWorkspaceThreadParticipants(db, thread.id)

      c.header('Cache-Control', 'no-store')
      return c.json({
        workspace: serializeWorkspace(db, workspace),
        thread: serializeWorkspaceThread(db, currentThread, currentParticipants),
        participants: currentParticipants.map((row) => serializeWorkspaceThreadParticipant(db, row)),
        partnerChannel: updatedChannel
          ? serializeWorkspacePartnerChannel(
            db,
            updatedChannel,
            listWorkspaceIdentityBindings(db, workspace.id)
              .filter((binding) => binding.binding_type !== 'partner')
              .map((binding) => binding.beam_id),
          )
          : null,
        dispatch: {
          nonce: result.nonce,
          intentType: effectiveIntentType,
          success: result.success,
          error: result.error,
          errorCode: result.errorCode,
          traceHref: `/intents/${encodeURIComponent(result.nonce)}`,
        },
        workspaceSync,
      })
    }

    try {
      const workspaceRoute = resolveWorkspacePartnerRoute(db, partnerChannel)
      const result = await relayIntentFromHttp(db, frame, 60_000, {
        trustedControlPlane: true,
        skipLocalAclCheck: workspaceRoute != null,
      })

      return finalizeDispatch({
        nonce,
        success: result.success,
        error: result.error ?? null,
        errorCode: result.errorCode ?? null,
      })
    } catch (err) {
      const loggedIntent = getIntentLogByNonce(db, nonce)
      if (loggedIntent) {
        return finalizeDispatch({
          nonce,
          success: loggedIntent.status === 'acked',
          error: err instanceof Error ? err.message : 'Beam handoff dispatch failed',
          errorCode: err instanceof RelayError ? err.code : loggedIntent.error_code,
        })
      }

      if (err instanceof RelayError) {
        const status = err.code === 'OFFLINE'
          ? 503
          : err.code === 'TIMEOUT'
            ? 504
            : err.code === 'FORBIDDEN'
              ? 403
              : err.code === 'BAD_REQUEST'
                ? 400
                : err.code === 'RATE_LIMITED'
                  ? 429
                  : 502
        return c.json({ error: err.message, errorCode: err.code }, status)
      }

      console.error('Workspace thread dispatch error:', err)
      return c.json({ error: 'Failed to dispatch workspace handoff thread', errorCode: 'DISPATCH_FAILED' }, 500)
    }
  })

  router.get('/:slug/policy', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    c.header('Cache-Control', 'no-store')
    return c.json(buildWorkspacePolicyEnvelope(db, workspace))
  })

  router.patch('/:slug/policy', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
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

    const patch = body as Partial<WorkspacePolicy>
    const result = updateWorkspacePolicyDocument(db, workspace.id, patch, auth.session.email)

    logAuditEvent(db, {
      action: 'admin.workspace_policy.updated',
      actor: auth.session.email,
      target: workspace.slug,
      details: {
        role: auth.session.role,
        defaultExternalInitiation: result.policy.defaults.externalInitiation,
        bindingRules: result.policy.bindingRules.length,
        workflowRules: result.policy.workflowRules.length,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ...buildWorkspacePolicyEnvelope(db, workspace),
      updated: true,
    })
  })

  router.get('/:slug/timeline', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const limit = Math.max(
      1,
      Math.min(
        WORKSPACE_TIMELINE_LIMIT_MAX,
        Number.parseInt(c.req.query('limit') ?? String(WORKSPACE_TIMELINE_LIMIT_DEFAULT), 10) || WORKSPACE_TIMELINE_LIMIT_DEFAULT,
      ),
    )
    const entries = listWorkspaceTimelineEntries(db, workspace, limit)

    c.header('Cache-Control', 'no-store')
    return c.json({
      workspace: serializeWorkspace(db, workspace),
      entries,
      total: entries.length,
    })
  })

  router.get('/:slug/digest', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const days = Math.max(1, Number.parseInt(c.req.query('days') ?? String(WORKSPACE_DIGEST_DEFAULT_DAYS), 10) || WORKSPACE_DIGEST_DEFAULT_DAYS)
    const format = (c.req.query('format') ?? 'json').trim().toLowerCase()
    if (format !== 'json' && format !== 'markdown') {
      return c.json({ error: 'format must be json or markdown', errorCode: 'INVALID_EXPORT_FORMAT' }, 400)
    }

    const digest = buildWorkspaceDigestPayload(db, workspace, days)
    c.header('Cache-Control', 'no-store')

    if (format === 'markdown') {
      const timestamp = new Date().toISOString().replaceAll(':', '-')
      c.header('Content-Type', 'text/markdown; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="beam-workspace-digest-${workspace.slug}-${timestamp}.md"`)
      return c.body(digest.markdown)
    }

    return c.json(digest)
  })

  router.post('/:slug/digest/deliver', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    let body: Record<string, unknown> = {}
    try {
      body = await c.req.json() as Record<string, unknown>
    } catch {
      body = {}
    }

    const days = Math.max(1, Number.parseInt(String(body.days ?? WORKSPACE_DIGEST_DEFAULT_DAYS), 10) || WORKSPACE_DIGEST_DEFAULT_DAYS)
    const requestedEmail = normalizeOptionalString(body.email)
    const targetEmail = requestedEmail ?? auth.session.email

    if (requestedEmail && auth.session.role !== 'admin' && requestedEmail !== auth.session.email) {
      return c.json({ error: 'Only admins can deliver digests to a different mailbox', errorCode: 'FORBIDDEN' }, 403)
    }

    const digest = buildWorkspaceDigestPayload(db, workspace, days)
    const delivered = await sendOperatorDigestEmail({
      email: targetEmail,
      subject: `Beam workspace digest · ${workspace.name} · ${new Date().toISOString().slice(0, 10)}`,
      markdown: digest.markdown,
    })

    if (!delivered) {
      return c.json({ error: 'Operator email delivery is not configured', errorCode: 'EMAIL_DELIVERY_UNAVAILABLE' }, 503)
    }

    logAuditEvent(db, {
      action: 'admin.workspace_digest.delivered',
      actor: auth.session.email,
      target: `${workspace.slug}:digest`,
      details: {
        role: auth.session.role,
        workspace: workspace.slug,
        days,
        deliveredTo: targetEmail,
        actionItems: digest.summary.actionItems,
        escalations: digest.summary.escalations,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({
      ok: true,
      email: targetEmail,
      deliveredAt: new Date().toISOString(),
    })
  })

  router.get('/:slug/identities', (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'viewer')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const rows = listWorkspaceIdentityBindings(db, workspace.id)
    c.header('Cache-Control', 'no-store')
    return c.json({
      workspace: serializeWorkspace(db, workspace),
      bindings: rows.map((row) => serializeWorkspaceIdentityBinding(db, row)),
      total: rows.length,
    })
  })

  router.post('/:slug/identities', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
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
    const beamId = normalizeOptionalString(raw.beamId)
    if (!beamId) {
      return c.json({ error: 'beamId is required', errorCode: 'INVALID_BEAM_ID' }, 400)
    }

    const bindingType = normalizeBindingType(raw.bindingType)
    if (!bindingType) {
      return c.json({ error: 'Invalid bindingType', errorCode: 'INVALID_BINDING_TYPE' }, 400)
    }

    if ((bindingType === 'agent' || bindingType === 'service') && !getAgent(db, beamId)) {
      return c.json({ error: 'Local Beam identity not found', errorCode: 'AGENT_NOT_FOUND' }, 404)
    }

    const owner = normalizeOptionalString(raw.owner)
    const runtimeType = normalizeOptionalString(raw.runtimeType)
    const policyProfile = normalizeOptionalString(raw.policyProfile)
    const defaultThreadScope = 'defaultThreadScope' in raw
      ? normalizeWorkspaceThreadScope(raw.defaultThreadScope)
      : 'internal'
    if ('defaultThreadScope' in raw && !defaultThreadScope) {
      return c.json({ error: 'Invalid defaultThreadScope', errorCode: 'INVALID_WORKSPACE_SCOPE' }, 400)
    }

    const canInitiateExternal = 'canInitiateExternal' in raw
      ? normalizeBoolean(raw.canInitiateExternal)
      : false
    if ('canInitiateExternal' in raw && canInitiateExternal === null) {
      return c.json({ error: 'canInitiateExternal must be boolean', errorCode: 'INVALID_CAN_INITIATE_EXTERNAL' }, 400)
    }

    const status = 'status' in raw ? normalizeBindingStatus(raw.status) : 'active'
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid binding status', errorCode: 'INVALID_BINDING_STATUS' }, 400)
    }

    const notes = normalizeOptionalString(raw.notes)

    try {
      const existing = getWorkspaceIdentityBindingByBeamId(db, workspace.id, beamId)
      if (existing) {
        return c.json({ error: 'Workspace identity already exists', errorCode: 'WORKSPACE_IDENTITY_EXISTS' }, 409)
      }

      const binding = createWorkspaceIdentityBinding(db, {
        workspaceId: workspace.id,
        beamId,
        bindingType,
        owner,
        runtimeType,
        policyProfile,
        defaultThreadScope: defaultThreadScope ?? 'internal',
        canInitiateExternal: canInitiateExternal ?? false,
        status: status ?? 'active',
        notes,
      })

      logAuditEvent(db, {
        action: 'admin.workspace_identity.created',
        actor: auth.session.email,
        target: `${workspace.slug}:${beamId}`,
        details: {
          role: auth.session.role,
          bindingType,
          owner,
          runtimeType,
          canInitiateExternal: binding.can_initiate_external === 1,
          status: binding.status,
        },
      })

      c.header('Cache-Control', 'no-store')
      return c.json({ binding: serializeWorkspaceIdentityBinding(db, binding) }, 201)
    } catch (err) {
      if (isUniqueConstraintError(err, 'workspace_identity_bindings.workspace_id, workspace_identity_bindings.beam_id')) {
        return c.json({ error: 'Workspace identity already exists', errorCode: 'WORKSPACE_IDENTITY_EXISTS' }, 409)
      }

      console.error('Workspace identity create error:', err)
      return c.json({ error: 'Failed to create workspace identity', errorCode: 'DB_ERROR' }, 500)
    }
  })

  router.patch('/:slug/identities/:id', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const bindingId = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(bindingId) || bindingId <= 0) {
      return c.json({ error: 'Invalid identity binding id', errorCode: 'INVALID_BINDING_ID' }, 400)
    }

    const existing = getWorkspaceIdentityBindingById(db, bindingId)
    if (!existing || existing.workspace_id !== workspace.id) {
      return c.json({ error: 'Workspace identity not found', errorCode: 'NOT_FOUND' }, 404)
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
    const owner = 'owner' in raw ? normalizeOptionalString(raw.owner) : existing.owner
    const runtimeType = 'runtimeType' in raw ? normalizeOptionalString(raw.runtimeType) : existing.runtime_type
    const policyProfile = 'policyProfile' in raw ? normalizeOptionalString(raw.policyProfile) : existing.policy_profile
    const defaultThreadScope = 'defaultThreadScope' in raw
      ? normalizeWorkspaceThreadScope(raw.defaultThreadScope)
      : existing.default_thread_scope
    if ('defaultThreadScope' in raw && !defaultThreadScope) {
      return c.json({ error: 'Invalid defaultThreadScope', errorCode: 'INVALID_WORKSPACE_SCOPE' }, 400)
    }

    const canInitiateExternal = 'canInitiateExternal' in raw
      ? normalizeBoolean(raw.canInitiateExternal)
      : existing.can_initiate_external === 1
    if ('canInitiateExternal' in raw && canInitiateExternal === null) {
      return c.json({ error: 'canInitiateExternal must be boolean', errorCode: 'INVALID_CAN_INITIATE_EXTERNAL' }, 400)
    }

    const status = 'status' in raw ? normalizeBindingStatus(raw.status) : existing.status
    if ('status' in raw && !status) {
      return c.json({ error: 'Invalid binding status', errorCode: 'INVALID_BINDING_STATUS' }, 400)
    }

    const notes = 'notes' in raw ? normalizeOptionalString(raw.notes) : existing.notes

    const updated = updateWorkspaceIdentityBinding(db, {
      id: existing.id,
      owner,
      runtimeType,
      policyProfile,
      defaultThreadScope: defaultThreadScope ?? existing.default_thread_scope,
      canInitiateExternal: canInitiateExternal ?? (existing.can_initiate_external === 1),
      status: status ?? existing.status,
      notes,
    })

    if (!updated) {
      return c.json({ error: 'Workspace identity not found', errorCode: 'NOT_FOUND' }, 404)
    }

    logAuditEvent(db, {
      action: 'admin.workspace_identity.updated',
      actor: auth.session.email,
      target: `${workspace.slug}:${existing.beam_id}`,
      details: {
        role: auth.session.role,
        owner,
        runtimeType,
        policyProfile,
        defaultThreadScope: updated.default_thread_scope,
        canInitiateExternal: updated.can_initiate_external === 1,
        status: updated.status,
        notesChanged: 'notes' in raw,
      },
    })

    c.header('Cache-Control', 'no-store')
    return c.json({ binding: serializeWorkspaceIdentityBinding(db, updated) })
  })

  router.patch('/:slug/identities/:id/policy', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'operator')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const bindingId = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(bindingId) || bindingId <= 0) {
      return c.json({ error: 'Invalid identity binding id', errorCode: 'INVALID_BINDING_ID' }, 400)
    }

    const binding = getWorkspaceIdentityBindingById(db, bindingId)
    if (!binding || binding.workspace_id !== workspace.id) {
      return c.json({ error: 'Workspace identity not found', errorCode: 'NOT_FOUND' }, 404)
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
    const externalInitiation = 'externalInitiation' in raw
      ? normalizeExternalInitiationRule(raw.externalInitiation)
      : 'inherit'
    if ('externalInitiation' in raw && !externalInitiation) {
      return c.json({ error: 'Invalid externalInitiation', errorCode: 'INVALID_EXTERNAL_INITIATION' }, 400)
    }

    const allowedPartners = 'allowedPartners' in raw
      ? normalizeStringList(raw.allowedPartners)
      : []
    if ('allowedPartners' in raw && !allowedPartners) {
      return c.json({ error: 'allowedPartners must be an array of strings or a comma-separated string', errorCode: 'INVALID_ALLOWED_PARTNERS' }, 400)
    }

    const currentPolicy = getWorkspacePolicyDocument(db, workspace.id).policy
    const nextBindingRules = currentPolicy.bindingRules.filter((rule) => rule.beamId !== binding.beam_id)

    if ((externalInitiation ?? 'inherit') !== 'inherit' || (allowedPartners?.length ?? 0) > 0) {
      nextBindingRules.push({
        beamId: binding.beam_id,
        bindingType: binding.binding_type,
        policyProfile: binding.policy_profile,
        externalInitiation: externalInitiation ?? 'inherit',
        allowedPartners: allowedPartners ?? [],
      })
    }

    const updatedPolicy = updateWorkspacePolicyDocument(db, workspace.id, {
      bindingRules: nextBindingRules,
    }, auth.session.email)

    logAuditEvent(db, {
      action: 'admin.workspace_identity.policy_updated',
      actor: auth.session.email,
      target: `${workspace.slug}:${binding.beam_id}`,
      details: {
        role: auth.session.role,
        externalInitiation: externalInitiation ?? 'inherit',
        allowedPartners: allowedPartners ?? [],
      },
    })

    const refreshedBinding = getWorkspaceIdentityBindingById(db, binding.id)
    if (!refreshedBinding) {
      return c.json({ error: 'Workspace identity not found', errorCode: 'NOT_FOUND' }, 404)
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      workspace: serializeWorkspace(db, workspace),
      updatedAt: updatedPolicy.updatedAt,
      updatedBy: updatedPolicy.updatedBy,
      rule: [...updatedPolicy.policy.bindingRules]
        .reverse()
        .find((rule) => rule.beamId === binding.beam_id) ?? null,
      preview: buildWorkspacePolicyPreview(updatedPolicy.policy, refreshedBinding),
      binding: serializeWorkspaceIdentityBinding(db, refreshedBinding),
    })
  })

  router.post('/:slug/identities/:id/reissue-local-credential', async (c) => {
    const auth = requireAdminRole(db, c.req.raw, 'admin')
    if (auth instanceof Response) {
      return auth
    }

    const workspace = getWorkspaceBySlug(db, c.req.param('slug'))
    if (!workspace) {
      return c.json({ error: 'Workspace not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const bindingId = Number.parseInt(c.req.param('id'), 10)
    if (!Number.isFinite(bindingId) || bindingId <= 0) {
      return c.json({ error: 'Invalid identity binding id', errorCode: 'INVALID_BINDING_ID' }, 400)
    }

    const binding = getWorkspaceIdentityBindingById(db, bindingId)
    if (!binding || binding.workspace_id !== workspace.id) {
      return c.json({ error: 'Workspace identity not found', errorCode: 'NOT_FOUND' }, 404)
    }

    if (binding.binding_type === 'partner') {
      return c.json({ error: 'Partner bindings do not own local Beam credentials', errorCode: 'PARTNER_BINDING_NO_LOCAL_CREDENTIAL' }, 400)
    }

    const agent = getAgent(db, binding.beam_id)
    if (!agent) {
      return c.json({ error: 'Local Beam identity not found', errorCode: 'AGENT_NOT_FOUND' }, 404)
    }

    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const publicKeyBase64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
    const privateKeyBase64 = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64')
    const apiKey = createAgentApiKey(agent.beam_id)
    const updatedAgent = registerAgent(db, {
      beamId: agent.beam_id,
      displayName: agent.display_name,
      capabilities: JSON.parse(agent.capabilities) as string[],
      publicKey: publicKeyBase64,
      apiKeyHash: hashApiKey(apiKey),
      org: agent.org,
      personal: agent.personal === 1,
      email: agent.email,
      emailVerified: agent.email_verified === 1,
      description: agent.description,
      logoUrl: agent.logo_url,
      website: agent.website,
      verificationTier: agent.verification_tier,
      visibility: agent.visibility,
      httpEndpoint: agent.http_endpoint,
      dhPublicKey: agent.dh_public_key,
    })

    logAuditEvent(db, {
      action: 'admin.workspace_identity.credential_reissued',
      actor: auth.session.email,
      target: `${workspace.slug}:${binding.beam_id}`,
      details: {
        role: auth.session.role,
        did: toBeamDID(binding.beam_id),
        workspace: workspace.slug,
      },
    })

    const refreshedBinding = getWorkspaceIdentityBindingById(db, binding.id)
    if (!refreshedBinding) {
      return c.json({ error: 'Workspace identity not found', errorCode: 'NOT_FOUND' }, 404)
    }

    const urls = buildWorkspaceIdentityDid(updatedAgent.beam_id)
    const credential: SerializedWorkspaceIdentityCredential = {
      format: 'beam-local-identity/v1',
      beamId: updatedAgent.beam_id,
      did: urls.id,
      displayName: updatedAgent.display_name,
      workspaceSlug: workspace.slug,
      directoryUrl: getDirectoryBaseUrl(),
      generatedAt: new Date().toISOString(),
      publicKey: publicKeyBase64,
      privateKey: privateKeyBase64,
      apiKey,
      urls: {
        didResolution: urls.resolutionUrl,
        agent: urls.agentUrl,
        keys: urls.keysUrl,
      },
    }

    c.header('Cache-Control', 'no-store')
    return c.json({
      binding: serializeWorkspaceIdentityBinding(db, refreshedBinding),
      credential,
    })
  })

  return router
}
