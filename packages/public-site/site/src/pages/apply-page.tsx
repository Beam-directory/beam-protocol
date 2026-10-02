import { Link } from 'react-router-dom'
import { SignupForm } from '@/components/signup-form'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { REGISTER_AS_OF } from '@/lib/register'

export function ApplyPage() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link to="/">Register</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Siegel beantragen</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-col gap-2">
        <p className="text-xs tracking-wide text-muted-foreground">Stand: {REGISTER_AS_OF}</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Siegel beantragen</h1>
        <p className="text-muted-foreground">
          Der Antrag startet die Prüfung von Firma, Domain und Inhaber. Er wird gespeichert. Zahlung und Bestätigungsmail sind noch nicht angebunden. Nach bestandener Prüfung erscheint das Siegel im Mail-Footer, als Website-Badge, im Profil und über die API.
        </p>
      </div>
      <SignupForm />
    </div>
  )
}
