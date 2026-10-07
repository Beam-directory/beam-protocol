import { CheckIcon } from 'lucide-react'
import { cn } from 'cn'

export interface StepMeta {
  id: string
  title: string
  short: string
}

/**
 * Progress indicator. Steps the user has reached are buttons (keyboard reachable); later steps are inert.
 * On narrow screens only the current step label is shown next to the counter.
 */
export function Stepper({
  steps, current, maxReached, completed, onSelect,
}: {
  steps: StepMeta[]
  current: number
  maxReached: number
  completed: boolean[]
  onSelect: (index: number) => void
}) {
  const percent = Math.round(((current + 1) / steps.length) * 100)
  return (
    <nav aria-label="Fortschritt der Einrichtung" className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground sm:hidden">
        <span>Schritt {current + 1} von {steps.length}</span>
        <span className="font-medium text-foreground">{steps[current]?.title}</span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-muted sm:hidden"
        role="progressbar"
        aria-label="Fortschritt"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={current + 1}
        aria-valuetext={`Schritt ${current + 1} von ${steps.length}`}
      >
        <div className="h-full rounded-full bg-gradient-to-r from-beam to-beam-2 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      </div>
      <ol className="hidden grid-cols-4 gap-2 sm:grid">
        {steps.map((step, index) => {
          const reachable = index <= maxReached
          const active = index === current
          const done = completed[index]
          return (
            <li key={step.id} className="flex flex-col gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'h-1 rounded-full transition-colors duration-500 motion-reduce:transition-none',
                  index <= current ? 'bg-gradient-to-r from-beam to-beam-2' : 'bg-muted',
                )}
              />
              <button
                type="button"
                disabled={!reachable}
                onClick={() => onSelect(index)}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md text-left text-sm transition-colors disabled:cursor-not-allowed',
                  active ? 'text-foreground' : reachable ? 'text-muted-foreground hover:text-foreground' : 'text-muted-foreground/60',
                )}
              >
                <span
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]',
                    done ? 'border-success/40 bg-success/15 text-success' : active ? 'border-beam bg-beam/10 text-foreground' : 'bg-background',
                  )}
                >
                  {done ? <CheckIcon aria-hidden="true" className="size-3" strokeWidth={3} /> : index + 1}
                </span>
                <span className="truncate font-medium">{step.short}</span>
                <span className="sr-only">{done ? ', erledigt' : active ? ', aktueller Schritt' : ''}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
