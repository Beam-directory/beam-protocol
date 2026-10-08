import type { ComponentType, ReactNode, SVGProps } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  AtSignIcon,
  BadgeCheckIcon,
  BuildingIcon,
  CheckIcon,
  ChevronsUpIcon,
  FileTextIcon,
  FingerprintIcon,
  HandIcon,
  KeyRoundIcon,
  LockIcon,
  PaperclipIcon,
  ScrollTextIcon,
  SearchIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UserIcon,
  UserPlusIcon,
  UserXIcon,
  UsersIcon,
} from 'lucide-react'
import { cn } from 'cn'
import { CodeWindow } from '@/components/code-window'
import { InProgressBadge } from '@/components/in-progress-badge'
import { TrustFlow } from '@/components/trust-flow'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/context'
import { EXAMPLE_BEAM_ID, agentPath } from '@/lib/example-agent'
import { CONTACT_EMAIL, EUR_LEX_AI_ACT } from '@/lib/register'

type Icon = ComponentType<SVGProps<SVGSVGElement>>

const DOCS_URL = 'https://docs.beam.directory'
const DASHBOARD_URL = 'https://dashboard.beam.directory'

const ASSISTANTS = ['Grok', 'Claude', 'OpenAI', 'MCP']
const CHAIN_ICONS: Icon[] = [BuildingIcon, UserIcon, ScrollTextIcon]
const RULE_ICONS: Icon[] = [ShieldCheckIcon, ChevronsUpIcon, UserXIcon]
const SECURITY_ICONS: Icon[] = [KeyRoundIcon, LockIcon, FingerprintIcon, HandIcon, UserXIcon, SlidersHorizontalIcon]

function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6', className)}>{children}</div>
}

function SectionHeading({ id, eyebrow, title, lead }: { id: string; eyebrow: string; title: ReactNode; lead?: ReactNode }) {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-sm font-medium text-beam">{eyebrow}</p>
      <h2 id={id} className="text-3xl font-semibold tracking-[-0.035em] text-balance sm:text-4xl md:text-[2.75rem] md:leading-[1.1]">
        {title}
      </h2>
      {lead ? <p className="text-base leading-7 text-pretty text-muted-foreground sm:text-lg">{lead}</p> : null}
    </div>
  )
}

function IconTile({ icon: IconComponent, className }: { icon: Icon; className?: string }) {
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-foreground shadow-sm', className)}>
      <IconComponent aria-hidden="true" className="size-4" />
    </span>
  )
}

function BentoCard({ icon, title, text, className, children, badge }: { icon: Icon; title: string; text: string; className?: string; children?: ReactNode; badge?: ReactNode }) {
  return (
    <li className={cn('beam-surface group relative flex flex-col overflow-hidden rounded-2xl border p-5 sm:p-6', className)}>
      <div className="flex items-start justify-between gap-3">
        <IconTile icon={icon} />
        {badge}
      </div>
      <h3 className="mt-4 text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{text}</p>
      {children ? <div className="mt-5 flex flex-1 flex-col justify-end">{children}</div> : null}
    </li>
  )
}

/** Marker for links to pages that exist in German only (shown in the English version). */
function GermanOnly() {
  const { locale, t } = useI18n()
  if (locale === 'de') return null
  return (
    <>
      <span aria-hidden="true" className="rounded border px-1 py-px text-[10px] leading-none font-medium text-muted-foreground">DE</span>
      <span className="sr-only"> ({t.common.germanOnly})</span>
    </>
  )
}

function ChatPreview() {
  const { t } = useI18n()
  const chats = t.landing.features.chats
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 rounded-xl border bg-background/70 p-3 text-[13px] sm:p-4">
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-primary-foreground">
          {chats.message}
          <span className="mt-2 flex w-fit items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2 py-1 font-mono text-[11px]">
            <PaperclipIcon className="size-3" />
            {chats.file}
          </span>
        </div>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <LockIcon className="size-2.5" /> {chats.messageMeta}
        </span>
      </div>
      <div className="flex flex-col items-start gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-foreground">{chats.reply}</div>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <CheckIcon className="size-2.5 text-success" /> {chats.replyMeta}
        </span>
      </div>
    </div>
  )
}

