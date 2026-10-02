import { Link } from 'react-router-dom'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SealBadge } from '@/components/seal-badge'
import { EXAMPLE_BEAM_ID, agentPath } from '@/lib/example-agent'
import { DRAFT_PRICING, formatEuro, pricingLines } from '@/lib/pricing'
import { EUR_LEX_AI_ACT, REGISTER_AS_OF } from '@/lib/register'

const flow = [
  { step: '1. Antrag', text: 'Die Firma reicht den Antrag ein. Auf dieser Seite wird nichts bezahlt und keine E-Mail verschickt.' },
  { step: '2. Prüfung', text: 'Beam prüft Firma, Domain und Inhaber. Der genaue Umfang steht in den Prüfrichtlinien.' },
  { step: '3. Siegel', text: 'Nach bestandener Prüfung trägt der öffentliche Firmenagent ein Siegel und einen Registereintrag.' },
  { step: '4. Empfänger prüft', text: 'Wer das Siegel sieht, öffnet den Eintrag und prüft ihn kostenlos, ohne Konto.' },
]

const uses = [
  {
    use: 'Agenten-Mail an Kunden und Lieferanten',
    sender: 'Agent aus Einkauf, Vertrieb oder Kundenservice',
    receiver: 'Mensch beim Kunden oder Lieferanten',
    check: 'Prüflink im Mail-Footer',
    proves: 'Die Nachricht kommt von einem KI-Agenten der geprüften Firma.',
  },
  {
    use: 'Übergabe von Agent zu Agent',
    sender: 'Agent einer Firma',
    receiver: 'Agent einer anderen Firma',
    check: 'Beam-ID im Verzeichnis',
    proves: 'Die Gegenstelle ist ein öffentlicher, geprüfter Firmenagent.',
  },
  {
    use: 'Chat- und Website-Assistent',
    sender: 'Assistent auf der Firmenseite',
    receiver: 'Besucher der Website',
    check: 'Badge oder Profillink neben dem Chat',
    proves: 'Der Assistent gehört zur geprüften Firma und ist als KI gekennzeichnet.',
  },
  {
    use: 'Telefon- und Sprachagent',
    sender: 'Sprachagent der Firma',
    receiver: 'Anrufer',
    check: 'Profillink in der Nachfass-Mail, SMS oder auf der Website',
    proves: 'Dieselbe Firmen- und KI-Kennzeichnung. Das Register prüft das Gespräch selbst nicht.',
  },
  {
    use: 'Beschaffung und Auftragsbestätigung',
    sender: 'Agent im Einkauf oder Auftragswesen',
    receiver: 'Lieferant oder Kunde',
    check: 'Prüflink in der Bestätigung',
    proves: 'Die Bestätigung ist dem geprüften Firmenagenten zugeordnet.',
  },
]

const places = [
  { place: 'Mail-Footer', detail: 'Kurze KI-Kennzeichnung und Link auf den Registereintrag.' },
  { place: 'Website-Badge', detail: 'Eingebettetes Siegel, das auf das Profil verweist.' },
  { place: 'Profil', detail: 'Öffentliche Seite mit Beam-ID, Status, Prüfdatum und Prüfumfang.' },
  { place: 'API', detail: 'GET /agents/:beamId und GET /agents/:beamId/seal.svg, ohne E-Mail.' },
]

