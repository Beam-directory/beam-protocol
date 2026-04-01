import type {
  WorkspaceIdentityBindingRow,
  WorkspacePolicy,
  WorkspacePolicyBindingRule,
  WorkspacePolicyDefaultExternalInitiation,
  WorkspacePolicyRuleExternalInitiation,
  WorkspacePolicyWorkflowRule,
} from './types.js'
import { matchesBeamPattern } from './shield/policies.js'

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  version: 1,
  defaults: {
    externalInitiation: 'binding',
    allowedPartners: [],
  },
  bindingRules: [],
  workflowRules: [],
  metadata: {
    notes: null,
  },
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )]
}

function sanitizeNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function sanitizeDefaultExternalInitiation(value: unknown): WorkspacePolicyDefaultExternalInitiation {
  return value === 'deny' ? 'deny' : 'binding'
}

function sanitizeRuleExternalInitiation(value: unknown): WorkspacePolicyRuleExternalInitiation {
  if (value === 'allow' || value === 'deny') {
    return value
  }

  return 'inherit'
}

function parseBindingRule(raw: unknown): WorkspacePolicyBindingRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const input = raw as Record<string, unknown>
  const beamId = sanitizeNullableString(input.beamId)
  const bindingType = input.bindingType === 'agent' || input.bindingType === 'service' || input.bindingType === 'partner'
    ? input.bindingType
    : null
  const policyProfile = sanitizeNullableString(input.policyProfile)?.toLowerCase() ?? null

  if (!beamId && !bindingType && !policyProfile) {
    return null
  }

  return {
    beamId,
    bindingType,
    policyProfile,
    externalInitiation: sanitizeRuleExternalInitiation(input.externalInitiation),
    allowedPartners: sanitizeStringList(input.allowedPartners),
  }
}

function parseWorkflowRule(raw: unknown): WorkspacePolicyWorkflowRule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const input = raw as Record<string, unknown>
  const workflowType = sanitizeNullableString(input.workflowType)
  if (!workflowType) {
    return null
  }

  return {
    workflowType,
    requireApproval: input.requireApproval === true,
    allowedPartners: sanitizeStringList(input.allowedPartners),
    approvers: sanitizeStringList(input.approvers),
  }
}

export function parseWorkspacePolicy(raw: string | null | undefined): WorkspacePolicy {
  if (!raw) {
    return structuredClone(DEFAULT_WORKSPACE_POLICY)
  }

  try {
    const parsed = JSON.parse(raw) as Partial<WorkspacePolicy>
    return {
      version: 1,
      defaults: {
        externalInitiation: sanitizeDefaultExternalInitiation(parsed.defaults?.externalInitiation),
        allowedPartners: sanitizeStringList(parsed.defaults?.allowedPartners),
      },
      bindingRules: Array.isArray(parsed.bindingRules)
        ? parsed.bindingRules.map(parseBindingRule).filter((rule): rule is WorkspacePolicyBindingRule => Boolean(rule))
        : [],
      workflowRules: Array.isArray(parsed.workflowRules)
        ? parsed.workflowRules.map(parseWorkflowRule).filter((rule): rule is WorkspacePolicyWorkflowRule => Boolean(rule))
        : [],
      metadata: {
        notes: sanitizeNullableString(parsed.metadata?.notes),
      },
    }
  } catch {
    return structuredClone(DEFAULT_WORKSPACE_POLICY)
  }
}

export function mergeWorkspacePolicy(current: WorkspacePolicy, patch: Partial<WorkspacePolicy>): WorkspacePolicy {
  return parseWorkspacePolicy(JSON.stringify({
    ...current,
    ...patch,
    defaults: {
      ...current.defaults,
      ...patch.defaults,
    },
    metadata: {
      ...current.metadata,
      ...patch.metadata,
    },
    bindingRules: patch.bindingRules ?? current.bindingRules,
    workflowRules: patch.workflowRules ?? current.workflowRules,
  }))
}

function matchesBindingRule(rule: WorkspacePolicyBindingRule, binding: WorkspaceIdentityBindingRow): boolean {
  if (rule.beamId && rule.beamId !== binding.beam_id) {
    return false
  }

  if (rule.bindingType && rule.bindingType !== binding.binding_type) {
    return false
  }

  if (rule.policyProfile && rule.policyProfile !== (binding.policy_profile?.trim().toLowerCase() ?? null)) {
    return false
  }

  return true
}

function mergeAllowedPartners(...sets: string[][]): string[] {
  return [...new Set(sets.flat().filter(Boolean))]
}

export interface WorkspacePolicyEvaluation {
  beamId: string
  bindingType: WorkspaceIdentityBindingRow['binding_type']
  policyProfile: string | null
  externalInitiation: 'allow' | 'deny'
  allowedPartners: string[]
  approvalRequired: boolean
  approvers: string[]
  matchedBindingRules: number
  matchedWorkflowRules: number
}

export function evaluateWorkspacePolicy(
  policy: WorkspacePolicy,
  binding: WorkspaceIdentityBindingRow,
  options: {
    workflowType?: string | null
    partnerBeamId?: string | null
  } = {},
): WorkspacePolicyEvaluation {
  const matchedBindingRules = policy.bindingRules.filter((rule) => matchesBindingRule(rule, binding))
  const matchedWorkflowRules = (options.workflowType
    ? policy.workflowRules.filter((rule) => rule.workflowType === options.workflowType)
    : [])

  let externalInitiation: 'allow' | 'deny'
  if (policy.defaults.externalInitiation === 'deny') {
    externalInitiation = 'deny'
  } else {
    externalInitiation = binding.can_initiate_external === 1 ? 'allow' : 'deny'
  }

  let allowedPartners = [...policy.defaults.allowedPartners]

  for (const rule of matchedBindingRules) {
    if (rule.externalInitiation === 'allow') {
      externalInitiation = 'allow'
    } else if (rule.externalInitiation === 'deny') {
      externalInitiation = 'deny'
    }
    allowedPartners = mergeAllowedPartners(allowedPartners, rule.allowedPartners)
  }

  let approvalRequired = false
  let approvers: string[] = []
  for (const rule of matchedWorkflowRules) {
    approvalRequired = approvalRequired || rule.requireApproval
    approvers = mergeAllowedPartners(approvers, rule.approvers)
    allowedPartners = mergeAllowedPartners(allowedPartners, rule.allowedPartners)
  }

  if (options.partnerBeamId && allowedPartners.length > 0 && !matchesBeamPattern(options.partnerBeamId, allowedPartners)) {
    externalInitiation = 'deny'
  }

  return {
    beamId: binding.beam_id,
    bindingType: binding.binding_type,
    policyProfile: binding.policy_profile,
    externalInitiation,
    allowedPartners,
    approvalRequired,
    approvers,
    matchedBindingRules: matchedBindingRules.length,
    matchedWorkflowRules: matchedWorkflowRules.length,
  }
}
