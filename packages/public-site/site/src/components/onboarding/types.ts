import type { AgentIdentity, SigningIdentity } from '@/lib/agent-keys'
import type { OnboardingProgress } from '@/lib/onboarding-steps'

/** Secrets of the current tab. Held in React state only: never written to any storage. */
export interface OnboardingSecrets {
  orgApiKey: string | null
  orgKeySaved: boolean
  personIdentity: SigningIdentity | null
  personKeySaved: boolean
  /** One-time person API key. Memory only, never sessionStorage. */
  personApiKey: string | null
  /** One-time employee invitation token. Shown once, never stored. */
  invitationToken: string | null
  identity: AgentIdentity | null
  agentApiKey: string | null
  kitSaved: boolean
}

export const EMPTY_SECRETS: OnboardingSecrets = {
  orgApiKey: null,
  orgKeySaved: false,
  personIdentity: null,
  personKeySaved: false,
  personApiKey: null,
  invitationToken: null,
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
