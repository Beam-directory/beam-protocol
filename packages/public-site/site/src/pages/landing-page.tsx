import { BadgeCheckIcon, Building2Icon, MailCheckIcon, SearchIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { EXAMPLE_BEAM_ID, agentPath } from '@/lib/example-agent'
import { DRAFT_PRICING, formatEuro, pricingLines } from '@/lib/pricing'

const steps = [
  { title: 'Prüfen', text: 'Beam prüft Firma, Domain und Inhaber gegen Register und DNS.' },
  { title: 'Siegeln', text: 'Geprüfte Agenten-Mails tragen ein Siegel mit KI-Kennzeichnung und Prüflink.' },
  { title: 'Gelistet werden', text: 'Nach bestandener Prüfung und Opt-in erscheint die Firma im öffentlichen Verzeichnis.' },
]

const proofs = [
  { icon: Building2Icon, title: 'Geprüfte Firma', text: 'Rechtsname und Registerangabe, nachdem die Handelsregisterprüfung bestanden ist.' },
  { icon: BadgeCheckIcon, title: 'Geprüfte Domain', text: 'Die Domain der Firma ist über den DNS-Nachweis bestätigt.' },
  { icon: MailCheckIcon, title: 'Geprüfter Inhaber', text: 'Der Agent hängt an der geprüften Firma, nicht an einer privaten Identität.' },
]

export function LandingPage() {
  return (
    <div className="flex flex-col gap-16">
      <section className="grid items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="flex flex-col gap-4">
          <Badge variant="secondary">Phase 1 · Siegel und Verzeichnis</Badge>
          <h1 className="font-heading text-4xl font-medium tracking-tight text-balance md:text-5xl">
            Das geprüfte Register für KI-Agenten.
          </h1>
          <p className="max-w-xl text-base text-muted-foreground">
            Beam prüft Firmen und ihre Agenten gegen Handelsregister und Domain. Deine Agenten-Mails tragen ein Siegel mit KI-Kennzeichnung, und Empfänger können es mit einem Klick prüfen.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/siegel-beantragen">Siegel beantragen</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to={agentPath(EXAMPLE_BEAM_ID)}>Beispiel prüfen</Link>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Empfänger prüfen kostenlos. Das Verzeichnis ist erreichbar, der zweite Schritt hier ist ein Beispiel.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Beispiel einer gesiegelten Mail</CardTitle>
            <CardDescription>Wortlaut für den Footer, noch nicht der produktive Versand.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p><span className="text-muted-foreground">Von</span> einkauf@coppen.beam.directory</p>
            <p><span className="text-muted-foreground">An</span> lieferant@beispiel.de</p>
            <Separator />
            <p>
              Diese Nachricht wurde vom KI-Agenten Einkauf im Auftrag der COPPEN GmbH erstellt. Echtheit prüfen: beam.directory/agents/einkauf@coppen.beam.directory
            </p>
            <p className="text-muted-foreground">Unterstützt die Kennzeichnung. Keine Rechtsgarantie.</p>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="problem-title">
        <h2 id="problem-title" className="font-heading text-2xl font-medium">Agenten-Mails sind heute nicht prüfbar</h2>
        <p className="max-w-3xl text-muted-foreground">
          Empfänger sehen eine Absenderadresse, aber nicht, welche Firma hinter dem Agenten steht. Seit dem 2. August 2026 müssen Anbieter von KI-Systemen, die mit Menschen interagieren, kenntlich machen, dass es sich um eine KI handelt. Beam unterstützt diese Kennzeichnung im Siegel. Die Pflicht bleibt beim Anbieter.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-3" aria-labelledby="how-title">
        <h2 id="how-title" className="sr-only">So funktioniert es</h2>
        {steps.map((step, index) => (
          <Card key={step.title}>
            <CardHeader>
              <CardDescription>0{index + 1}</CardDescription>
              <CardTitle>{step.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">{step.text}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="proof-title">
        <h2 id="proof-title" className="font-heading text-2xl font-medium">Was das Siegel beweist</h2>
        <div className="grid gap-4 md:grid-cols-3">
        {proofs.map((proof) => {
          const Icon = proof.icon
          return (
          <Card key={proof.title}>
            <CardHeader>
              <Icon />
              <CardTitle>{proof.title}</CardTitle>
            </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">{proof.text}</p>
              </CardContent>
            </Card>
          )
        })}
        </div>
        <Alert>
          <AlertTitle>Prüfen ist für Empfänger kostenlos</AlertTitle>
          <AlertDescription>
            Wer eine gesiegelte Mail bekommt, kann Firma, Domain und Prüfstatus ohne Konto und ohne Schlüssel nachsehen.
          </AlertDescription>
        </Alert>
      </section>

      <section className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]" aria-labelledby="directory-title">
        <div className="flex flex-col gap-3">
          <h2 id="directory-title" className="font-heading text-2xl font-medium">Öffentliches Verzeichnis</h2>
          <p className="text-muted-foreground">
            Gelistet wird nur, wer die Prüfung bestanden hat und dem Eintrag zugestimmt hat. Private Identitäten und nicht gelistete Agenten erscheinen nicht. E-Mail-Adressen werden nicht gezeigt.
          </p>
          <div>
            <Button variant="outline" asChild>
              <Link to="/verzeichnis">
                <SearchIcon data-icon="inline-start" />
                Verzeichnis öffnen
              </Link>
            </Button>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Pilot</CardTitle>
            <CardDescription>COPPEN ist der erste Prüfmandant.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="secondary" asChild>
              <Link to={agentPath(EXAMPLE_BEAM_ID)}>COPPEN-Beispiel prüfen</Link>
            </Button>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2" aria-labelledby="scope-title">
        <Card>
          <CardHeader>
            <CardTitle id="scope-title">Was wir prüfen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Firma laut Register, zugehörige Domain und dass der Agent zu dieser Firma gehört.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Was wir nicht versprechen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Keine Garantie für Art. 50, keine Vollmacht und keinen Marktplatz. Beides kommt erst nach den Schwellen aus dem Phasenplan.</p>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="dev-title">
        <h2 id="dev-title" className="font-heading text-2xl font-medium">Für Entwickler</h2>
        <p className="max-w-3xl text-muted-foreground">
          Die öffentliche Prüfung auf dieser Seite nutzt die bestehenden Verzeichnis-Endpunkte <span className="font-mono text-foreground">GET /agents/:beamId</span>, <span className="font-mono text-foreground">/agents/browse</span> und <span className="font-mono text-foreground">/agents/search</span>. Ein einheitliches <span className="font-mono text-foreground">POST /v1/verify</span> ist noch nicht gebaut.
        </p>
        <a className="text-sm underline underline-offset-4" href="https://docs.beam.directory">Dokumentation</a>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="pricing-title">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="pricing-title" className="font-heading text-2xl font-medium">Preise</h2>
          <Badge>{DRAFT_PRICING.notice}</Badge>
        </div>
        <Alert>
          <AlertTitle>Diese Preise sind ein Entwurf</AlertTitle>
          <AlertDescription>
            Sie stehen in einer Konstante und können sich ändern. Auf dieser Seite wird nichts bezahlt.
          </AlertDescription>
        </Alert>
        <div className="grid gap-4 md:grid-cols-3">
          {pricingLines().map((line) => (
            <Card key={line} size="sm">
              <CardHeader>
                <CardTitle>{line}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          Firmenprüfung einmalig {formatEuro(DRAFT_PRICING.companyReviewEur)}. Siegel {formatEuro(DRAFT_PRICING.monthlyEur)} pro Monat inklusive {DRAFT_PRICING.includedAgents} Agenten, jeder weitere Agent {formatEuro(DRAFT_PRICING.extraAgentMonthlyEur)} pro Monat. Pilot {formatEuro(DRAFT_PRICING.pilotEur)} für {DRAFT_PRICING.pilotDays} Tage.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2" aria-labelledby="roadmap-title">
        <h2 id="roadmap-title" className="sr-only">Ausblick</h2>
        <Card>
          <CardHeader>
            <CardDescription>Phase 2</CardDescription>
            <CardTitle>Vollmacht</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Was der Agent im Namen der Firma tun darf. Noch nicht Teil dieses Registers.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Phase 3</CardDescription>
            <CardTitle>Marktplatz</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">Geprüfte Agenten finden einander. Erst wenn das Verzeichnis dicht genug ist.</p>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="faq-title">
        <h2 id="faq-title" className="font-heading text-2xl font-medium">Fragen</h2>
        <Accordion type="single" collapsible>
          <AccordionItem value="proof">
            <AccordionTrigger>Was beweist das Siegel?</AccordionTrigger>
            <AccordionContent>Dass Firma, Domain und Inhaber geprüft sind und der Agent öffentlich zu dieser Firma gehört.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="free">
            <AccordionTrigger>Kostet die Prüfung für Empfänger etwas?</AccordionTrigger>
            <AccordionContent>Nein. Nachsehen im Verzeichnis und auf der Agentenseite ist kostenlos.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="price">
            <AccordionTrigger>Sind die Preise verbindlich?</AccordionTrigger>
            <AccordionContent>Nein. Sie sind als Entwurf markiert und können sich ändern, bevor ein Bezahlweg live ist.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="ai-act">
            <AccordionTrigger>Erfüllt das Siegel den AI Act?</AccordionTrigger>
            <AccordionContent>Es unterstützt die Kennzeichnung. Eine Garantie für Artikel 50 gibt es nicht. Das muss anwaltlich geprüft werden.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="private">
            <AccordionTrigger>Werden private Identitäten gelistet?</AccordionTrigger>
            <AccordionContent>Nein. Das Verzeichnis zeigt nur öffentliche, geprüfte Firmen-Agenten und keine E-Mail-Adressen.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>

      <section className="flex flex-col items-start gap-3">
        <h2 className="font-heading text-2xl font-medium">Siegel für die eigenen Agenten beantragen</h2>
        <Button asChild>
          <Link to="/siegel-beantragen">Siegel beantragen</Link>
        </Button>
      </section>
    </div>
  )
}
