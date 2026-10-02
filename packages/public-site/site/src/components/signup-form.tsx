import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { submitSealApplication } from '@/lib/directory-client'
import { DRAFT_PRICING, formatEuro } from '@/lib/pricing'
import { buildSealApplicationPayload, validateSealApplication } from '@/lib/seal-application'

export function SignupForm() {
  const [companyName, setCompanyName] = useState('')
  const [contactName, setContactName] = useState('')
  const [email, setEmail] = useState('')
  const [domain, setDomain] = useState('')
  const [agentCount, setAgentCount] = useState('2')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = {
      companyName,
      contactName,
      email,
      domain,
      agentCount: Number(agentCount),
      message,
    }
    const validationError = validateSealApplication(input)
    if (validationError) {
      setError(validationError)
      setSaved(false)
      return
    }

    setPending(true)
    setError(null)
    try {
      // Stored via the existing directory waitlist. No payment and no email send.
      await submitSealApplication(buildSealApplicationPayload(input))
      setSaved(true)
    } catch (submitError) {
      setSaved(false)
      setError(submitError instanceof Error ? submitError.message : 'Der Antrag konnte nicht gespeichert werden.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Siegel beantragen</CardTitle>
        <CardDescription>
          Antrag für die Firmenprüfung. Es wird nichts berechnet und keine E-Mail verschickt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field data-invalid={error?.includes('Firma') || undefined}>
              <FieldLabel htmlFor="company">Firma</FieldLabel>
              <Input id="company" value={companyName} onChange={(event) => setCompanyName(event.target.value)} autoComplete="organization" required />
            </Field>
            <Field data-invalid={error?.includes('Ansprech') || undefined}>
              <FieldLabel htmlFor="contact">Ansprechperson</FieldLabel>
              <Input id="contact" value={contactName} onChange={(event) => setContactName(event.target.value)} autoComplete="name" required />
            </Field>
            <Field data-invalid={error?.includes('E-Mail') || undefined}>
              <FieldLabel htmlFor="email">E-Mail</FieldLabel>
              <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" aria-invalid={error?.includes('E-Mail') || undefined} required />
              <FieldDescription>Nur für die Prüfung des Antrags. Sie erscheint nicht im öffentlichen Verzeichnis.</FieldDescription>
            </Field>
            <Field data-invalid={error?.includes('Domain') || undefined}>
              <FieldLabel htmlFor="domain">Domain</FieldLabel>
              <Input id="domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="firma.de" aria-invalid={error?.includes('Domain') || undefined} required />
            </Field>
            <Field data-invalid={error?.includes('Agenten') || undefined}>
              <FieldLabel htmlFor="agents">Anzahl Agenten</FieldLabel>
              <Input id="agents" inputMode="numeric" value={agentCount} onChange={(event) => setAgentCount(event.target.value)} required />
              <FieldDescription>
                Entwurf: {formatEuro(DRAFT_PRICING.monthlyEur)} pro Monat inklusive {DRAFT_PRICING.includedAgents} Agenten.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="message">Nachricht</FieldLabel>
              <Textarea id="message" value={message} onChange={(event) => setMessage(event.target.value)} rows={4} />
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Field>
              <Button type="submit" disabled={pending}>
                {pending ? 'Wird gespeichert' : 'Antrag speichern'}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
      {saved ? (
        <CardFooter>
          <Alert>
            <AlertTitle>Antrag gespeichert</AlertTitle>
            <AlertDescription>
              Der Antrag liegt in der bestehenden Antragsqueue. Es wurde keine E-Mail versendet und keine Zahlung ausgelöst.
            </AlertDescription>
          </Alert>
        </CardFooter>
      ) : null}
    </Card>
  )
}
