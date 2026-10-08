import { useState, type FormEvent } from 'react'
import { DownloadIcon, GlobeIcon, KeyRoundIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { CopyField, LiveBadge, Notice, Panel, Spinner, StatusBadge, TextField, downloadJson } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { intlLocale } from '@/i18n/locale'
import { checkDomainVerification, classifyOrgConflict, createOrg, describeError, getOrg, type OrgRecord } from '@/lib/onboarding-api'
import {
  deriveOrgName,
  normalizeDomain,
  suggestDisambiguatedOrgName,
  validateDisplayName,
  validateDomain,
  validateRegistration,
  type RegistryCountry,
  type ValidationKey,
} from '@/lib/onboarding-steps'

export function StepFirma({ progress, update, secrets, setSecrets }: StepProps) {
  const { t, locale } = useI18n()
  const copy = t.onboarding.firma
  const [pending, setPending] = useState<'claim' | 'check' | 'resume' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ displayName?: ValidationKey | null; domain?: ValidationKey | null }>({})
  const [dnsResult, setDnsResult] = useState<{ records: string[] } | null>(null)
  const [resumeMode, setResumeMode] = useState(false)
  const [resumeName, setResumeName] = useState(progress.orgName)
  const [resumeKey, setResumeKey] = useState('')
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [suffixUnsupported, setSuffixUnsupported] = useState(false)

  const orgName = deriveOrgName(progress.domain)
  const claimed = Boolean(progress.orgName && secrets.orgApiKey)
  const needsResume = Boolean(progress.orgName && !secrets.orgApiKey)

  function formatDateTime(value: string | null): string | null {
    if (!value) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  }

  function applyOrg(org: OrgRecord) {
    update({
      orgName: org.name,
      displayName: org.displayName || progress.displayName,
      domain: org.domain || progress.domain,
      orgVerified: org.verified,
      txtName: org.verification?.txtName ?? progress.txtName,
      txtValue: org.verification?.txtValue ?? progress.txtValue,
      claimExpiresAt: org.claimExpiresAt,
    })
  }

  async function claimWith(name: string, isSuggestion: boolean) {
    setPending('claim')
    setError(null)
    setSuffixUnsupported(false)
    try {
      const org = await createOrg({ name, displayName: progress.displayName.trim(), domain: normalizeDomain(progress.domain) })
      setSecrets({ orgApiKey: org.apiKey, orgKeySaved: false })
      setSuggestion(null)
      applyOrg(org)
    } catch (claimError) {
      const conflict = classifyOrgConflict(claimError)
      if (isSuggestion && conflict === 'suffix-not-supported') {
        // The current backend only accepts the plain label; no claim was created.
        setSuffixUnsupported(true)
        return
      }
      setSuggestion(conflict === 'name' && !isSuggestion ? suggestDisambiguatedOrgName(progress.domain) : null)
      setError(describeError(claimError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors = { displayName: validateDisplayName(progress.displayName), domain: validateDomain(progress.domain) }
    setFieldErrors(errors)
    if (errors.displayName || errors.domain) return
    setSuggestion(null)
    await claimWith(orgName, false)
  }

  async function onResume(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!resumeName.trim() || !resumeKey.trim()) {
      setError(copy.enterBoth)
      return
    }
    setPending('resume')
    setError(null)
    try {
      const org = await getOrg(resumeName.trim().toLowerCase(), resumeKey.trim())
      setSecrets({ orgApiKey: resumeKey.trim(), orgKeySaved: true })
      applyOrg(org)
      setResumeMode(false)
      setResumeKey('')
    } catch (resumeError) {
      setError(describeError(resumeError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onCheckDns() {
    if (!secrets.orgApiKey) return
    setPending('check')
    setError(null)
    try {
      const result = await checkDomainVerification(progress.orgName, secrets.orgApiKey)
      if (result.verified) {
        applyOrg(result.org)
        setDnsResult(null)
      } else {
        setDnsResult({ records: result.records })
      }
    } catch (checkError) {
      setError(describeError(checkError, t.errors))
    } finally {
      setPending(null)
    }
  }

  function saveOrgKey() {
    if (!secrets.orgApiKey) return
    downloadJson(`beam-org-${progress.orgName}.json`, {
      format: 'beam-org-credential',
      version: 1,
      org: progress.orgName,
      domain: progress.domain,
      apiKey: secrets.orgApiKey,
      notice: copy.orgKeyFileNotice,
    })
    setSecrets({ orgKeySaved: true })
  }

  const registryError = progress.registrationNumber || progress.legalName
    ? validateRegistration(progress.registryCountry, progress.registrationNumber, progress.legalName)
    : null
  const expires = formatDateTime(progress.claimExpiresAt)

  return (
    <div className="flex flex-col gap-5">
      <Panel title={copy.domainPanel} badge={progress.orgVerified ? <StatusBadge tone="success">{copy.domainVerified}</StatusBadge> : <LiveBadge />}>
        {!claimed && !resumeMode ? (
          needsResume ? (
            <Notice tone="warning" title={copy.resumeTitle}>
              {copy.resumeBefore} <span className="font-mono text-foreground">{progress.orgName}</span> {copy.resumeAfter}
              <div className="mt-2">
                <Button type="button" variant="outline" className="h-8 rounded-full px-3" onClick={() => setResumeMode(true)}>{copy.enterOrgKey}</Button>
              </div>
            </Notice>
          ) : (
            <form onSubmit={onClaim} className="flex flex-col gap-4" noValidate>
              <p className="text-sm leading-6 text-muted-foreground">{copy.claimIntro}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="org-display-name"
                  label={copy.companyName}
                  value={progress.displayName}
                  onChange={(value) => update({ displayName: value })}
                  autoComplete="organization"
                  placeholder={copy.companyPlaceholder}
                  error={fieldErrors.displayName ? t.validation[fieldErrors.displayName] : null}
                />
                <TextField
                  id="org-domain"
                  label={copy.domain}
                  value={progress.domain}
                  onChange={(value) => {
                    update({ domain: value })
                    setSuggestion(null)
                    setSuffixUnsupported(false)
                  }}
                  inputMode="url"
                  autoComplete="url"
                  placeholder={copy.domainPlaceholder}
                  error={fieldErrors.domain ? t.validation[fieldErrors.domain] : null}
                  description={orgName ? <>{copy.namespaceLabel} <span className="font-mono text-foreground">{orgName}</span>{copy.agentsNamed(orgName)}</> : copy.domainHelp}
                />
              </div>
              {error ? <Notice tone="error">{error}</Notice> : null}
              {suggestion && !suffixUnsupported ? (
                <div className="flex flex-col items-start gap-2 rounded-xl border p-3.5 text-sm">
                  <p className="text-muted-foreground">
                    {copy.suggestionLead} <span className="font-mono text-foreground">{suggestion}</span>{copy.agentsNamed(suggestion)}.
                  </p>
                  <Button type="button" variant="outline" className="h-9 rounded-full px-4" disabled={pending !== null} onClick={() => void claimWith(suggestion, true)}>
                    {pending === 'claim' ? <Spinner label={copy.creating} /> : copy.createAs(suggestion)}
                  </Button>
                </div>
              ) : null}
              {suffixUnsupported && suggestion ? (
                <ComingSoonCard capability="suffixedOrgName" title={copy.suffixTitle(suggestion)} company={progress.displayName}>
                  {copy.suffixText}
                </ComingSoonCard>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" className="h-10 rounded-full px-5" disabled={pending !== null}>
                  {pending === 'claim' ? <Spinner label={copy.creating} /> : <><GlobeIcon aria-hidden="true" /> {copy.claim}</>}
                </Button>
                <button type="button" onClick={() => { setResumeMode(true); setError(null) }} className="rounded-md text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  {copy.haveKey}
                </button>
              </div>
            </form>
          )
        ) : null}

        {resumeMode ? (
          <form onSubmit={onResume} className="flex flex-col gap-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="resume-name" label={copy.namespace} value={resumeName} onChange={setResumeName} placeholder="company" autoComplete="off" />
              <TextField id="resume-key" label={copy.orgKey} type="password" value={resumeKey} onChange={setResumeKey} placeholder="beam_org_…" autoComplete="off" />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{copy.keyMemoryNote}</p>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" className="h-10 rounded-full px-5" disabled={pending !== null}>
                {pending === 'resume' ? <Spinner label={copy.checking} /> : copy.resume}
              </Button>
              <button type="button" onClick={() => { setResumeMode(false); setError(null) }} className="rounded-md text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                {copy.cancel}
              </button>
            </div>
          </form>
        ) : null}

        {claimed ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <KeyRoundIcon aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-400" />
                {copy.orgKeyFor(progress.orgName)}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">{copy.orgKeyText}</p>
              {secrets.orgApiKey ? <CopyField label={copy.orgKey} value={secrets.orgApiKey} secret /> : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" className="h-9 rounded-full px-4" onClick={saveOrgKey}>
                  <DownloadIcon aria-hidden="true" /> {copy.saveAsFile}
                </Button>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--beam)]"
                    checked={secrets.orgKeySaved}
                    onChange={(event) => setSecrets({ orgKeySaved: event.target.checked })}
                  />
                  {copy.keySaved}
                </label>
              </div>
            </div>

            {progress.orgVerified ? (
              <Notice tone="success" title={copy.domainVerified}>
                <span className="font-mono text-foreground">{progress.domain}</span> {copy.verifiedBelongs} <span className="font-mono text-foreground">{progress.orgName}</span>.
              </Notice>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm leading-6 text-muted-foreground">
                  {copy.txtIntro}
                  {expires ? copy.claimExpires(expires) : null}
                </p>
                <div className="grid gap-3">
                  <CopyField label={copy.txtHost} value={progress.txtName} />
                  <CopyField label={copy.txtValue} value={progress.txtValue} />
                </div>
                {dnsResult ? (
                  <Notice tone="warning" title={copy.notFoundTitle}>
                    {copy.notFoundText}
                    {dnsResult.records.length > 0 ? <> {copy.found} <span className="font-mono break-all text-foreground">{dnsResult.records.join(', ')}</span></> : copy.noRecord}
                  </Notice>
                ) : null}
                {error ? <Notice tone="error">{error}</Notice> : null}
                <div>
                  <Button type="button" className="h-10 rounded-full px-5" onClick={() => void onCheckDns()} disabled={pending !== null}>
                    {pending === 'check' ? <Spinner label={copy.checking} /> : <><RefreshCwIcon aria-hidden="true" /> {copy.checkDns}</>}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Panel>

      <Panel title={copy.registryPanel} badge={<LiveBadge>{copy.registryBadge}</LiveBadge>}>
        <p className="text-sm leading-6 text-muted-foreground">{copy.registryText}</p>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">{copy.registryCountry}</legend>
          <div className="flex flex-wrap gap-2">
            {(['DE', 'UK'] as RegistryCountry[]).map((country) => (
              <label key={country} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-[:checked]:border-beam has-[:checked]:bg-beam/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                <input
                  type="radio"
                  name="registry-country"
                  value={country}
                  className="accent-[var(--beam)]"
                  checked={progress.registryCountry === country}
                  onChange={() => update({ registryCountry: country })}
                />
                {copy.countries[country]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="registry-number"
            label={progress.registryCountry === 'DE' ? copy.registerNumber : copy.companyNumber}
            value={progress.registrationNumber}
            onChange={(value) => update({ registrationNumber: value })}
            placeholder={progress.registryCountry === 'DE' ? 'HRB 123456' : '01234567'}
            autoComplete="off"
          />
          <TextField
            id="registry-legal-name"
            label={copy.legalName}
            value={progress.legalName}
            onChange={(value) => update({ legalName: value })}
            placeholder={copy.legalPlaceholder}
            autoComplete="organization"
          />
        </div>
        {registryError ? <p className="text-xs text-destructive">{t.validation[registryError]}</p> : null}
      </Panel>

      <div className="grid gap-4 md:grid-cols-3">
        <ComingSoonCard capability="verifyDomainByWellKnownFile" title={copy.wellKnownTitle} company={progress.displayName}>
          {copy.wellKnownText}
        </ComingSoonCard>
        <ComingSoonCard capability="lookupLei" title={copy.leiTitle} company={progress.displayName}>
          {copy.leiText}
        </ComingSoonCard>
        <ComingSoonCard capability="checkPowerOfRepresentation" title={copy.porTitle} company={progress.displayName}>
          {copy.porText}
        </ComingSoonCard>
      </div>
    </div>
  )
}
