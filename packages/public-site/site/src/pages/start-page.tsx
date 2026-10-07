import { useEffect, useRef, useState } from 'react'
import { ArrowLeftIcon, ArrowRightIcon, BuildingIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Stepper, type StepMeta } from '@/components/onboarding/stepper'
import { StepAgent } from '@/components/onboarding/step-agent'
import { StepFirma } from '@/components/onboarding/step-firma'
import { StepPerson } from '@/components/onboarding/step-person'
import { StepVerbinden } from '@/components/onboarding/step-verbinden'
import { EMPTY_SECRETS, type OnboardingSecrets } from '@/components/onboarding/types'
import {
  INITIAL_PROGRESS,
  STEP_IDS,
  canAdvance,
  clearProgress,
  loadProgress,
  saveProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-steps'

const STEPS: (StepMeta & { lead: string })[] = [
  { id: 'firma', short: 'Firma', title: 'Firma verifizieren', lead: 'Domain per DNS bestätigen und Registerangaben hinterlegen. Das passiert einmal pro Firma.' },
  { id: 'person', short: 'Person', title: 'Person und Konto', lead: 'Wer die Firma vertritt, wird einmal geprüft. Mitarbeitende kommen später dazu.' },
  { id: 'agent', short: 'Agent', title: 'Ersten Agenten anlegen', lead: 'Eigene Beam-ID, eigenes Schlüsselpaar aus deinem Browser und eine Vollmacht.' },
  { id: 'verbinden', short: 'Verbinden', title: 'Verbinden', lead: 'Assistent anbinden und die erste Kontaktanfrage senden.' },
]

export function StartPage() {
  const [progress, setProgress] = useState<OnboardingProgress>(() => loadProgress())
  const [secrets, setSecretsState] = useState<OnboardingSecrets>(EMPTY_SECRETS)
  const [maxReached, setMaxReached] = useState(() => loadProgress().step)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const firstRender = useRef(true)

  const step = progress.step
  const stepId = STEP_IDS[step] ?? 'firma'
  const meta = STEPS[step] ?? STEPS[0]
  const gate = canAdvance(stepId, {
    orgVerified: progress.orgVerified,
    orgKeyInMemory: Boolean(secrets.orgApiKey),
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
  const unsavedSecret = Boolean((secrets.orgApiKey && !secrets.orgKeySaved) || (secrets.agentApiKey && !secrets.kitSaved))
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
    if (!window.confirm('Einrichtung neu beginnen? Nicht gesicherte Schlüssel in diesem Tab gehen verloren.')) return
    clearProgress()
    setSecretsState(EMPTY_SECRETS)
    setProgress({ ...INITIAL_PROGRESS })
    setMaxReached(0)
  }

  const completed = [progress.orgVerified, false, Boolean(progress.registeredBeamId), false]

  return (
    <div className="relative isolate">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[28rem] overflow-hidden">
        <div className="beam-grid absolute inset-0" />
        <div className="beam-glow absolute inset-x-0 -top-32 h-96 opacity-60" />
      </div>

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pt-10 pb-20 sm:px-6 sm:pt-14">
        <header className="flex flex-col gap-5">
          <p className="text-sm font-medium text-beam">Einrichtung</p>
          <h1 className="text-[2rem] leading-[1.08] font-semibold tracking-[-0.04em] text-balance sm:text-5xl">Agent verbinden</h1>
          <div className="beam-surface flex flex-col gap-4 rounded-2xl border p-4 sm:flex-row sm:items-center sm:gap-5 sm:p-5">
            <div aria-hidden="true" className="flex shrink-0 items-center gap-1.5">
              <span className="flex size-9 items-center justify-center rounded-lg border bg-background"><BuildingIcon className="size-4" /></span>
              <span className="h-px w-4 bg-gradient-to-r from-beam to-beam-2" />
              <span className="flex size-9 items-center justify-center rounded-lg border bg-background"><ShieldCheckIcon className="size-4 text-beam" /></span>
              <span className="h-px w-4 bg-gradient-to-r from-beam to-beam-2" />
              <span className="flex size-9 items-center justify-center rounded-lg border bg-background"><SparklesIcon className="size-4" /></span>
            </div>
            <p className="text-[15px] leading-7 text-pretty">
              <strong className="font-semibold">Einmal Firma und Person verifizieren.</strong>{' '}
              <span className="text-muted-foreground">Agenten erben das Vertrauen und werden von dir ausgestellt. Kein KYC pro Agent.</span>
            </p>
          </div>
        </header>

        <Stepper steps={STEPS} current={step} maxReached={maxReached} completed={completed} onSelect={goTo} />

        <section aria-labelledby="step-title" className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <p className="hidden font-mono text-xs text-muted-foreground sm:block">Schritt {step + 1} von {STEPS.length}</p>
            <h2 id="step-title" ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-[-0.03em] outline-none sm:text-3xl">
              {meta.title}
            </h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">{meta.lead}</p>
          </div>

          {stepId === 'firma' ? <StepFirma progress={progress} update={update} secrets={secrets} setSecrets={setSecrets} /> : null}
          {stepId === 'person' ? <StepPerson progress={progress} /> : null}
          {stepId === 'agent' ? <StepAgent progress={progress} update={update} secrets={secrets} setSecrets={setSecrets} /> : null}
          {stepId === 'verbinden' ? <StepVerbinden progress={progress} secrets={secrets} /> : null}
        </section>

        <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-border/60 bg-background/85 px-4 py-3 backdrop-blur-xl sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none">
          {!gate.ok ? <p className="text-xs text-muted-foreground" role="status">{gate.reason}</p> : null}
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" className="h-10 rounded-full px-4" onClick={() => goTo(step - 1)} disabled={step === 0}>
              <ArrowLeftIcon aria-hidden="true" /> Zurück
            </Button>
            {step < STEPS.length - 1 ? (
              <Button type="button" className="h-10 rounded-full px-5" onClick={() => goTo(step + 1)} disabled={!gate.ok}>
                Weiter <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
              </Button>
            ) : (
              <Button type="button" variant="outline" className="h-10 rounded-full px-4" onClick={restart}>
                Neu beginnen
              </Button>
            )}
          </div>
        </div>

        <p className="text-xs leading-5 text-muted-foreground">
          Gespeichert wird in diesem Browser nur der Fortschritt dieser Sitzung (sessionStorage), nie ein Schlüssel. Org-Schlüssel, Agenten-Schlüssel und
          private Schlüssel bleiben im Arbeitsspeicher dieses Tabs, bis du sie selbst als Datei sicherst.
        </p>
      </div>
    </div>
  )
}