export function LandingPage() {
  return (
    <div className="flex flex-col gap-14">
      <section className="grid items-start gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="flex flex-col gap-4">
          <p className="text-xs tracking-wide text-muted-foreground">Stand: {REGISTER_AS_OF}</p>
          <h1 className="max-w-3xl font-heading text-4xl font-semibold tracking-tight text-balance md:text-5xl">
            Das geprüfte Register für KI-Agenten.
          </h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">
            Das Siegel steht dort, wo ein Agent einer Firma mit Menschen oder anderen Agenten spricht: in der Mail, auf der Website, am Profil und in der API. Es zeigt die geprüfte Firma, die Domain und den Inhaber. Empfänger sehen denselben Eintrag und prüfen ihn kostenlos.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/siegel-beantragen">Siegel beantragen</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to={agentPath(EXAMPLE_BEAM_ID)}>Beispiel prüfen</Link>
            </Button>
          </div>
        </div>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Mail-Footer</CardTitle>
              <SealBadge />
            </div>
            <CardDescription>Beispielwortlaut. Der Versand durch Beam ist noch nicht angebunden.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm leading-6">
            <p><span className="text-muted-foreground">Von</span> Agent Einkauf, COPPEN GmbH</p>
            <p><span className="text-muted-foreground">An</span> Lieferant</p>
            <Separator />
            <p>
              Diese Nachricht wurde von einem KI-Agenten im Auftrag der COPPEN GmbH erstellt. Den Registereintrag prüft der Empfänger über den Profillink.
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4" id="ablauf" aria-labelledby="flow-title">
        <h2 id="flow-title" className="font-heading text-2xl font-semibold">So funktioniert&apos;s</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Schritt</TableHead>
              <TableHead>Was geschieht</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flow.map((row) => (
              <TableRow key={row.step}>
                <TableCell className="whitespace-normal font-medium">{row.step}</TableCell>
                <TableCell className="whitespace-normal">{row.text}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-4" id="einsatz" aria-labelledby="uses-title">
        <div className="flex flex-col gap-2">
          <h2 id="uses-title" className="font-heading text-2xl font-semibold">Einsatzbereiche</h2>
          <p className="max-w-3xl text-muted-foreground">
            Jede Zeile nennt, wer sendet, wer empfängt, woran der Empfänger den Eintrag prüft und was das Siegel dazu sagt.
          </p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Einsatz</TableHead>
              <TableHead>Absender</TableHead>
              <TableHead>Empfänger</TableHead>
              <TableHead>Prüfung</TableHead>
              <TableHead>Siegel</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {uses.map((row) => (
              <TableRow key={row.use}>
                <TableCell className="whitespace-normal font-medium">{row.use}</TableCell>
                <TableCell className="whitespace-normal">{row.sender}</TableCell>
                <TableCell className="whitespace-normal">{row.receiver}</TableCell>
                <TableCell className="whitespace-normal">{row.check}</TableCell>
                <TableCell className="whitespace-normal">{row.proves}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="places-title">
        <h2 id="places-title" className="font-heading text-2xl font-semibold">Wo das Siegel erscheint</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ort</TableHead>
              <TableHead>Was sichtbar ist</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {places.map((row) => (
              <TableRow key={row.place}>
                <TableCell className="whitespace-normal font-medium">{row.place}</TableCell>
                <TableCell className="whitespace-normal">{row.detail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-4" id="ki-verordnung" aria-labelledby="act-title">
        <h2 id="act-title" className="font-heading text-2xl font-semibold">EU AI Act, Artikel 50</h2>
        <p className="max-w-3xl leading-7 text-muted-foreground">
          Die Verordnung (EU) 2024/1689 verpflichtet Anbieter von KI-Systemen, die mit Menschen interagieren, dazu, dass diese Interaktion als KI erkennbar ist. Diese Transparenzpflichten gelten ab dem 2. August 2026. Das Siegel unterstützt die Kennzeichnung, weil der Footer und das Profil den Agenten als KI ausweisen, und die Nachvollziehbarkeit, weil der Link auf Firma, Domain, Prüfdatum und Prüfumfang im Register zeigt.
        </p>
        <p className="max-w-3xl text-sm leading-6">
          Wortlaut:{' '}
          <a className="underline underline-offset-4" href={EUR_LEX_AI_ACT}>
            Verordnung (EU) 2024/1689 auf EUR-Lex
          </a>
        </p>
        <Alert>
          <AlertTitle>Kein Rechtsrat, keine Konformitätsbewertung</AlertTitle>
          <AlertDescription>
            Dieser Abschnitt beschreibt, wobei das Siegel helfen kann. Er ist keine Rechtsberatung, keine Zertifizierung und keine Feststellung, dass ein System der Verordnung entspricht. Beam ist kein Organ der Europäischen Union und keine staatliche Stelle.
          </AlertDescription>
        </Alert>
      </section>

      <section className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]" aria-labelledby="directory-title">
        <div className="flex flex-col gap-3">
          <h2 id="directory-title" className="font-heading text-2xl font-semibold">Verzeichnis</h2>
          <p className="text-muted-foreground">
            Gelistet wird, wer die Prüfung bestanden hat und öffentlich geführt wird. Private Identitäten bleiben außen vor. E-Mail-Adressen werden nicht gezeigt.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/verzeichnis">Verzeichnis öffnen</Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link to={agentPath(EXAMPLE_BEAM_ID)}>COPPEN-Beispiel prüfen</Link>
            </Button>
          </div>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Pilot</CardTitle>
            <CardDescription>COPPEN ist der erste Prüfmandant.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Der Beispiel-Link führt auf den Registereintrag, sobald der Agent öffentlich geführt wird.
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2" aria-labelledby="scope-title">
        <Card>
          <CardHeader>
            <CardTitle id="scope-title">Prüfumfang</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>Firma, Domain und Zuordnung des Agenten zu dieser Firma. Einzelheiten und der Vermerk geplant stehen in den Prüfrichtlinien.</p>
            <Link className="text-foreground underline underline-offset-4" to="/pruefrichtlinien">Prüfrichtlinien</Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Außerhalb des Siegels</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Keine Konformitätsbewertung, keine Vollmacht und kein Marktplatz. Beides ist vorgemerkt und noch nicht geprüft.</p>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="pricing-title">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="pricing-title" className="font-heading text-2xl font-semibold">Preise</h2>
          <Badge variant="outline">{DRAFT_PRICING.notice}</Badge>
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

      <section className="flex flex-col gap-3" aria-labelledby="dev-title">
        <h2 id="dev-title" className="font-heading text-2xl font-semibold">Für Entwickler</h2>
        <p className="max-w-3xl text-muted-foreground">
          Die öffentliche Prüfung nutzt GET /agents/:beamId, /agents/browse und /agents/search. Ein einheitliches POST /v1/verify ist noch nicht gebaut.
        </p>
        <a className="text-sm underline underline-offset-4" href="https://docs.beam.directory">Dokumentation</a>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="faq-title">
        <h2 id="faq-title" className="font-heading text-2xl font-semibold">Fragen</h2>
        <Accordion type="single" collapsible>
          <AccordionItem value="proof">
            <AccordionTrigger>Was beweist das Siegel?</AccordionTrigger>
            <AccordionContent>Dass der Agent öffentlich einer geprüften Firma zugeordnet ist und Domain sowie Inhaber nach den Prüfrichtlinien geprüft wurden.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="where">
            <AccordionTrigger>Wo wird das Siegel gezeigt?</AccordionTrigger>
            <AccordionContent>Im Mail-Footer, als Badge auf der Website, auf der Profilseite und über die öffentliche API. Den Footer versendet die Firma. Beam verschickt ihn noch nicht.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="free">
            <AccordionTrigger>Kostet die Prüfung für Empfänger etwas?</AccordionTrigger>
            <AccordionContent>Nein. Nachsehen im Verzeichnis und auf der Agentenseite ist kostenlos.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="ai-act">
            <AccordionTrigger>Ist das Siegel eine AI-Act-Zertifizierung?</AccordionTrigger>
            <AccordionContent>Nein. Es unterstützt Kennzeichnung und Nachvollziehbarkeit. Eine Konformitätsbewertung ist es nicht. Der Wortlaut steht auf EUR-Lex.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>

      <section className="flex flex-col items-start gap-3 border-t pt-8">
        <h2 className="font-heading text-2xl font-semibold">Siegel für die eigenen Agenten beantragen</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">Der Antrag wird gespeichert. Prüfung, Siegel und Eintrag folgen nach den Prüfrichtlinien.</p>
        <Button asChild>
          <Link to="/siegel-beantragen">Siegel beantragen</Link>
        </Button>
      </section>
    </div>
  )
}