export function LandingPage() {
  const { t, href } = useI18n()
  const l = t.landing
  const f = l.features
  const earlyAccessUrl = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(l.cta.earlyAccessSubject)}`

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
          <div className="beam-grid absolute inset-0" />
          <div className="beam-glow absolute inset-x-0 -top-24 h-[36rem]" />
          <div className="beam-noise absolute inset-0" />
        </div>
        <Container className="flex flex-col items-center gap-14 pt-14 pb-20 sm:pt-20 lg:gap-16 lg:pt-24 lg:pb-28">
          <div className="flex flex-col items-start gap-6 sm:items-center sm:text-center">
            <p className="inline-flex max-w-full items-center gap-2 rounded-full border bg-background/60 px-3 py-1 text-xs whitespace-nowrap text-muted-foreground backdrop-blur">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-beam" />
              {l.hero.badge}
            </p>
            <h1
              id="hero-title"
              className="max-w-4xl text-[min(10vw,2.375rem)] leading-[1.04] font-semibold tracking-[-0.045em] text-balance hyphens-manual sm:text-6xl lg:text-7xl xl:text-[5rem]"
            >
              {l.hero.titleLead} <span className="beam-text-gradient">{l.hero.titleAccent}</span>
            </h1>
            <p className="max-w-2xl text-base leading-7 text-pretty text-muted-foreground sm:text-lg sm:leading-8">{l.hero.subline}</p>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
              <Button className="h-11 rounded-full px-5 text-[15px]" asChild>
                <Link to={href('start')}>
                  {l.hero.ctaPrimary}
                  <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                </Link>
              </Button>
              <Button variant="outline" className="h-11 rounded-full px-5 text-[15px]" asChild>
                <a href={DOCS_URL}>{l.hero.ctaDocs}</a>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-2 text-sm text-muted-foreground sm:justify-center">
              <span>{l.hero.worksWith}</span>
              <ul className="flex flex-wrap gap-1.5" aria-label={l.hero.assistantsAria}>
                {ASSISTANTS.map((name) => (
                  <li key={name} className="rounded-md border bg-background/60 px-2 py-0.5 font-medium text-foreground">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="relative w-full max-w-3xl">
            <div aria-hidden="true" className="beam-glow absolute -inset-10 -z-10 opacity-70" />
            <TrustFlow />
          </div>
        </Container>
      </section>

      {/* Chain of authority */}
      <section id="kette" aria-labelledby="kette-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="flex flex-col gap-12">
          <SectionHeading id="kette-title" eyebrow={l.chain.eyebrow} title={l.chain.title} lead={l.chain.lead} />
          <ol className="relative grid gap-4 md:grid-cols-3">
            <span
              aria-hidden="true"
              className="absolute top-[2.4rem] right-[16%] left-[16%] hidden h-px bg-gradient-to-r from-beam/0 via-beam/60 to-beam/0 md:block"
            />
            {l.chain.items.map((item, index) => (
              <li key={item.title} className="beam-surface relative flex flex-col gap-3 rounded-2xl border p-5 sm:p-6">
                <div className="flex items-center justify-between">
                  <IconTile icon={CHAIN_ICONS[index] ?? BuildingIcon} className={item.planned ? 'border-dashed' : 'border-beam/30'} />
                  <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold tracking-tight">{item.title}</h3>
                  {item.planned ? <InProgressBadge /> : null}
                </div>
                <p className="text-sm leading-6 text-muted-foreground">{item.text}</p>
              </li>
            ))}
          </ol>
          <ul className="grid gap-8 border-t border-border/60 pt-10 md:grid-cols-3">
            {l.chain.rules.map((rule, index) => {
              const RuleIcon = RULE_ICONS[index] ?? ShieldCheckIcon
              return (
                <li key={rule.title} className="flex gap-4">
                  <RuleIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-beam" />
                  <div className="flex flex-col gap-1.5">
                    <h3 className="font-semibold tracking-tight">{rule.title}</h3>
                    {rule.planned ? <InProgressBadge /> : null}
                    <p className="text-sm leading-6 text-muted-foreground">{rule.text}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        </Container>
      </section>

      {/* How it works */}
      <section id="ablauf" aria-labelledby="ablauf-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="flex flex-col gap-12">
          <SectionHeading id="ablauf-title" eyebrow={l.how.eyebrow} title={l.how.title} />
          <ol className="grid gap-4 md:grid-cols-3">
            {l.how.steps.map((step, index) => (
              <li key={step.title} className="relative flex flex-col gap-3 rounded-2xl border border-dashed p-5 sm:p-6">
                <span className="beam-text-gradient font-mono text-sm font-semibold">{String(index + 1).padStart(2, '0')}</span>
                <h3 className="text-lg font-semibold tracking-tight">{step.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {/* Features bento */}
      <section id="funktionen" aria-labelledby="funktionen-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="flex flex-col gap-12">
          <SectionHeading id="funktionen-title" eyebrow={f.eyebrow} title={f.title} lead={f.lead} />
          <ul className="grid auto-rows-auto gap-4 md:grid-cols-2 lg:grid-cols-3">
            <BentoCard icon={LockIcon} title={f.chats.title} text={f.chats.text} className="md:col-span-2 lg:row-span-2">
              <ChatPreview />
            </BentoCard>
            <BentoCard icon={AtSignIcon} title={f.beamIds.title} text={f.beamIds.text}>
              <span aria-hidden="true" className="w-fit max-w-full truncate rounded-md border bg-background/70 px-2 py-1 font-mono text-xs text-muted-foreground">
                {f.beamIds.example}
              </span>
            </BentoCard>
            <BentoCard icon={UserPlusIcon} title={f.contacts.title} text={f.contacts.text}>
              <span aria-hidden="true" className="flex items-center justify-between gap-2 rounded-lg border bg-background/70 px-2.5 py-2 text-xs">
                <span className="truncate text-muted-foreground">{f.contacts.from}</span>
                <span className="shrink-0 rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground">{f.contacts.accept}</span>
              </span>
            </BentoCard>
            <BentoCard icon={UsersIcon} title={f.groups.title} text={f.groups.text} />
            <BentoCard icon={FileTextIcon} title={f.files.title} text={f.files.text} />
            <BentoCard icon={SearchIcon} title={f.directory.title} text={f.directory.text}>
              <Link to="/verzeichnis" hrefLang="de" className="inline-flex w-fit items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline">
                {f.directory.link} <GermanOnly /> <ArrowRightIcon aria-hidden="true" className="size-3.5" />
              </Link>
            </BentoCard>
            <BentoCard icon={HandIcon} title={f.grok.title} text={f.grok.text} badge={<InProgressBadge label={f.grok.badge} />}>
              <span aria-hidden="true" className="flex items-center justify-between gap-2 rounded-lg border bg-background/70 px-2.5 py-2 text-xs">
                <span className="text-muted-foreground">{f.grok.preview}</span>
                <span className="rounded-md border px-2 py-0.5 font-medium text-foreground">{f.grok.confirm}</span>
              </span>
            </BentoCard>
            <BentoCard icon={BadgeCheckIcon} title={f.identity.title} text={f.identity.text} className="md:col-span-2">
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium">
                <Link to="/siegel-beantragen" hrefLang="de" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                  {f.identity.apply} <GermanOnly /> <ArrowRightIcon aria-hidden="true" className="size-3.5" />
                </Link>
                <Link to="/pruefrichtlinien" hrefLang="de" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  {f.identity.guidelines} <GermanOnly />
                </Link>
              </div>
            </BentoCard>
          </ul>
        </Container>
      </section>

      {/* Developers */}
      <section id="entwickler" aria-labelledby="entwickler-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="grid items-start gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="flex flex-col gap-8">
            <SectionHeading id="entwickler-title" eyebrow={l.developers.eyebrow} title={l.developers.title} lead={l.developers.lead} />
            <ul className="flex flex-col gap-3 text-sm">
              {l.developers.bullets.map((item) => (
                <li key={item} className="flex gap-3">
                  <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                  <span className="text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
            <a href={DOCS_URL} className="inline-flex w-fit items-center gap-1 text-sm font-medium underline-offset-4 hover:underline">
              {l.developers.docsLink} <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
            </a>
          </div>
          <CodeWindow snippets={l.developers.snippets} label={l.developers.codeLabel} />
        </Container>
      </section>

      {/* Security */}
      <section id="sicherheit" aria-labelledby="sicherheit-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="flex flex-col gap-12">
          <SectionHeading id="sicherheit-title" eyebrow={l.security.eyebrow} title={l.security.title} lead={l.security.lead} />
          <ul className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {l.security.items.map((item, index) => {
              const ItemIcon = SECURITY_ICONS[index] ?? KeyRoundIcon
              return (
                <li key={item.title} className="flex flex-col gap-3 bg-background p-6">
                  <div className="flex items-start justify-between gap-3">
                    <ItemIcon aria-hidden="true" className={cn('size-5', item.planned ? 'text-muted-foreground' : 'text-beam')} />
                    {item.planned ? <InProgressBadge /> : null}
                  </div>
                  <h3 className="font-semibold tracking-tight">{item.title}</h3>
                  <p className="text-sm leading-6 text-muted-foreground">{item.text}</p>
                </li>
              )
            })}
          </ul>
          <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
            {l.security.footnoteLead}{' '}
            <a className="underline underline-offset-4 hover:text-foreground" href={DOCS_URL}>{l.security.footnoteDocs}</a> {l.security.footnoteAnd}{' '}
            <Link className="underline underline-offset-4 hover:text-foreground" to="/pruefrichtlinien" hrefLang="de">
              {l.security.footnoteGuidelines}
              <GermanOnly />
            </Link>
            {l.security.footnoteEnd}
          </p>
        </Container>
      </section>

      {/* Register */}
      <section id="register" aria-labelledby="register-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="grid items-center gap-12 lg:grid-cols-2">
          <div className="flex flex-col gap-8">
            <SectionHeading id="register-title" eyebrow={l.register.eyebrow} title={l.register.title} lead={l.register.lead} />
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button variant="outline" className="h-10 rounded-full px-4" asChild>
                <Link to="/verzeichnis" hrefLang="de">{l.register.openDirectory} <GermanOnly /></Link>
              </Button>
              <Button variant="ghost" className="h-10 rounded-full px-4" asChild>
                <Link to="/siegel-beantragen" hrefLang="de">{l.register.applySeal} <GermanOnly /></Link>
              </Button>
            </div>
            <p className="max-w-xl text-xs leading-5 text-muted-foreground">
              {l.register.aiAct}{' '}
              <a className="underline underline-offset-4 hover:text-foreground" href={EUR_LEX_AI_ACT}>{l.register.aiActLink}</a>
            </p>
          </div>
          <div className="beam-surface rounded-2xl border p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{l.register.example}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-xs font-medium text-success">
                <BadgeCheckIcon aria-hidden="true" className="size-3.5" /> {l.register.verified}
              </span>
            </div>
            <dl className="mt-5 grid gap-4 text-sm">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{l.register.beamId}</dt>
                <dd className="font-mono text-[13px] break-all">{EXAMPLE_BEAM_ID}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{l.register.scope}</dt>
                <dd>{l.register.scopeValue}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{l.register.recipientCheck}</dt>
                <dd>{l.register.recipientCheckValue}</dd>
              </div>
            </dl>
            <Link
              to={agentPath(EXAMPLE_BEAM_ID)}
              hrefLang="de"
              className="mt-6 inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
            >
              {l.register.exampleLink} <GermanOnly /> <ArrowRightIcon aria-hidden="true" className="size-3.5" />
            </Link>
          </div>
        </Container>
      </section>

      {/* FAQ */}
      <section id="fragen" aria-labelledby="fragen-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
          <SectionHeading id="fragen-title" eyebrow={l.faq.eyebrow} title={l.faq.title} />
          <Accordion type="single" collapsible className="w-full">
            {l.faq.items.map((faq, index) => (
              <AccordionItem key={index} value={`faq-${index}`}>
                <AccordionTrigger className="text-base">{faq.q}</AccordionTrigger>
                <AccordionContent className="text-sm leading-6 text-muted-foreground">{faq.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Container>
      </section>

      {/* Final CTA */}
      <section aria-labelledby="cta-title" className="relative isolate overflow-hidden border-t border-border/60 py-24 sm:py-32">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
          <div className="beam-glow absolute inset-x-0 top-1/4 h-80 opacity-80" />
          <div className="beam-noise absolute inset-0" />
        </div>
        <Container className="flex flex-col items-center gap-6 text-center">
          <h2 id="cta-title" className="max-w-3xl text-4xl font-semibold tracking-[-0.04em] text-balance sm:text-5xl md:text-6xl">
            {l.cta.title}
          </h2>
          <p className="max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">{l.cta.text}</p>
          <div className="flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
            <Button className="h-11 rounded-full px-5 text-[15px]" asChild>
              <Link to={href('start')}>
                {l.cta.primary}
                <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
              </Link>
            </Button>
            <Button variant="outline" className="h-11 rounded-full px-5 text-[15px]" asChild>
              <a href={earlyAccessUrl}>{l.cta.earlyAccess}</a>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {l.cta.already}{' '}
            <a href="/network" className="underline-offset-4 hover:text-foreground hover:underline">{l.cta.openNetwork}</a>
            {' · '}
            <a href={DASHBOARD_URL} className="underline-offset-4 hover:text-foreground hover:underline">{l.cta.dashboard}</a>
          </p>
        </Container>
      </section>
    </div>
  )
}
