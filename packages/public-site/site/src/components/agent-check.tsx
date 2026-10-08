import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BuildingIcon, ScrollTextIcon, ShieldCheckIcon, UserIcon } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n/context'
import { SITE_ORIGIN, intlLocale } from '@/i18n/locale'
import { checkAgentInBrowser, parseBeamAddress } from '@/lib/verify-trust.ts'
import type { AgentCheck as TrustCheck, PublicOrg, PublicOwner, PublicScopes, VerificationLevel } from 'beam-protocol-sdk/trust-assertion'

export const EXAMPLE_AGENTS = [
  'jarvis@coppen.beam.directory',
  'clara@coppen.beam.directory',
  'fischer@coppen.beam.directory',
  'wrenda@beam.directory',
  'fake-support@beam.directory',
] as const

type Variant = 'embed' | 'page'

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
  const sharePath = result && parseBeamAddress(result.address)
    ? `${href('verify')}?agent=${encodeURIComponent(result.address)}`
    : href('verify')
  const shareUrl = `${SITE_ORIGIN}${sharePath}`

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const headline = !result
    ? ''
    : result.status === 'rate_limited'
      ? copy.rateLimited
      : result.status === 'api_error'
        ? copy.apiError
        : result.verified
          ? copy.verified
          : copy.notVerified

  return (
    <section aria-labelledby="agent-check-title" data-testid="agent-check" className="beam-surface beam-check w-full rounded-2xl border p-5 sm:p-6">
      <div className="flex flex-col gap-2">
        <Title id="agent-check-title" className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {copy.title}
        </Title>
        <p className="max-w-2xl text-sm leading-6 text-pretty text-muted-foreground sm:text-base">{copy.lead}</p>
      </div>

      <form className="mt-5 flex flex-col gap-3" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="text-sm font-medium">
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
          <Button type="submit" className="h-11 rounded-full px-5" disabled={busy}>
            {busy ? copy.checking : copy.submit}
          </Button>
        </div>
        {error ? (
          <p id="agent-check-error" className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <p id="agent-check-examples" className="text-xs font-medium text-muted-foreground">
            {copy.examplesLabel}
          </p>
          <div role="group" aria-labelledby="agent-check-examples" className="flex flex-wrap gap-2">
            {EXAMPLE_AGENTS.map((address) => (
              <button
                key={address}
                type="button"
                className="rounded-full border bg-background px-3 py-1.5 font-mono text-xs text-foreground hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => submitAddress(address)}
              >
                {address}
              </button>
            ))}
          </div>
        </div>
      </form>

      <div className="mt-5" aria-live="polite" aria-atomic="true" data-testid="agent-check-status">
        {busy && !result ? <p className="text-sm text-muted-foreground">{copy.checking}</p> : null}
        {result ? (
          <div
            className="flex flex-col gap-4"
            data-status={result.status}
            data-detail={result.detail}
            data-verified={result.verified ? 'true' : 'false'}
          >
            <div
              className={cn(
                'rounded-xl border px-4 py-3',
                result.verified ? 'border-success/40 bg-success/10' : 'border-destructive/40 bg-destructive/10',
              )}
            >
              <p className="text-lg font-semibold tracking-tight" data-testid="agent-check-headline">
                {headline}
              </p>
              {detailText(result, copy) ? <p className="mt-1 text-sm leading-6">{detailText(result, copy)}</p> : null}
              {result.status !== 'rate_limited' && result.status !== 'api_error' ? (
                <p className="mt-2 font-mono text-xs leading-5 text-muted-foreground">{summary}</p>
              ) : null}
            </div>

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
                    delay="0.6s"
                    icon={UserIcon}
                    title={copy.person}
                    body={result.owner ? <OwnerBody owner={result.owner} copy={copy} /> : <p>{copy.personEmpty}</p>}
                  />
                  <ChainStep
                    delay="1.2s"
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
                <button
                  type="button"
                  role="switch"
                  aria-checked={tamper}
                  aria-describedby={tamperHelpId}
                  data-testid="agent-check-tamper"
                  className={cn(
                    'flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-sm',
                    tamper ? 'border-destructive bg-destructive/10 text-destructive' : 'bg-background',
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onTamper}
                >
                  {copy.tamper}
                </button>
                <p id={tamperHelpId} className="text-xs text-muted-foreground">
                  {copy.tamperHelp}
                </p>
              </>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <p className="text-sm font-medium">{copy.share}</p>
              <p className="font-mono text-xs break-all text-muted-foreground">{shareUrl}</p>
              <Button type="button" variant="outline" className="h-9 rounded-full" onClick={() => void copyLink()}>
                {copied ? copy.copied : copy.copyLink}
              </Button>
            </div>
            {locale === 'de' && result.summary !== summary ? (
              <p lang="en" className="text-xs text-muted-foreground">
                <span className="font-medium">{copy.forAgents}: </span>
                {result.summary}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function detailText(result: TrustCheck, copy: ReturnType<typeof useI18n>['t']['check']): string {
  if (result.detail === 'not_found') return copy.notFoundDetail
  if (result.detail === 'expired') return copy.expired
  if (result.detail === 'suspended') return copy.suspended
  if (result.detail === 'no_org' || result.detail === 'org_unverified') return copy.unverifiedDetail
  if (result.detail === 'tampered') return copy.signatureTampered
  if (result.verified) return ''
  if (result.status === 'rate_limited' || result.status === 'api_error') return ''
  return copy.notVerifiedLine
}

function signatureText(status: TrustCheck['signature'], copy: ReturnType<typeof useI18n>['t']['check']): string {
  if (status === 'valid') return copy.signatureValid
  if (status === 'tampered') return copy.signatureTampered
  if (status === 'invalid') return copy.signatureInvalid
  return copy.signatureAbsent
}

function levelText(level: VerificationLevel, copy: ReturnType<typeof useI18n>['t']['check']): string {
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

function OrgBody({ org, copy }: { org: PublicOrg; copy: ReturnType<typeof useI18n>['t']['check'] }) {
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

function OwnerBody({ owner, copy }: { owner: PublicOwner; copy: ReturnType<typeof useI18n>['t']['check'] }) {
  return (
    <div className="flex flex-col gap-1 text-foreground">
      <p className="font-medium">{owner.role}</p>
      <p className="font-mono text-xs">{copy.ref(owner.ref.slice(0, 8))}</p>
      <p>{copy.personNote}</p>
    </div>
  )
}

function ScopeBody({ scopes, copy }: { scopes: PublicScopes; copy: ReturnType<typeof useI18n>['t']['check'] }) {
  return (
    <div className="flex flex-col gap-1 text-foreground">
      <p>
        {copy.scopes}: {scopes.actions.join(', ')}
      </p>
      {scopes.order ? <p>{copy.orderLimit(scopes.order.maxAmount, scopes.order.currency)}</p> : null}
      {scopes.fileMaxBytes !== null ? <p>{copy.fileLimit(String(scopes.fileMaxBytes))}</p> : null}
    </div>
  )
}
