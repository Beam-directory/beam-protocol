import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BuildingIcon, CheckCircle2Icon, ChevronDownIcon, CircleAlertIcon, ScrollTextIcon, ShieldCheckIcon, UserIcon } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n/context'
import { SITE_ORIGIN, intlLocale } from '@/i18n/locale'
import { describeActions } from '@/lib/plain-actions'
import { checkAgentInBrowser, parseBeamAddress } from '@/lib/verify-trust.ts'
import type { AgentCheck as TrustCheck, PublicOrg, PublicOwner, PublicScopes, VerificationLevel } from 'beam-protocol-sdk/trust-assertion'

/** One example that passes and one that does not. */
export const EXAMPLE_AGENTS = [
  'jarvis@coppen.beam.directory',
  'fake-support@beam.directory',
] as const

type Variant = 'embed' | 'page'
type CheckCopy = ReturnType<typeof useI18n>['t']['check']

function formatWhen(value: string | null, locale: string): string {
  if (!value) return '—'
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return '—'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed)
}

function localSummary(
  result: TrustCheck,
  copy: {
    verifiedPrefix: string
    notVerifiedLine: string
    onBehalfOf: (role: string) => string
    may: (scopes: string) => string
  },
): string {
  if (result.status === 'rate_limited' || result.status === 'api_error') return result.summary
  if (!result.verified || !result.org) return copy.notVerifiedLine
  const org = result.org.domain ? `${result.org.name} (${result.org.domain})` : result.org.name
  const owner = result.owner ? `, ${copy.onBehalfOf(result.owner.role)}` : ''
  const scopes = result.scopes ? `, ${copy.may(result.scopes.actions.join(', '))}` : ''
  return `${copy.verifiedPrefix} ${org}${owner}${scopes}`
}

function orgLabel(org: PublicOrg): string {
  return org.domain ? `${org.name} (${org.domain})` : org.name
}

/** The plain-language answer shown above the details. */
function verdict(result: TrustCheck, copy: CheckCopy): { tone: 'yes' | 'no' | 'unknown'; headline: string; lines: string[] } {
  if (result.status === 'rate_limited') return { tone: 'unknown', headline: copy.rateLimited, lines: [] }
  if (result.status === 'api_error') return { tone: 'unknown', headline: copy.apiError, lines: [] }
  if (result.verified && result.org) {
    const may = result.scopes ? describeActions(result.scopes.actions, result.scopes.order, copy.actions) : null
    const lines: string[] = []
    if (result.owner) lines.push(copy.actingFor(result.owner.role))
    if (!result.scopes) lines.push(copy.noScopes)
    else if (!result.scopes.actions.includes('order')) lines.push(copy.mayNot)
    return { tone: 'yes', headline: copy.yes(orgLabel(result.org), may), lines }
  }
  return { tone: 'no', headline: copy.no, lines: [reasonText(result, copy)] }
}

function reasonText(result: TrustCheck, copy: CheckCopy): string {
  switch (result.detail) {
    case 'not_found':
      return copy.reasonNotFound
    case 'no_org':
    case 'org_unverified':
      return copy.reasonUnverified
    case 'expired':
      return copy.reasonExpired
    case 'suspended':
      return copy.reasonSuspended
    case 'bad_signature':
    case 'tampered':
    case 'key_mismatch':
    case 'malformed':
      return copy.reasonSignature
    default:
      return copy.reasonOther
  }
}

