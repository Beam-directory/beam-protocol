import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BadgeCheckIcon,
  CodeXmlIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  WaypointsIcon,
  type LucideIcon,
} from 'lucide-react'
import { cn } from 'cn'
import { AgentCheck } from '@/components/agent-check'
import { GermanOnlyMarker } from '@/components/site-shell'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/context'
import type { FeatureGroup, FeatureGroupId, FeatureItem, FeatureLinkTarget } from '@/i18n/en'

const DOCS_URL = 'https://docs.beam.directory'
const DASHBOARD_URL = 'https://dashboard.beam.directory'

const GROUP_ICONS: Record<FeatureGroupId, LucideIcon> = {
  check: ShieldCheckIcon,
  chain: WaypointsIcon,
  communicate: LockKeyholeIcon,
  developers: CodeXmlIcon,
  directory: BadgeCheckIcon,
  control: SlidersHorizontalIcon,
}

function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6', className)}>{children}</div>
}

function FeatureLink({ label, target }: { label: string; target: FeatureLinkTarget }) {
  const { href } = useI18n()
  const className = 'inline-flex items-center gap-1 underline-offset-4 hover:underline'
  switch (target) {
    case 'verify':
    case 'start':
      return (
        <Link className={className} to={href(target)}>
          {label} <ArrowRightIcon aria-hidden="true" className="size-3.5" />
        </Link>
      )
    case 'directory':
    case 'seal':
      return (
        <Link className={className} to={target === 'directory' ? '/verzeichnis' : '/siegel-beantragen'} hrefLang="de">
          {label}
          <GermanOnlyMarker />
        </Link>
      )
    case 'network':
      return (
        <a className={className} href="/network">
          {label} <ArrowRightIcon aria-hidden="true" className="size-3.5" />
        </a>
      )
    case 'docs':
    case 'dashboard':
      return (
        <a className={className} href={target === 'docs' ? DOCS_URL : DASHBOARD_URL}>
          {label} <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
        </a>
      )
  }
}

function FeatureRow({ item }: { item: FeatureItem }) {
  const { t } = useI18n()
  return (
    <li className="flex gap-2.5">
      <span
        aria-hidden="true"
        className={cn('mt-[0.55rem] size-1.5 shrink-0 rounded-full', item.status === 'soon' ? 'border border-muted-foreground/60' : 'bg-beam')}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground/90">
          {item.text}
          {item.status ? (
            <span
              className={cn(
                'ml-2 inline-block rounded-full border px-1.5 py-px align-[0.1em] text-[11px] leading-4 font-medium whitespace-nowrap',
                item.status === 'limited'
                  ? 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                  : 'border-border bg-muted text-muted-foreground',
              )}
            >
              {t.landing.features.status[item.status]}
            </span>
          ) : null}
        </span>
        {item.note ? <span className="text-xs leading-5 text-muted-foreground">{item.note}</span> : null}
      </span>
    </li>
  )
}

function FeatureCard({ group }: { group: FeatureGroup }) {
  const Icon = GROUP_ICONS[group.id]
  const titleId = `feature-${group.id}`
  return (
    <li aria-labelledby={titleId} className="beam-surface flex flex-col gap-4 rounded-2xl border p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-beam to-beam-2 text-white shadow-sm"
        >
          <Icon className="size-[18px]" />
        </span>
        <div className="flex flex-col gap-1">
          <h3 id={titleId} className="text-lg leading-6 font-semibold tracking-tight">
            {group.title}
          </h3>
          <p className="text-sm leading-6 text-muted-foreground">{group.line}</p>
        </div>
      </div>
      <ul className="flex flex-col gap-2 text-sm leading-6">
        {group.items.map((item) => (
          <FeatureRow key={item.text} item={item} />
        ))}
      </ul>
      <p className="mt-auto border-t border-border/70 pt-3 text-xs leading-5 text-muted-foreground">{group.tech}</p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
        {group.links.map((link) => (
          <FeatureLink key={link.target} label={link.label} target={link.target} />
        ))}
      </p>
    </li>
  )
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

      <section id="funktionen" aria-labelledby="funktionen-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-24">
        <Container className="flex flex-col gap-10">
          <div className="flex max-w-2xl flex-col gap-3">
            <h2 id="funktionen-title" className="text-3xl font-semibold tracking-[-0.035em] text-balance sm:text-4xl">
              {l.features.title}
            </h2>
            <p className="text-base leading-7 text-pretty text-muted-foreground">{l.features.lead}</p>
          </div>
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {l.features.groups.map((group) => (
              <FeatureCard key={group.id} group={group} />
            ))}
          </ul>
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
    </div>
  )
}
