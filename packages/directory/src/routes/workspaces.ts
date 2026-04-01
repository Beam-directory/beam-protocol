import { Hono } from 'hono'
import type { Database } from 'better-sqlite3'
import { requireAdminRole } from '../admin-auth.js'
import {
  createWorkspace,
  createWorkspaceIdentityBinding,
  createWorkspaceThread,
  createWorkspaceThreadParticipant,
  getAgent,
  getIntentLogByNonce,
  getOrg,
  getWorkspaceBySlug,
  getWorkspaceIdentityBindingByBeamId,
  getWorkspaceIdentityBindingById,
  getWorkspacePolicyDocument,
  getWorkspaceSummary,
  getWorkspaceThreadById,
  listAgentKeys,
  listWorkspaceIdentityBindings,
  listWorkspaceThreadParticipants,
  listWorkspaceThreads,
  listWorkspaces,
  logAuditEvent,
  updateWorkspacePolicyDocument,
  updateWorkspaceIdentityBinding,
} from '../db.js'
import type {
  IntentLogRow,
  WorkspaceIdentityBindingRow,
  WorkspaceIdentityBindingStatus,
  WorkspaceIdentityBindingType,
  WorkspacePolicy,
  WorkspacePrincipalType,
  WorkspaceRow,
  WorkspaceThreadKind,
  WorkspaceThreadParticipantRole,
  WorkspaceThreadScope,
  WorkspaceThreadStatus,
  WorkspaceThreadParticipantRow,
  WorkspaceThreadRow,
} from '../types.js'
import { serializeAgentKeyState } from '../utils/serialize.js'
import { evaluateWorkspacePolicy } from '../workspace-policy.js'

const WORKSPACE_STATUS_SET = new Set<WorkspaceRow['status']>(['active', 'paused', 'archived'])
const WORKSPACE_THREAD_SCOPE_SET = new Set<WorkspaceThreadScope>(['internal', 'handoff'])
const WORKSPACE_BINDING_TYPE_SET = new Set<WorkspaceIdentityBindingType>(['agent', 'service', 'partner'])
const WORKSPACE_BINDING_STATUS_SET = new Set<WorkspaceIdentityBindingStatus>(['active', 'paused'])
const WORKSPACE_THREAD_KIND_SET = new Set<WorkspaceThreadKind>(['internal', 'handoff'])
const WORKSPACE_THREAD_STATUS_SET = new Set<WorkspaceThreadStatus>(['open', 'blocked', 'closed'])
const WORKSPACE_THREAD_PARTICIPANT_ROLE_SET = new Set<WorkspaceThreadParticipantRole>(['owner', 'participant', 'observer', 'approver'])
const WORKSPACE_PRINCIPAL_TYPE_SET = new Set<WorkspacePrincipalType>(['human', 'agent', 'service', 'partner'])
const WORKSPACE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const WORKSPACE_OVERVIEW_STALE_AFTER_HOURS = 24
const WORKSPACE_OVERVIEW_RECENT_HANDOFF_LIMIT = 8
const WORKSPACE_OVERVIEW_INTENT_SCAN_LIMIT = 96

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
  identity: {
    existsLocally: boolean
    beamId: string
    displayName: string | null
    org: string | null
    personal: boolean
    verificationTier: string | null
    trustScore: number | null
    lastSeen: string | null
    capabilities: string[]
    keyState: object | null
  }
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

function normalizeWorkspaceSlug(value: unknown, fallback: string): string | null {
  const candidate = typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : slugify(fallback)
  if (!candidate || !WORKSPACE_SLUG_RE.test(candidate)) {
    return null
  }

  return candidate
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
  const keyState = agent ? serializeAgentKeyState(listAgentKeys(db, row.beam_id)) : null

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
    identity: agent ? {
      existsLocally: true,
      beamId: agent.beam_id,
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
      displayName: null,
      org: null,
      personal: false,
      verificationTier: null,
      trustScore: null,
      lastSeen: null,
      capabilities: [],
      keyState,
    },
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
    const linkedIntentNonce = normalizeOptionalString(raw.linkedIntentNonce)
    if (kind === 'handoff' && !linkedIntentNonce) {
      return c.json({ error: 'linkedIntentNonce is required for handoff threads', errorCode: 'MISSING_THREAD_NONCE' }, 400)
    }
    if (kind === 'internal' && linkedIntentNonce) {
      return c.json({ error: 'Internal threads cannot link directly to a Beam trace', errorCode: 'INTERNAL_THREAD_CANNOT_LINK_TRACE' }, 400)
    }

    const linkedIntent = linkedIntentNonce ? getIntentLogByNonce(db, linkedIntentNonce) : null
    if (linkedIntentNonce && !linkedIntent) {
      return c.json({ error: 'linkedIntentNonce was not found', errorCode: 'INTENT_NOT_FOUND' }, 404)
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

  return router
}
