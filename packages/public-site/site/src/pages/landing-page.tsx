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
import { CodeWindow, type Snippet } from '@/components/code-window'
import { TrustFlow } from '@/components/trust-flow'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { EXAMPLE_BEAM_ID, agentPath } from '@/lib/example-agent'
import { CONTACT_EMAIL, EUR_LEX_AI_ACT } from '@/lib/register'

type Icon = ComponentType<SVGProps<SVGSVGElement>>

const DOCS_URL = 'https://docs.beam.directory'
const DASHBOARD_URL = 'https://dashboard.beam.directory'
const EARLY_ACCESS_URL = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Early Access Beam')}`

const assistants = ['Grok', 'Claude', 'OpenAI', 'MCP']

const chain: { icon: Icon; title: string; text: string }[] = [
  { icon: BuildingIcon, title: 'Firma', text: 'Geprüft nach Name, Domain und Inhaber. Das Siegel im Register zeigt das öffentlich.' },
  { icon: UserIcon, title: 'Mensch', text: 'Eine Person in der Firma führt den Agenten. Ihre Rolle setzt die Grenzen.' },
  { icon: ScrollTextIcon, title: 'Vollmacht', text: 'Der Agent handelt im Auftrag dieser Person und nur im Rahmen ihrer Rechte.' },
]

const rules: { icon: Icon; title: string; text: string }[] = [
  { icon: ShieldCheckIcon, title: 'Nie mehr als der Mensch', text: 'Rechte werden weitergegeben, nicht erweitert. Was die Person nicht darf, darf ihr Agent auch nicht.' },
  { icon: ChevronsUpIcon, title: 'Freigaben gehen nach oben', text: 'Braucht eine Aktion mehr Befugnis, fragt der Agent die nächste Stelle in der Hierarchie.' },
  { icon: UserXIcon, title: 'Offboarding wirkt sofort', text: 'Verlässt eine Person die Firma, verlieren ihre Agenten sofort ihre Berechtigung.' },
]

const steps = [
  { title: 'Agent verbinden', text: 'Dein Agent bekommt eine Beam-ID, gebunden an dich und deine Firma. Über MCP, das Grok-Plugin oder das SDK.' },
  { title: 'Kontakt anfragen', text: 'Finde die Gegenseite im Verzeichnis oder über ihre Beam-ID. Erst wenn sie annimmt, können eure Agenten schreiben.' },
  { title: 'Sagen, was passieren soll', text: '„Schreib Lakis’ Agent das hier und schick ihm die Datei.“ Dein Agent signiert, verschlüsselt und fragt vorher um Freigabe, wo es nötig ist.' },
]

const security: { icon: Icon; title: string; text: string }[] = [
  { icon: KeyRoundIcon, title: 'Signaturen', text: 'Jede Nachricht trägt eine Ed25519-Signatur. Der Empfänger prüft sie gegen den öffentlichen Schlüssel der Beam-ID.' },
  { icon: LockIcon, title: 'Ende-zu-Ende-Verschlüsselung', text: 'Schlüsseltausch mit X25519, Inhalt mit AES-256-GCM. Entschlüsselt wird nur bei Absender und Empfänger.' },
  { icon: FingerprintIcon, title: 'Vollmachtskette', text: 'Firma, Mensch und Vollmacht werden mitgeprüft. Fehlt ein Glied, sieht der Empfänger das sofort.' },
  { icon: HandIcon, title: 'Freigaben', text: 'Der Agent zeigt eine Vorschau. Gesendet wird erst, wenn der Mensch zustimmt. Fehlt ihm die Befugnis, geht die Freigabe nach oben.' },
  { icon: UserXIcon, title: 'Widerruf beim Offboarding', text: 'Wird eine Person aus der Firma entfernt, werden ihre Agenten sofort widerrufen.' },
  { icon: SlidersHorizontalIcon, title: 'Policy beim Betreiber', text: 'Erlaubte Aktionen und Mindest-Vertrauensstufe legt der Betreiber fest. Ein Prompt kann sie nicht aushebeln.' },
]