export function AgentCheck({ variant }: { variant: Variant }) {
  const { t, href, locale } = useI18n()
  const copy = t.check
  const [searchParams, setSearchParams] = useSearchParams()
  const urlAgent = variant === 'page' ? (searchParams.get('agent') ?? '') : ''
  const [draft, setDraft] = useState(urlAgent)
  const [tamper, setTamper] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TrustCheck | null>(null)
  const [copied, setCopied] = useState(false)
  const requestId = useRef(0)
  const scrollLock = useRef<number | null>(null)
  const inputId = useId()
  const tamperHelpId = useId()
  const Title = variant === 'page' ? 'h1' : 'h2'

  async function run(address: string, flip: boolean) {
    const id = requestId.current + 1
    requestId.current = id
    setBusy(true)
    setError(null)
    try {
      const next = await checkAgentInBrowser(address, { tamper: flip })
      if (requestId.current !== id) return
      setResult(next)
      const locked = scrollLock.current
      if (locked != null) {
        scrollLock.current = null
        const root = document.documentElement
        const previous = root.style.scrollBehavior
        root.style.scrollBehavior = 'auto'
        window.scrollTo(0, locked)
        root.style.scrollBehavior = previous
      }
    } finally {
      if (requestId.current === id) setBusy(false)
    }
  }

  useEffect(() => {
    if (variant !== 'page' || urlAgent.length === 0) return
    const parsed = parseBeamAddress(urlAgent)
    if (!parsed) {
      setDraft(urlAgent)
      setError(copy.invalidAddress)
      setResult(null)
      return
    }
    setDraft(parsed)
    setError(null)
    setTamper(false)
    void run(parsed, false)
    // Re-check only when the shared address in the URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlAgent, variant])

  function submitAddress(raw: string) {
    const parsed = parseBeamAddress(raw)
    if (!parsed) {
      setError(copy.invalidAddress)
      setResult(null)
      return
    }
    setDraft(parsed)
    setError(null)
    setTamper(false)
    setCopied(false)
    if (variant === 'page') {
      const current = parseBeamAddress(urlAgent)
      setSearchParams({ agent: parsed }, { replace: true })
      if (current === parsed) void run(parsed, false)
      return
    }
    void run(parsed, false)
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    submitAddress(draft)
  }

  function onTamper() {
    if (!result || result.httpStatus !== 200) return
    scrollLock.current = window.scrollY
    const next = !tamper
    setTamper(next)
    void run(result.address, next)
  }

  const summary = result ? localSummary(result, copy) : ''
  const shareUrl = result && parseBeamAddress(result.address)
    ? `${SITE_ORIGIN}${href('verify')}?agent=${encodeURIComponent(result.address)}`
    : `${SITE_ORIGIN}${href('verify')}`
  const answer = result ? verdict(result, copy) : null

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section aria-labelledby="agent-check-title" data-testid="agent-check" className="beam-surface beam-check w-full rounded-2xl border p-5 sm:p-6">
      <div className="flex flex-col gap-2">
        <Title id="agent-check-title" className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {copy.title}
        </Title>
        <p className="max-w-2xl text-sm leading-6 text-pretty text-muted-foreground sm:text-base">{copy.lead}</p>
      </div>

      <form className="mt-5 flex flex-col gap-3" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="sr-only">
          {copy.addressLabel}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={inputId}
            name="address"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={copy.placeholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'agent-check-error' : undefined}
            className="h-11 font-mono text-sm"
          />
          <Button type="submit" className="h-11 rounded-full px-6" disabled={busy}>
            {busy ? copy.checking : copy.submit}
          </Button>
        </div>
        {error ? (
          <p id="agent-check-error" className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div role="group" aria-labelledby="agent-check-examples" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span id="agent-check-examples">{copy.examplesLabel}:</span>
          {EXAMPLE_AGENTS.map((address) => (
            <button
              key={address}
              type="button"
              className="rounded-md font-mono text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => submitAddress(address)}
            >
              {address}
            </button>
          ))}
        </div>
      </form>

      <div className="mt-5" aria-live="polite" aria-atomic="true" data-testid="agent-check-status">
        {busy && !result ? <p className="text-sm text-muted-foreground">{copy.checking}</p> : null}
        {result && answer ? (
          <div
            className="flex flex-col gap-3"
            data-status={result.status}
            data-detail={result.detail}
            data-verified={result.verified ? 'true' : 'false'}
          >
            <div
              className={cn(
                'flex gap-3 rounded-xl border px-4 py-4',
                answer.tone === 'yes' && 'border-success/40 bg-success/10',
                answer.tone === 'no' && 'border-destructive/40 bg-destructive/10',
                answer.tone === 'unknown' && 'bg-muted/60',
              )}
            >
              {answer.tone === 'yes'
                ? <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-success" />
                : <CircleAlertIcon aria-hidden="true" className={cn('mt-0.5 size-6 shrink-0', answer.tone === 'no' ? 'text-destructive' : 'text-muted-foreground')} />}
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-lg leading-7 font-semibold tracking-tight text-pretty" data-testid="agent-check-headline">
                  {answer.headline}
                </p>
                {answer.lines.map((line) => (
                  <p key={line} className="text-sm leading-6 text-pretty">{line}</p>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" className="h-8 rounded-full px-3 text-xs" onClick={() => void copyLink()}>
                {copied ? copy.copied : copy.copyLink}
              </Button>
            </div>

            <details data-testid="agent-check-details" className="group rounded-xl border bg-background/50">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                {copy.details}
                <ChevronDownIcon aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
              </summary>
              <div className="flex flex-col gap-4 border-t px-4 py-4">
                <p className="text-xs leading-5 text-muted-foreground">{copy.howItWorks}</p>
                {result.status !== 'rate_limited' && result.status !== 'api_error' ? (
                  <p className="font-mono text-xs leading-5 break-words text-muted-foreground">{summary}</p>
                ) : null}
                {locale === 'de' && result.summary !== summary ? (
                  <p lang="en" className="text-xs text-muted-foreground">
                    <span className="font-medium">{copy.forAgents}: </span>
                    {result.summary}
                  </p>
                ) : null}

                {result.httpStatus === 200 ? (
                  <>
                    {!result.claimsAuthenticated ? <p className="text-sm text-destructive">{copy.claimsUntrusted}</p> : null}
                    <ol key={result.address} className="grid gap-3 sm:grid-cols-3">
                      <ChainStep
                        delay="0s"
                        icon={BuildingIcon}
                        title={copy.org}
                        testId="agent-check-org"
                        body={result.org ? <OrgBody org={result.org} copy={copy} /> : <p>{copy.noOrg}</p>}
                      />
                      <ChainStep
                        delay="0.3s"
                        icon={UserIcon}
                        title={copy.person}
                        body={result.owner ? <OwnerBody owner={result.owner} copy={copy} /> : <p>{copy.personEmpty}</p>}
                      />
                      <ChainStep
                        delay="0.6s"
                        icon={ScrollTextIcon}
                        title={copy.mandate}
                        body={result.scopes ? <ScopeBody scopes={result.scopes} copy={copy} /> : <p>{copy.mandateEmpty}</p>}
                      />
                    </ol>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground">{copy.issued}</dt>
                        <dd>{formatWhen(result.issuedAt, intlLocale(locale))}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">{copy.expires}</dt>
                        <dd>{formatWhen(result.expiresAt, intlLocale(locale))}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">{copy.keyPinned}</dt>
                        <dd className="font-mono text-xs break-all">{result.pinnedKeyId}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">{copy.keyAssertion}</dt>
                        <dd className="font-mono text-xs break-all">{result.assertionKeyId ?? '—'}</dd>
                      </div>
                    </dl>
                    <p className="text-sm" data-testid="agent-check-signature">
                      <ShieldCheckIcon aria-hidden="true" className="mr-1 inline size-4" />
                      {signatureText(result.signature, copy)}
                      {result.signature === 'valid' ? ` · ${result.keyMatchesPin ? copy.keyMatch : copy.keyMismatch}` : ''}
                    </p>
                    {result.signature !== 'valid' ? (
                      <p className="text-sm text-muted-foreground">{result.keyMatchesPin ? copy.keyStillMatches : copy.keyMismatch}</p>
                    ) : null}
                    <div className="flex flex-col gap-1.5">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={tamper}
                        aria-describedby={tamperHelpId}
                        data-testid="agent-check-tamper"
                        className={cn(
                          'flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs',
                          tamper ? 'border-destructive bg-destructive/10 text-destructive' : 'bg-background text-muted-foreground',
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={onTamper}
                      >
                        {copy.tamper}
                      </button>
                      <p id={tamperHelpId} className="text-xs text-muted-foreground">
                        {copy.tamperHelp}
                      </p>
                    </div>
                  </>
                ) : null}
              </div>
            </details>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function signatureText(status: TrustCheck['signature'], copy: CheckCopy): string {
  if (status === 'valid') return copy.signatureValid
  if (status === 'tampered') return copy.signatureTampered
  if (status === 'invalid') return copy.signatureInvalid
  return copy.signatureAbsent
}

function kycText(status: string, copy: CheckCopy): string {
  const states: Record<string, string> = copy.kycStates
  return states[status] ?? status
}

function levelText(level: VerificationLevel, copy: CheckCopy): string {
  if (level === 'registry') return copy.levelRegistry
  if (level === 'domain') return copy.levelDomain
  if (level === 'unverified') return copy.levelUnverified
  return copy.levelNone
}

function ChainStep({
  title,
  body,
  icon: Icon,
  delay,
  testId,
}: {
  title: string
  body: ReactNode
  icon: typeof BuildingIcon
  delay: string
  testId?: string
}) {
  return (
    <li
      data-testid={testId}
      style={{ '--beam-delay': delay } as CSSProperties}
      className="beam-check-in flex flex-col gap-2 rounded-xl border bg-background/70 p-4 text-sm leading-6"
    >
      <span className="flex items-center gap-2 font-medium">
        <Icon aria-hidden="true" className="size-4 text-beam" />
        {title}
      </span>
      <div className="text-muted-foreground">{body}</div>
    </li>
  )
}

function OrgBody({ org, copy }: { org: PublicOrg; copy: CheckCopy }) {
  return (
    <div className="flex flex-col gap-1 text-foreground">
      <p className="font-medium">{org.name}</p>
      <p>{org.domain ? (org.verified ? `${copy.domainVerified}: ${org.domain}` : org.domain) : copy.domainMissing}</p>
      <p>
        {copy.level}: {levelText(org.level, copy)}
      </p>
    </div>
  )
}

function OwnerBody({ owner, copy }: { owner: PublicOwner; copy: CheckCopy }) {
  return (
    <div className="flex flex-col gap-1 text-foreground">
      <p className="font-medium">{owner.role}</p>
      <p className="font-mono text-xs">{copy.ref(owner.ref.slice(0, 8))}</p>
      <p>
        {copy.personCheck}: {kycText(owner.kycStatus, copy)}
      </p>
      <p>{copy.personNote}</p>
    </div>
  )
}

function ScopeBody({ scopes, copy }: { scopes: PublicScopes; copy: CheckCopy }) {
  return (
    <div className="flex flex-col gap-1 text-foreground">
      <p>
        {copy.mayLabel}: {describeActions(scopes.actions, scopes.order, copy.actions)}
      </p>
      {scopes.fileMaxBytes !== null ? <p>{copy.fileLimit(String(scopes.fileMaxBytes))}</p> : null}
      {scopes.actions.includes('order') ? null : (
        <>
          <p className="font-medium">{copy.mayNot}</p>
          <p>{copy.mayNotHeld}</p>
        </>
      )}
      <p className="font-mono text-xs text-muted-foreground">
        {copy.scopes}: {scopes.actions.join(', ')}
      </p>
    </div>
  )
}
