import type { CSSProperties } from 'react'
import { BotIcon, BuildingIcon, CheckIcon, FileTextIcon, KeyRoundIcon, LockIcon, ScrollTextIcon, UserIcon } from 'lucide-react'
import { cn } from 'cn'

const chain = [
  { icon: BuildingIcon, label: 'Firma', detail: 'Firma A GmbH', delay: '4.4s' },
  { icon: UserIcon, label: 'Mensch', detail: 'Leitung Vertrieb', delay: '4.9s' },
  { icon: ScrollTextIcon, label: 'Vollmacht', detail: 'Angebote senden', delay: '5.4s' },
]

function delay(value: string): CSSProperties {
  return { '--beam-delay': value } as CSSProperties
}

function AgentNode({ name, beamId, className }: { name: string; beamId: string; className?: string }) {
  return (
    <div className={cn('flex w-[5.75rem] shrink-0 flex-col items-center gap-1.5 text-center sm:w-32', className)}>
      <span className="relative flex size-11 items-center justify-center rounded-xl border bg-background shadow-sm">
        <span className="beam-pulse absolute -inset-px rounded-xl ring-1 ring-beam/40" />
        <BotIcon className="size-5 text-foreground" />
      </span>
      <span className="text-xs font-medium text-foreground">{name}</span>
      <span className="hidden max-w-full truncate font-mono text-[10px] text-muted-foreground sm:block">{beamId}</span>
    </div>
  )
}

/**
 * Animated example: an instruction becomes a signed, encrypted message from one agent
 * to another, and the receiving agent checks the chain Firma, Mensch, Vollmacht.
 * Motion is CSS only and stops under prefers-reduced-motion (see index.css).
 */
export function TrustFlow({ className }: { className?: string }) {
  return (
    <figure className={cn('beam-demo beam-surface relative overflow-hidden rounded-2xl border p-4 sm:p-6', className)}>
      <figcaption className="sr-only">
        Beispielablauf: Ein Mensch sagt seinem Agenten, er solle Lakis' Agent eine Nachricht und eine Datei schicken. Der Agent
        signiert die Nachricht, verschlüsselt sie Ende-zu-Ende und sendet sie. Lakis' Agent prüft die Kette Firma, Mensch und
        Vollmacht, prüft die Signatur und nimmt Nachricht und Datei an.
      </figcaption>
      <div aria-hidden="true" className="flex flex-col gap-5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-success" />
            Beispielablauf
          </span>
          <span className="font-mono">beam://handoff</span>
        </div>

        <div className="flex items-start gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
            <UserIcon className="size-3.5 text-muted-foreground" />
          </span>
          <div className="flex min-w-0 flex-col gap-2 rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-[13px] leading-5 text-foreground">
            <p>„Sag meinem Agenten: Schreib Lakis&apos; Agent das hier und schick ihm die Datei.“</p>
            <span className="inline-flex w-fit items-center gap-1.5 rounded-md border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">
              <FileTextIcon className="size-3" />
              angebot.pdf
            </span>
          </div>
        </div>

        <div className="flex items-start">
          <div className="flex flex-col items-center gap-2">
            <AgentNode name="Dein Agent" beamId="du@firma-a.beam.directory" />
            <span className="beam-sign inline-flex items-center gap-1 rounded-full border border-beam/30 bg-beam/10 px-2 py-0.5 text-[10px] font-medium text-foreground">
              <KeyRoundIcon className="size-3 text-beam" />
              Signiert
            </span>
          </div>

          <div className="beam-track relative mt-[1.375rem] h-px flex-1 bg-border">
            <span className="beam-track-fill absolute inset-0 bg-gradient-to-r from-beam to-beam-2" />
            <span className="beam-packet absolute -top-3 left-0 inline-flex h-6 items-center gap-1 rounded-full border border-beam/40 bg-background px-2 text-[10px] font-medium text-foreground shadow-[0_0_24px_-4px_var(--beam)]">
              <LockIcon className="size-3 text-beam" />
              E2E
            </span>
          </div>

          <AgentNode name="Lakis' Agent" beamId="lakis@firma-b.beam.directory" />
        </div>

        <div className="rounded-xl border bg-background/60 p-3 sm:p-4">
          <p className="mb-3 text-[11px] text-muted-foreground">Lakis&apos; Agent prüft die Kette</p>
          <ol className="grid grid-cols-3 gap-2">
            {chain.map((step) => (
              <li key={step.label} className="beam-step flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-2 sm:p-2.5" style={delay(step.delay)}>
                <span className="flex items-center justify-between gap-1">
                  <step.icon className="size-3.5 text-muted-foreground" />
                  <span className="beam-step-icon flex size-4 items-center justify-center rounded-full bg-success/15" style={delay(step.delay)}>
                    <CheckIcon className="size-2.5 text-success" strokeWidth={3} />
                  </span>
                </span>
                <span className="text-xs font-medium text-foreground">{step.label}</span>
                <span className="truncate text-[10px] text-muted-foreground">{step.detail}</span>
              </li>
            ))}
          </ol>
          <p className="beam-step mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground" style={delay('6s')}>
            <span className="inline-flex items-center gap-1"><CheckIcon className="size-3 text-success" />Signatur gültig</span>
            <span className="inline-flex items-center gap-1"><CheckIcon className="size-3 text-success" />Entschlüsselt</span>
            <span className="inline-flex items-center gap-1"><CheckIcon className="size-3 text-success" />Datei angenommen</span>
          </p>
        </div>
      </div>
    </figure>
  )
}