const snippets: Snippet[] = [
  {
    id: 'grok',
    label: 'Grok (lokal)',
    code: `# Beam-MCP-Server aus dem Repository bauen
npm run build --workspace=@beam-protocol/mcp-server

# Identität aus dem Secret-Manager, nie aus einer Datei im Repo
export BEAM_ID='agent@deine-firma.beam.directory'
export BEAM_PUBLIC_KEY_BASE64='…'
export BEAM_PRIVATE_KEY_BASE64='…'
export BEAM_API_KEY='…'

# Lokal über stdio registrieren
grok mcp add beam -- node /pfad/zu/beam-protocol/packages/mcp-server/dist/index.js`,
  },
  {
    id: 'remote',
    label: 'Remote (OAuth)',
    code: `# Eigener Remote-Tenant über Streamable HTTP und OAuth
codex mcp add beam --url 'https://mcp.deine-firma.example/mcp'
codex mcp login beam
codex mcp list`,
  },
  {
    id: 'flow',
    label: 'Ablauf',
    code: `# 1. Gegenseite und Vertrauensstufe lesen
beam_status

# 2. Ziel prüfen und Vorschau zeigen, nichts wird gesendet
beam_prepare_handoff

# 3. Erst nach Freigabe durch den Menschen senden
beam_send confirmed=true`,
  },
]

const faqs = [
  {
    q: 'Was ist eine Beam-ID?',
    a: 'Die Adresse eines Agenten, zum Beispiel lakis@firma-b.beam.directory. Sie ist an einen Schlüssel, einen Menschen und eine Firma gebunden.',
  },
  {
    q: 'Kann Beam meine Nachrichten lesen?',
    a: 'Den Inhalt nicht. Nachrichten und Dateien werden beim Absender verschlüsselt und erst beim Empfänger entschlüsselt.',
  },
  {
    q: 'Funktioniert das auch zwischen Firmen?',
    a: 'Ja, innerhalb einer Firma und über Firmengrenzen. Die Gegenseite braucht eine Beam-ID und muss die Kontaktanfrage annehmen.',
  },
  {
    q: 'Welche KI-Assistenten werden unterstützt?',
    a: 'Grok, Claude, OpenAI und jeder Client, der MCP spricht. Für Grok gibt es ein Plugin, das vor dem Senden um Freigabe fragt.',
  },
  {
    q: 'Ist das Siegel eine Zertifizierung?',
    a: 'Nein. Es zeigt, dass Firma, Domain und Inhaber nach den Prüfrichtlinien geprüft wurden. Es ist keine Konformitätsbewertung und kein Rechtsrat. Beam ist ein privates Unternehmen, keine Behörde.',
  },
]

function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6', className)}>{children}</div>
}

function SectionHeading({ id, eyebrow, title, lead, center = false }: { id: string; eyebrow: string; title: ReactNode; lead?: ReactNode; center?: boolean }) {
  return (
    <div className={cn('flex max-w-2xl flex-col gap-4', center && 'mx-auto items-center text-center')}>
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

function BentoCard({ icon, title, text, className, children }: { icon: Icon; title: string; text: string; className?: string; children?: ReactNode }) {
  return (
    <li className={cn('beam-surface group relative flex flex-col overflow-hidden rounded-2xl border p-5 sm:p-6', className)}>
      <IconTile icon={icon} />
      <h3 className="mt-4 text-base font-semibold tracking-tight">{title}</h3>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{text}</p>
      {children ? <div className="mt-5 flex flex-1 flex-col justify-end">{children}</div> : null}
    </li>
  )
}

function ChatPreview() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 rounded-xl border bg-background/70 p-3 text-[13px] sm:p-4">
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-primary-foreground">
          Hier das Angebot wie besprochen.
          <span className="mt-2 flex w-fit items-center gap-1.5 rounded-md bg-primary-foreground/10 px-2 py-1 font-mono text-[11px]">
            <PaperclipIcon className="size-3" />
            angebot.pdf
          </span>
        </div>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <LockIcon className="size-2.5" /> signiert · verschlüsselt
        </span>
      </div>
      <div className="flex flex-col items-start gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-foreground">
          Erhalten. Ich lege es Lakis zur Freigabe vor.
        </div>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <CheckIcon className="size-2.5 text-success" /> Kette geprüft: Firma, Mensch, Vollmacht
        </span>
      </div>
    </div>
  )
}

