import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRightIcon, ArrowUpRightIcon } from 'lucide-react'
import { cn } from 'cn'
import { AgentCheck } from '@/components/agent-check'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/context'

const DOCS_URL = 'https://docs.beam.directory'
const DASHBOARD_URL = 'https://dashboard.beam.directory'

function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6', className)}>{children}</div>
}

export function LandingPage() {
  const { t, href } = useI18n()
  const l = t.landing

  return (
    <div className="flex flex-col">
      <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
          <div className="beam-grid absolute inset-0" />
          <div className="beam-glow absolute inset-x-0 -top-24 h-[36rem]" />
          <div className="beam-noise absolute inset-0" />
        </div>
        <Container className="flex flex-col items-center gap-12 pt-14 pb-20 sm:pt-20 lg:pt-24 lg:pb-24">
          <div className="flex flex-col items-start gap-6 sm:items-center sm:text-center">
            <h1
              id="hero-title"
              className="max-w-4xl text-[2rem] leading-[1.08] font-semibold tracking-[-0.04em] text-balance sm:text-5xl lg:text-6xl"
            >
              {l.hero.titleLead} <span className="beam-text-gradient">{l.hero.titleAccent}</span>
            </h1>
            <p className="max-w-2xl text-base leading-7 text-pretty text-muted-foreground sm:text-lg sm:leading-8">{l.hero.subline}</p>
            <Button className="h-11 w-full rounded-full px-5 text-[15px] sm:w-auto" asChild>
              <Link to={href('start')}>
                {l.hero.cta}
                <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
              </Link>
            </Button>
          </div>
          <div className="w-full max-w-3xl">
            <AgentCheck variant="embed" />
          </div>
        </Container>
      </section>

      <section id="ablauf" aria-labelledby="ablauf-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-24">
        <Container className="flex flex-col gap-10">
          <h2 id="ablauf-title" className="text-3xl font-semibold tracking-[-0.035em] text-balance sm:text-4xl">
            {l.how.title}
          </h2>
          <ol className="grid gap-4 md:grid-cols-3">
            {l.how.steps.map((step, index) => (
              <li key={step.title} className="beam-surface flex flex-col gap-3 rounded-2xl border p-5 sm:p-6">
                <span className="beam-text-gradient font-mono text-sm font-semibold">{String(index + 1).padStart(2, '0')}</span>
                <h3 className="text-lg font-semibold tracking-tight">{step.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      <section id="entwickler" aria-labelledby="entwickler-title" className="scroll-mt-16 border-t border-border/60 py-14 sm:py-16">
        <Container className="flex flex-col gap-5">
          <h2 id="entwickler-title" className="text-lg font-semibold tracking-tight">
            {l.developers.title}
          </h2>
          <ul className="grid max-w-4xl gap-2 text-sm leading-6 text-muted-foreground">
            {l.developers.bullets.map((item) => (
              <li key={item} className="flex gap-3">
                <span aria-hidden="true" className="mt-2.5 size-1 shrink-0 rounded-full bg-beam" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium">
            <a href={DOCS_URL} className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
              {l.developers.docsLink} <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
            </a>
            <a href="/network" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              {l.developers.networkLink}
            </a>
            <a href={DASHBOARD_URL} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              {l.developers.dashboardLink}
            </a>
          </p>
        </Container>
      </section>
    </div>
  )
}
