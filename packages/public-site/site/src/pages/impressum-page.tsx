import { Link } from 'react-router-dom'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { CONTACT_EMAIL, REGISTER_AS_OF } from '@/lib/register'

export function ImpressumPage() {
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link to="/">Register</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Impressum</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-col gap-2">
        <p className="text-xs tracking-wide text-muted-foreground">Stand: {REGISTER_AS_OF}</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Impressum</h1>
      </div>
      <div className="flex flex-col gap-4 text-sm leading-6">
        <p>
          Beam Protocol betreibt den öffentlichen Verzeichnisdienst unter beam.directory. Das Register ist ein privates Angebot. Es ist keine Stelle der Europäischen Union und keine staatliche Registerbehörde.
        </p>
        <p>
          Eine ladungsfähige Anschrift ist auf dieser Seite noch nicht veröffentlicht. Anfragen an das Register gehen an <a className="underline underline-offset-4" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. Datenschutzanfragen gehen an <a className="underline underline-offset-4" href="mailto:privacy@beam.directory">privacy@beam.directory</a>.
        </p>
        <p>
          Hinweise zur Datenverarbeitung stehen in der <a className="underline underline-offset-4" href="/privacy.html">Datenschutzerklärung</a>. Vertragsbedingungen stehen in den <a className="underline underline-offset-4" href="/terms.html">AGB</a>.
        </p>
      </div>
    </div>
  )
}