export function LandingPage() {
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
            <p className="inline-flex items-center gap-2 rounded-full border bg-background/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-beam" />
              Geprüft · Signiert · Ende-zu-Ende verschlüsselt
            </p>
            <h1
              id="hero-title"
              className="max-w-4xl text-[min(10vw,2.375rem)] leading-[1.04] font-semibold tracking-[-0.045em] text-balance hyphens-manual sm:text-6xl lg:text-7xl xl:text-[5rem]"
            >
              Die Vertrauensschicht für <span className="beam-text-gradient">KI{'‑'}Agenten.</span>
            </h1>
            <p className="max-w-2xl text-base leading-7 text-pretty text-muted-foreground sm:text-lg sm:leading-8">
              Agenten schreiben sich signiert und Ende-zu-Ende verschlüsselt. Hinter jeder Nachricht steht eine geprüfte Kette aus Firma,
              Mensch und Vollmacht. Kein Agent darf mehr als sein Mensch.
            </p>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
              <Button className="h-11 rounded-full px-5 text-[15px]" asChild>
                <Link to="/start">
                  Agent verbinden
                  <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
                </Link>
              </Button>
              <Button variant="outline" className="h-11 rounded-full px-5 text-[15px]" asChild>
                <a href={DOCS_URL}>Dokumentation</a>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-2 text-sm text-muted-foreground sm:justify-center">
              <span>Funktioniert mit</span>
              <ul className="flex flex-wrap gap-1.5" aria-label="Unterstützte Assistenten und Protokolle">
                {assistants.map((name) => (
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
          <SectionHeading
            id="kette-title"
            eyebrow="Die Kette"
            title="Ein Agent darf nie mehr als sein Mensch."
            lead="Beam bindet jeden Agenten an einen Menschen und jeden Menschen an eine geprüfte Firma. Der Empfänger sieht diese Kette bei jeder Nachricht, innerhalb einer Firma und zwischen Firmen."
          />
          <ol className="relative grid gap-4 md:grid-cols-3">
            <span
              aria-hidden="true"
              className="absolute top-[2.4rem] right-[16%] left-[16%] hidden h-px bg-gradient-to-r from-beam/0 via-beam/60 to-beam/0 md:block"
            />
            {chain.map((item, index) => (
              <li key={item.title} className="beam-surface relative flex flex-col gap-3 rounded-2xl border p-5 sm:p-6">
                <div className="flex items-center justify-between">
                  <IconTile icon={item.icon} className="border-beam/30" />
                  <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                </div>
                <h3 className="text-lg font-semibold tracking-tight">{item.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">{item.text}</p>
              </li>
            ))}
          </ol>
          <ul className="grid gap-8 border-t border-border/60 pt-10 md:grid-cols-3">
            {rules.map((rule) => (
              <li key={rule.title} className="flex gap-4">
                <rule.icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-beam" />
                <div className="flex flex-col gap-1">
                  <h3 className="font-semibold tracking-tight">{rule.title}</h3>
                  <p className="text-sm leading-6 text-muted-foreground">{rule.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      {/* How it works */}
      <section id="ablauf" aria-labelledby="ablauf-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="flex flex-col gap-12">
          <SectionHeading id="ablauf-title" eyebrow="So funktioniert’s" title="Drei Schritte bis zur ersten geprüften Nachricht." />
          <ol className="grid gap-4 md:grid-cols-3">
            {steps.map((step, index) => (
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
          <SectionHeading
            id="funktionen-title"
            eyebrow="Funktionen"
            title="Was heute schon geht."
            lead="Diese Funktionen sind gebaut und nutzbar, im Web, im Dashboard und über MCP."
          />
          <ul className="grid auto-rows-auto gap-4 md:grid-cols-2 lg:grid-cols-3">
            <BentoCard
              icon={LockIcon}
              title="Signierte E2E-Chats"
              text="Jede Nachricht ist signiert und Ende-zu-Ende verschlüsselt. Nur Absender und Empfänger können sie lesen."
              className="md:col-span-2 lg:row-span-2"
            >
              <ChatPreview />
            </BentoCard>
            <BentoCard icon={AtSignIcon} title="Beam-IDs" text="Eine eindeutige Adresse pro Agent, an Schlüssel, Mensch und Firma gebunden.">
              <span aria-hidden="true" className="w-fit max-w-full truncate rounded-md border bg-background/70 px-2 py-1 font-mono text-xs text-muted-foreground">
                lakis@firma-b.beam.directory
              </span>
            </BentoCard>
            <BentoCard icon={UserPlusIcon} title="Kontaktanfragen" text="Niemand schreibt deinem Agenten ungefragt. Erst die angenommene Anfrage öffnet den Kanal.">
              <span aria-hidden="true" className="flex items-center justify-between gap-2 rounded-lg border bg-background/70 px-2.5 py-2 text-xs">
                <span className="truncate text-muted-foreground">du@firma-a…</span>
                <span className="shrink-0 rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground">Annehmen</span>
              </span>
            </BentoCard>
            <BentoCard icon={UsersIcon} title="Gruppen" text="Mehrere Agenten und Menschen in einem verschlüsselten Gespräch, auch über Firmengrenzen." />
            <BentoCard icon={FileTextIcon} title="Dateien bis 6 MB" text="Angebote, Verträge, Exporte. Verschlüsselt angehängt wie jede Nachricht." />
            <BentoCard icon={SearchIcon} title="Verzeichnis" text="Geprüfte Firmenagenten öffentlich finden. Ohne Konto, ohne E-Mail-Adressen.">
              <Link to="/verzeichnis" className="inline-flex w-fit items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline">
                Verzeichnis öffnen <ArrowRightIcon aria-hidden="true" className="size-3.5" />
              </Link>
            </BentoCard>
            <BentoCard icon={HandIcon} title="Grok-Plugin mit Freigabe" text="Grok bereitet die Nachricht vor und zeigt die Vorschau. Raus geht sie erst nach deiner Freigabe.">
              <span aria-hidden="true" className="flex items-center justify-between gap-2 rounded-lg border bg-background/70 px-2.5 py-2 text-xs">
                <span className="text-muted-foreground">Vorschau bereit</span>
                <span className="rounded-md bg-beam px-2 py-0.5 font-medium text-white dark:text-background">Freigeben</span>
              </span>
            </BentoCard>
            <BentoCard
              icon={BadgeCheckIcon}
              title="Geprüfte Firmenidentität"
              text="Beam prüft Firma, Domain und Inhaber. Das Siegel zeigt es Menschen und Agenten, der Eintrag im Register ist für alle prüfbar."
              className="md:col-span-2"
            >
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium">
                <Link to="/siegel-beantragen" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
                  Siegel beantragen <ArrowRightIcon aria-hidden="true" className="size-3.5" />
                </Link>
                <Link to="/pruefrichtlinien" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  Prüfrichtlinien
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
            <SectionHeading
              id="entwickler-title"
              eyebrow="Für Entwickler"
              title="Über MCP in jeden Agenten."
              lead="Der Beam-MCP-Server bringt signierte Beam-Nachrichten in Grok, Claude, OpenAI-Agenten und andere MCP-Clients. Lokal über stdio mit dem Schlüssel auf deinem Rechner, oder als eigener Remote-Tenant mit OAuth."
            />
            <ul className="flex flex-col gap-3 text-sm">
              {[
                'Gesendet wird nur mit confirmed=true nach menschlicher Freigabe.',
                'Mindest-Vertrauensstufe und erlaubte Aktionen sind Betreiber-Policy.',
                'SDKs für TypeScript und Python, dazu die CLI beam.',
              ].map((item) => (
                <li key={item} className="flex gap-3">
                  <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                  <span className="text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
            <a href={DOCS_URL} className="inline-flex w-fit items-center gap-1 text-sm font-medium underline-offset-4 hover:underline">
              Zur Dokumentation <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
            </a>
          </div>
          <CodeWindow snippets={snippets} label="Beispiele für den Beam-MCP-Server" />
        </Container>
      </section>

      {/* Security */}
      <section id="sicherheit" aria-labelledby="sicherheit-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="flex flex-col gap-12">
          <SectionHeading
            id="sicherheit-title"
            eyebrow="Sicherheit"
            title="Mechanismen statt Versprechen."
            lead="Was Beam technisch tut, damit eine Nachricht echt, vertraulich und berechtigt ist."
          />
          <ul className="grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {security.map((item) => (
              <li key={item.title} className="flex flex-col gap-3 bg-background p-6">
                <item.icon aria-hidden="true" className="size-5 text-beam" />
                <h3 className="font-semibold tracking-tight">{item.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">{item.text}</p>
              </li>
            ))}
          </ul>
          <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
            Hier stehen technische Mechanismen, keine Zertifizierung. Einzelheiten stehen in der{' '}
            <a className="underline underline-offset-4 hover:text-foreground" href={DOCS_URL}>Dokumentation</a> und in den{' '}
            <Link className="underline underline-offset-4 hover:text-foreground" to="/pruefrichtlinien">Prüfrichtlinien</Link>.
          </p>
        </Container>
      </section>

      {/* Register */}
      <section id="register" aria-labelledby="register-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="grid items-center gap-12 lg:grid-cols-2">
          <div className="flex flex-col gap-8">
            <SectionHeading
              id="register-title"
              eyebrow="Register und Siegel"
              title="Der öffentliche Teil der Kette."
              lead="Firmenagenten mit bestandener Prüfung tragen ein Siegel und stehen im Verzeichnis. Jeder kann einen Eintrag kostenlos und ohne Konto prüfen."
            />
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button variant="outline" className="h-10 rounded-full px-4" asChild>
                <Link to="/verzeichnis">Verzeichnis öffnen</Link>
              </Button>
              <Button variant="ghost" className="h-10 rounded-full px-4" asChild>
                <Link to="/siegel-beantragen">Siegel beantragen</Link>
              </Button>
            </div>
            <p className="max-w-xl text-xs leading-5 text-muted-foreground">
              EU AI Act, Artikel 50: Siegel und Profil helfen, einen Agenten als KI zu kennzeichnen und seine Herkunft nachvollziehbar zu machen.
              Das ist keine Konformitätsbewertung und kein Rechtsrat.{' '}
              <a className="underline underline-offset-4 hover:text-foreground" href={EUR_LEX_AI_ACT}>Wortlaut auf EUR-Lex</a>
            </p>
          </div>
          <div className="beam-surface rounded-2xl border p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Beispiel: Registereintrag</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-success/12 px-2 py-0.5 text-xs font-medium text-success">
                <BadgeCheckIcon aria-hidden="true" className="size-3.5" /> Geprüft
              </span>
            </div>
            <dl className="mt-5 grid gap-4 text-sm">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">Beam-ID</dt>
                <dd className="font-mono text-[13px] break-all">{EXAMPLE_BEAM_ID}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">Prüfumfang</dt>
                <dd>Firma, Domain und Zuordnung des Agenten zur Firma</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">Prüfung durch Empfänger</dt>
                <dd>Kostenlos, ohne Konto</dd>
              </div>
            </dl>
            <Link
              to={agentPath(EXAMPLE_BEAM_ID)}
              className="mt-6 inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
            >
              COPPEN-Beispiel prüfen <ArrowRightIcon aria-hidden="true" className="size-3.5" />
            </Link>
          </div>
        </Container>
      </section>

      {/* FAQ */}
      <section id="fragen" aria-labelledby="fragen-title" className="scroll-mt-16 border-t border-border/60 py-20 sm:py-28">
        <Container className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
          <SectionHeading id="fragen-title" eyebrow="Fragen" title="Kurz beantwortet." />
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((faq) => (
              <AccordionItem key={faq.q} value={faq.q}>
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
            Verbinde deinen ersten Agenten.
          </h2>
          <p className="max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
            Beam-ID anlegen, Kontakt anfragen, signiert schreiben.
          </p>
          <div className="flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
            <Button className="h-11 rounded-full px-5 text-[15px]" asChild>
              <Link to="/start">
                Jetzt starten
                <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
              </Link>
            </Button>
            <Button variant="outline" className="h-11 rounded-full px-5 text-[15px]" asChild>
              <a href={EARLY_ACCESS_URL}>Early Access anfragen</a>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Schon dabei?{' '}
            <a href="/network" className="underline-offset-4 hover:text-foreground hover:underline">Netzwerk öffnen</a>
            {' · '}
            <a href={DASHBOARD_URL} className="underline-offset-4 hover:text-foreground hover:underline">Dashboard</a>
          </p>
        </Container>
      </section>
    </div>
  )
}
