import { Link } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { REGISTER_AS_OF } from '@/lib/register'

const checks = [
  {
    subject: 'Öffentlicher Eintrag',
    how: 'Das Verzeichnis und die Profilseite zeigen einen Agenten, wenn die Sichtbarkeit public ist. Nicht gelistete und private Einträge antworten für Unbefugte mit 404. Inhaber und Administratoren mit demselben Zugriff wie bei verwalteten Agenten sehen sie weiter.',
    status: 'umgesetzt',
  },
  {
    subject: 'Firmenagent',
    how: 'Ein Siegel setzt eine Organisation, keinen persönlichen Account und keinen markierten Eintrag voraus.',
    status: 'umgesetzt',
  },
  {
    subject: 'Domain des Agenten',
    how: 'Der Inhaber legt einen DNS-TXT-Eintrag unter _beam-verify.<domain> mit dem Prüfwert beam-verify=<token> ab. Der Verzeichnisdienst vergleicht den Eintrag. Das Token erscheint in der öffentlichen Domain-Auskunft nicht.',
    status: 'umgesetzt',
  },
  {
    subject: 'Domain der Organisation',
    how: 'Der Organisationsname wird über einen DNS-TXT-Eintrag unter _beam-verification.<domain> bestätigt.',
    status: 'umgesetzt',
  },
  {
    subject: 'Firma, Deutschland',
    how: 'Die Registernummer muss dem Format HRB oder HRA mit Ziffern entsprechen. Die Freigabe erfolgt manuell durch eine Administration, mit Belegreferenz und nur nach verifizierter Domain. Ein automatischer Abruf des Handelsregisters ist nicht angebunden. Die Quelle heißt manual-registry-review.',
    status: 'umgesetzt',
  },
  {
    subject: 'Firma, Vereinigtes Königreich',
    how: 'Die Nummer wird gegen Companies House geprüft, sofern der Zugang konfiguriert ist. Die Freigabe bleibt danach eine manuelle Entscheidung und verlangt ebenfalls eine verifizierte Domain.',
    status: 'umgesetzt',
  },
  {
    subject: 'Siegeldatei',
    how: 'GET /agents/:beamId/seal.svg liefert ein SVG nur für öffentliche, geprüfte Firmenagenten der Stufen verified, business oder enterprise. Die Datei enthält keine E-Mail-Adresse.',
    status: 'umgesetzt',
  },
  {
    subject: 'Empfängerprüfung',
    how: 'Profil, Suche und Browse sind ohne Konto abrufbar. Öffentliche Antworten enthalten keine E-Mail.',
    status: 'umgesetzt',
  },
]

const planned = [
  { subject: 'Einheitlicher Prüfaufruf POST /v1/verify', status: 'geplant' },
  { subject: 'Versand des Mail-Footers durch Beam', status: 'geplant' },
  { subject: 'Zahlung', status: 'geplant' },
  { subject: 'Vollmacht, was der Agent tun darf', status: 'geplant' },
  { subject: 'Marktplatz geprüfter Agenten', status: 'geplant' },
  { subject: 'Unabhängige Prüfstelle außerhalb der Administration', status: 'geplant' },
  { subject: 'Automatischer Abruf des deutschen Handelsregisters', status: 'geplant' },
  { subject: 'Konformitätsbewertung nach der Verordnung (EU) 2024/1689', status: 'geplant' },
]

export function GuidelinesPage() {
  return (
    <div className="flex flex-col gap-8">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link to="/">Register</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Prüfrichtlinien</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-col gap-2">
        <p className="text-xs tracking-wide text-muted-foreground">Stand: {REGISTER_AS_OF}</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Prüfrichtlinien</h1>
        <p className="max-w-3xl text-muted-foreground">
          Diese Seite beschreibt die Prüfungen, die das Verzeichnis heute ausführt. Punkte mit dem Vermerk geplant sind angekündigt und noch nicht Teil des Siegels.
        </p>
      </div>
      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-2xl font-semibold">Umgesetzte Prüfungen</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Gegenstand</TableHead>
            <TableHead>Wie geprüft wird</TableHead>
            <TableHead>Stand</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {checks.map((row) => (
            <TableRow key={row.subject}>
              <TableCell className="whitespace-normal font-medium">{row.subject}</TableCell>
              <TableCell className="whitespace-normal">{row.how}</TableCell>
              <TableCell><Badge variant="secondary">{row.status}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-2xl font-semibold">Noch nicht Bestandteil der Prüfung</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Gegenstand</TableHead>
            <TableHead>Stand</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {planned.map((row) => (
            <TableRow key={row.subject}>
              <TableCell className="whitespace-normal">{row.subject}</TableCell>
              <TableCell><Badge variant="outline">{row.status}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </section>
      <Alert>
        <AlertTitle>Kein Rechtsrat, keine Konformitätsbewertung</AlertTitle>
        <AlertDescription>
          Die Richtlinien erklären den technischen Prüfablauf. Sie bewerten nicht, ob ein System einer gesetzlichen Pflicht entspricht.
        </AlertDescription>
      </Alert>
    </div>
  )
}
