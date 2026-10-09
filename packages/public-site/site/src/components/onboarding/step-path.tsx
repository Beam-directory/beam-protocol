import { BuildingIcon, UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/context'
import type { OnboardingPath } from '@/lib/onboarding-steps'

export function StepPath({ onChoose }: { onChoose: (path: Exclude<OnboardingPath, ''>) => void }) {
  const { t } = useI18n()
  const copy = t.onboarding.path
  return (
    <div data-testid="onboarding-path" className="grid gap-4 sm:grid-cols-2">
      <section className="beam-surface flex flex-col gap-4 rounded-2xl border p-5">
        <span className="flex size-10 items-center justify-center rounded-lg border bg-background">
          <BuildingIcon aria-hidden="true" className="size-4" />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">{copy.companyTitle}</h2>
          <p className="text-sm leading-6 text-muted-foreground">{copy.companyText}</p>
        </div>
        <Button type="button" data-testid="path-company" className="mt-auto h-10 rounded-full" onClick={() => onChoose('organization')}>
          {copy.companyAction}
        </Button>
      </section>
      <section className="beam-surface flex flex-col gap-4 rounded-2xl border p-5">
        <span className="flex size-10 items-center justify-center rounded-lg border bg-background">
          <UserIcon aria-hidden="true" className="size-4 text-beam" />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">{copy.individualTitle}</h2>
          <p className="text-sm leading-6 text-muted-foreground">{copy.individualText}</p>
        </div>
        <Button type="button" data-testid="path-individual" variant="outline" className="mt-auto h-10 rounded-full" onClick={() => onChoose('individual')}>
          {copy.individualAction}
        </Button>
      </section>
    </div>
  )
}
