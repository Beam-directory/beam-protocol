import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Panel, Notice, SoonBadge, Spinner, TextField } from '@/components/onboarding/primitives'
import { describeError, registerInterest, type Capability } from '@/lib/onboarding-api'
import { validateEmail } from '@/lib/onboarding-steps'
import { CONTACT_EMAIL } from '@/lib/register'

/**
 * UI for a capability whose backend does not exist yet. It never shows a verified or completed state.
 * "Interesse melden" stores a waitlist entry via the existing /waitlist endpoint; mailto is the fallback.
 */
export function ComingSoonCard({
  capability, title, children, company,
}: {
  capability: Capability
  title: string
  children: ReactNode
  company?: string
}) {
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [honeypot, setHoneypot] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState(false)
  const mailto = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(`Interesse: ${title}`)}`

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = validateEmail(email)
    if (invalid) {
      setError(invalid)
      return
    }
    setPending(true)
    setError(null)
    try {
      await registerInterest({ email, company, capability, note: title, honeypot })
      setSaved(true)
    } catch (submitError) {
      setError(describeError(submitError))
    } finally {
      setPending(false)
    }
  }

  return (
    <Panel title={title} badge={<SoonBadge />} className="border-dashed bg-transparent">
      <div className="text-sm leading-6 text-muted-foreground">{children}</div>
      {saved ? (
        <Notice tone="success" title="Interesse gespeichert">
          Wir melden uns, sobald diese Funktion bereitsteht. Das ist keine Prüfung und schaltet nichts frei.
        </Notice>
      ) : open ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label={`Interesse an ${title}`}>
          <input
            name="hp_company"
            value={honeypot}
            onChange={(event) => setHoneypot(event.target.value)}
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            className="hidden"
          />
          <TextField
            id={`${formId}-email`}
            label="E-Mail für die Benachrichtigung"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            error={error}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="outline" className="h-9 rounded-full px-4" disabled={pending}>
              {pending ? <Spinner label="Wird gespeichert" /> : 'Interesse melden'}
            </Button>
            <a href={mailto} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Lieber per E-Mail
            </a>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" className="h-9 rounded-full px-4" onClick={() => setOpen(true)}>
            Interesse melden
          </Button>
          <a href={mailto} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Per E-Mail anfragen
          </a>
        </div>
      )}
    </Panel>
  )
}
