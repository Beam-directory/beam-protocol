import type { AgentIdentity } from '@/lib/agent-keys'
import type { OnboardingProgress } from '@/lib/onboarding-steps'

/** Secrets of the current tab. Held in React state only: never written to any storage. */
export interface OnboardingSecrets {
  orgApiKey: string | null
  orgKeySaved: boolean
  identity: AgentIdentity | null
  agentApiKey: string | null
  kitSaved: boolean
}

export const EMPTY_SECRETS: OnboardingSecrets = {
  orgApiKey: null,
  orgKeySaved: false,
  identity: null,
  agentApiKey: null,
  kitSaved: false,
}

export interface StepProps {
  progress: OnboardingProgress
  update: (patch: Partial<OnboardingProgress>) => void
  secrets: OnboardingSecrets
  setSecrets: (patch: Partial<OnboardingSecrets>) => void
}
