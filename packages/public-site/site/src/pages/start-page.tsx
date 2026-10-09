import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Stepper, type StepMeta } from '@/components/onboarding/stepper'
import { StepAgent } from '@/components/onboarding/step-agent'
import { StepFirma } from '@/components/onboarding/step-firma'
import { StepIndividualAddress } from '@/components/onboarding/step-individual-address'
import { StepIndividualAgent } from '@/components/onboarding/step-individual-agent'
import { StepIndividualIdentity } from '@/components/onboarding/step-individual-identity'
import { StepPath } from '@/components/onboarding/step-path'
import { StepPerson } from '@/components/onboarding/step-person'
import { StepVerbinden } from '@/components/onboarding/step-verbinden'
import { EMPTY_SECRETS, type OnboardingSecrets } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import {
  INDIVIDUAL_STEP_IDS,
  INITIAL_PROGRESS,
  STEP_IDS,
  canAdvance,
  canAdvanceIndividual,
  clearProgress,
  loadProgress,
  saveProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-steps'

/**
 * /start and /de/start render this component at the same position in the tree, so switching the language keeps the
 * in-memory secrets (React reuses the instance because the element type is the same).
 */
function previewProgress(loaded: OnboardingProgress): OnboardingProgress {
  if (!import.meta.env.DEV || typeof window === 'undefined') return loaded
  const params = new URLSearchParams(window.location.search)
  const path = params.get('path')
  const stepRaw = params.get('step')
  const step = stepRaw && /^\d$/.test(stepRaw) ? Number(stepRaw) : 0
  if (path === 'choose') return { ...loaded, path: '', step: 0 }
  if (path === 'individual' || path === 'organization') return { ...loaded, path, step }
  return loaded
}

export function StartPage() {
  const { t } = useI18n()
  const copy = t.onboarding
  const [progress, setProgress] = useState<OnboardingProgress>(() => previewProgress(loadProgress()))
  const [secrets, setSecretsState] = useState<OnboardingSecrets>(EMPTY_SECRETS)
  const [maxReached, setMaxReached] = useState(() => loadProgress().step)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const firstRender = useRef(true)

  const individual = progress.path === 'individual'
  const STEPS: (StepMeta & { lead: string })[] = individual ? copy.individualSteps : copy.steps
  const step = progress.step
  const stepId = individual ? (INDIVIDUAL_STEP_IDS[step] ?? 'address') : (STEP_IDS[step] ?? 'firma')
  const meta = STEPS[step] ?? STEPS[0]
  const gate = individual
    ? canAdvanceIndividual(stepId as (typeof INDIVIDUAL_STEP_IDS)[number], {
        addressReady: Boolean(progress.personId),
        identityVerified: progress.personKycStatus === 'verified',
        agentRegistered: Boolean(progress.registeredBeamId),
      })
    : canAdvance(stepId as (typeof STEP_IDS)[number], {
        orgVerified: progress.orgVerified,
        orgKeyInMemory: Boolean(secrets.orgApiKey),
        personReady: Boolean(progress.personId),
        agentRegistered: Boolean(progress.registeredBeamId),
      })

  const update = (patch: Partial<OnboardingProgress>) => setProgress((current) => ({ ...current, ...patch }))
  const setSecrets = (patch: Partial<OnboardingSecrets>) => setSecretsState((current) => ({ ...current, ...patch }))

  // sessionStorage is the external system here; only non-secret fields are written (see onboarding-steps.ts).
  useEffect(() => {
    saveProgress(progress)
  }, [progress])

  // Move focus to the step heading after navigation so keyboard and screen reader users land on the new step.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    headingRef.current?.focus()
  }, [step])

  // Warn before leaving while a one-time secret has not been saved yet.
  const unsavedSecret = Boolean(
    (secrets.orgApiKey && !secrets.orgKeySaved)
    || (secrets.personApiKey && !secrets.personKeySaved)
    || (secrets.personIdentity && !secrets.personKeySaved)
    || (secrets.agentApiKey && !secrets.kitSaved),
  )
  useEffect(() => {
    if (!unsavedSecret) return undefined
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [unsavedSecret])

  function goTo(index: number) {
    const next = Math.min(Math.max(index, 0), STEPS.length - 1)
    update({ step: next })
    setMaxReached((current) => Math.max(current, next))
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  function restart() {
    if (!window.confirm(copy.restartConfirm)) return
    clearProgress()
    setSecretsState(EMPTY_SECRETS)
    setProgress({ ...INITIAL_PROGRESS })
    setMaxReached(0)
  }

  // The step's own button is the primary action until it is done; only then does "Next" appear.
  const isLast = step === STEPS.length - 1
  const showBack = step > 0
  const showNext = !isLast && gate.ok
  const completed = individual
    ? [Boolean(progress.personId), progress.personKycStatus === 'verified', Boolean(progress.registeredBeamId), Boolean(progress.mandateJti)]
    : [progress.orgVerified, Boolean(progress.personId), Boolean(progress.registeredBeamId), Boolean(progress.mandateJti)]

  if (progress.path === '') {
    return (
      <div className="relative isolate" data-testid="onboarding-root" data-path="choose" data-step="choose">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pt-10 pb-20 sm:px-6 sm:pt-14">
          <header className="flex flex-col gap-3">
            <h1 className="text-[2rem] leading-[1.08] font-semibold tracking-[-0.04em] text-balance sm:text-5xl">{copy.path.title}</h1>
            <p className="max-w-2xl text-base leading-7 text-muted-foreground">{copy.path.lead}</p>
          </header>
          <StepPath onChoose={(path) => {
            update({ path, step: 0 })
            setMaxReached(0)
          }} />
        </div>
      </div>
    )
  }

  return (
    <div className="relative isolate" data-testid="onboarding-root" data-path={progress.path} data-step={stepId}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28rem] overflow-hidden">
        <div className="beam-grid absolute inset-0" />
        <div className="beam-glow absolute inset-x-0 -top-32 h-96 opacity-60" />
      </div>

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pt-10 pb-20 sm:px-6 sm:pt-14">
        <header className="flex flex-col gap-3">
          <h1 className="text-[2rem] leading-[1.08] font-semibold tracking-[-0.04em] text-balance sm:text-5xl">{copy.title}</h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">{individual ? copy.individualLead : copy.lead}</p>
        </header>

        <Stepper steps={STEPS} current={step} maxReached={maxReached} completed={completed} onSelect={goTo} />

        <section aria-labelledby="step-title" className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h2 id="step-title" ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-[-0.03em] outline-none sm:text-3xl">
              {meta.title}
            </h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">{meta.lead}</p>
          </div>

          {progress.path === 'organization' && stepId === 'firma' ? <StepFirma progress={progress} update={update} secrets={secrets} setSecrets={setSecrets} /> : null}
          {progress.path === 'organization' && stepId === 'person' ? <StepPerson progress={progress} update={update} secrets={secrets} setSecrets={setSecrets} /> : null}
          {progress.path === 'organization' && stepId === 'agent' ? <StepAgent progress={progress} update={update} secrets={secrets} setSecrets={setSecrets} /> : null}
          {progress.path === 'individual' && stepId === 'address' ? <StepIndividualAddress progress={progress} update={update} secrets={secrets} setSecrets={setSecrets} /> : null}
          {progress.path === 'individual' && stepId === 'identity' ? <StepIndividualIdentity progress={progress} update={update} secrets={secrets} setSecrets={setSecrets} /> : null}
          {progress.path === 'individual' && stepId === 'agent' ? <StepIndividualAgent progress={progress} update={update} secrets={secrets} setSecrets={setSecrets} /> : null}
          {stepId === 'verbinden' ? <StepVerbinden progress={progress} secrets={secrets} /> : null}
        </section>

        {showBack || showNext || isLast ? (
          <div className="sticky bottom-0 z-10 -mx-4 flex items-center justify-between gap-3 border-t border-border/60 bg-background/85 px-4 py-3 backdrop-blur-xl sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none">
            {showBack ? (
              <Button type="button" variant="ghost" className="h-10 rounded-full px-4" onClick={() => goTo(step - 1)}>
                <ArrowLeftIcon aria-hidden="true" /> {copy.back}
              </Button>
            ) : <span />}
            {showNext ? (
              <Button id="next-step" type="button" className="h-10 rounded-full px-5" onClick={() => goTo(step + 1)}>
                {copy.next} <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
              </Button>
            ) : isLast ? (
              <Button type="button" variant="outline" className="h-10 rounded-full px-4" onClick={restart}>
                {copy.restart}
              </Button>
            ) : null}
          </div>
        ) : null}

        <p className="text-xs leading-5 text-muted-foreground">{copy.storageNote}</p>
      </div>
    </div>
  )
}
