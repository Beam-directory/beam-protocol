import { useState, type FormEvent } from 'react'
import { DownloadIcon, GlobeIcon, KeyRoundIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { CopyField, LiveBadge, Notice, Panel, SelectField, Spinner, StatusBadge, TextField, downloadJson } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { intlLocale } from '@/i18n/locale'
import {
  checkDomainVerification,
  createOrg,
  describeError,
  getOrg,
  submitOrgRegistry,
  type OrgRecord,
  type RegistryFiling,
} from '@/lib/onboarding-api'
import {
  APPLICANT_ROLES,
  deriveOrgName,
  normalizeDomain,
  pendingClaimName,
  validateDisplayName,
  validateDomain,
  validateRegistry,
  type RegistryKind,
  type ValidationKey,
} from '@/lib/onboarding-steps'

export function StepFirma({ progress, update, secrets, setSecrets }: StepProps) {
  const { t, locale } = useI18n()
  const copy = t.onboarding.firma
  const [pending, setPending] = useState<'claim' | 'dns' | 'file' | 'resume' | 'registry' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ displayName?: ValidationKey | null; domain?: ValidationKey | null }>({})
  const [dnsResult, setDnsResult] = useState<{ records: string[] } | null>(null)
  const [fileResult, setFileResult] = useState<string | null>(null)
  const [resumeMode, setResumeMode] = useState(false)
  const [resumeName, setResumeName] = useState(progress.orgName)
  const [resumeKey, setResumeKey] = useState('')
  const [filing, setFiling] = useState<RegistryFiling | null>(progress.registryStatus ? {
    id: 0,
    kind: progress.registryKind,
    country: progress.registryKind === 'lei' ? progress.leiCountry : 'DE',
    registrationNumber: progress.registrationNumber,
    registerCourt: progress.registerCourt || null,
    legalName: progress.legalName,
    applicantName: progress.applicantName,
    applicantRole: progress.applicantRole,
    status: progress.registryStatus,
  } : null)
  const [registryError, setRegistryError] = useState<string | null>(null)

  const shortName = deriveOrgName(progress.domain)
  const storedPreview = pendingClaimName(progress.domain)
  const claimed = Boolean(progress.orgName && secrets.orgApiKey)
  const needsResume = Boolean(progress.orgName && !secrets.orgApiKey)
  const registryInvalid = validateRegistry({
    kind: progress.registryKind,
    registrationNumber: progress.registrationNumber,
    legalName: progress.legalName,
    registerCourt: progress.registerCourt,
    applicantName: progress.applicantName,
    applicantRole: progress.applicantRole,
    leiCountry: progress.leiCountry,
  })

  function formatDateTime(value: string | null): string | null {
    if (!value) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  }

  function applyOrg(org: OrgRecord) {
    update({
      orgName: org.name,
      requestedOrgName: org.requestedName || shortName,
      displayName: org.displayName || progress.displayName,
      domain: org.domain || progress.domain,
      orgVerified: org.verified,
      domainVerifiedVia: org.domainVerifiedVia,
      txtName: org.verification?.txtName ?? progress.txtName,
      txtValue: org.verification?.txtValue ?? progress.txtValue,
      wellKnownUrl: org.verification?.wellKnownUrl ?? progress.wellKnownUrl,
      wellKnownBody: org.verification?.wellKnownBody ?? progress.wellKnownBody,
      claimExpiresAt: org.claimExpiresAt,
    })
  }

  async function onClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors = { displayName: validateDisplayName(progress.displayName), domain: validateDomain(progress.domain) }
    setFieldErrors(errors)
    if (errors.displayName || errors.domain) return
    setPending('claim')
    setError(null)
    try {
      const org = await createOrg({ name: shortName, displayName: progress.displayName.trim(), domain: normalizeDomain(progress.domain) })
      setSecrets({ orgApiKey: org.apiKey, orgKeySaved: false })
      applyOrg(org)
    } catch (claimError) {
      setError(describeError(claimError, t.errors))
    } finally {
      setPending(null)
    }
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

  async function onCheck(method: 'dns' | 'well-known') {
    if (!secrets.orgApiKey) return
    setPending(method === 'dns' ? 'dns' : 'file')
    setError(null)
    try {
      const result = await checkDomainVerification(progress.orgName, secrets.orgApiKey, method)
      if (result.verified) {
        applyOrg(result.org)
        setDnsResult(null)
        setFileResult(null)
      } else if (method === 'dns') {
        setDnsResult({ records: result.records })
      } else {
        setFileResult(copy.fileMissing)
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
      requestedName: progress.requestedOrgName,
      domain: progress.domain,
      apiKey: secrets.orgApiKey,
      notice: copy.orgKeyFileNotice,
    })
    setSecrets({ orgKeySaved: true })
  }

  async function onSubmitRegistry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!secrets.orgApiKey || registryInvalid) return
    setPending('registry')
    setRegistryError(null)
    try {
      const result = await submitOrgRegistry(progress.orgName, secrets.orgApiKey, progress.registryKind === 'lei'
        ? {
            kind: 'lei',
            country: progress.leiCountry.trim().toUpperCase(),
            registrationNumber: progress.registrationNumber.trim().toUpperCase(),
            legalName: progress.legalName.trim(),
            applicantName: progress.applicantName.trim(),
            applicantRole: progress.applicantRole,
          }
        : {
            kind: 'handelsregister',
            country: 'DE',
            registrationNumber: progress.registrationNumber.trim(),
            registerCourt: progress.registerCourt.trim(),
            legalName: progress.legalName.trim(),
            applicantName: progress.applicantName.trim(),
            applicantRole: progress.applicantRole,
          })
      setFiling(result)
      update({ registryStatus: result.status, registrationNumber: result.registrationNumber })
    } catch (submitError) {
      setRegistryError(describeError(submitError, t.errors))
    } finally {
      setPending(null)
    }
  }

  const expires = formatDateTime(progress.claimExpiresAt)
  const showRegistryErrors = Boolean(progress.registrationNumber || progress.legalName || progress.applicantName)

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
                  onChange={(value) => update({ domain: value })}
                  inputMode="url"
                  autoComplete="url"
                  placeholder={copy.domainPlaceholder}
                  error={fieldErrors.domain ? t.validation[fieldErrors.domain] : null}
                  description={shortName && storedPreview
                    ? <>{copy.namespaceAfter} <span className="font-mono text-foreground">{shortName}</span>{copy.agentsNamed(shortName)} {copy.pendingClaim(storedPreview)}</>
                    : copy.domainHelp}
                />
              </div>
              {error ? <Notice tone="error">{error}</Notice> : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button id="claim-domain" type="submit" className="h-10 rounded-full px-5" disabled={pending !== null}>
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
              <TextField id="resume-name" label={copy.namespace} value={resumeName} onChange={setResumeName} placeholder="company--com" autoComplete="off" />
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
                <span className="font-mono text-foreground">{progress.domain}</span> {copy.verifiedBelongs}{' '}
                <span className="font-mono text-foreground">{progress.orgName}</span>
                {progress.domainVerifiedVia ? <> ({progress.domainVerifiedVia === 'dns' ? copy.viaDns : copy.viaFile})</> : null}.
              </Notice>
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-sm leading-6 text-muted-foreground">
                  {copy.storedAs} <span className="font-mono text-foreground">{progress.orgName}</span>.
                  {progress.requestedOrgName && progress.requestedOrgName !== progress.orgName
                    ? <> {copy.promotesTo} <span className="font-mono text-foreground">{progress.requestedOrgName}</span>.</>
                    : null}
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
                <div>
                  <Button id="check-dns" type="button" className="h-10 rounded-full px-5" onClick={() => void onCheck('dns')} disabled={pending !== null}>
                    {pending === 'dns' ? <Spinner label={copy.checking} /> : <><RefreshCwIcon aria-hidden="true" /> {copy.checkDns}</>}
                  </Button>
                </div>
                <div className="flex flex-col gap-3 border-t pt-4">
                  <p className="text-sm font-medium">{copy.wellKnownTitle}</p>
                  <p className="text-sm leading-6 text-muted-foreground">{copy.wellKnownText}</p>
                  <CopyField label={copy.wellKnownUrl} value={progress.wellKnownUrl} />
                  <CopyField label={copy.wellKnownBody} value={progress.wellKnownBody} />
                  {fileResult ? <Notice tone="warning" title={copy.fileMissingTitle}>{fileResult}</Notice> : null}
                  <div>
                    <Button id="check-file" type="button" variant="outline" className="h-10 rounded-full px-5" onClick={() => void onCheck('well-known')} disabled={pending !== null}>
                      {pending === 'file' ? <Spinner label={copy.checking} /> : copy.checkFile}
                    </Button>
                  </div>
                </div>
                {error ? <Notice tone="error">{error}</Notice> : null}
              </div>
            )}
          </div>
        ) : null}
      </Panel>

      <Panel
        title={copy.registryPanel}
        badge={filing
          ? <StatusBadge tone="pending">{copy.reviewPending}</StatusBadge>
          : <LiveBadge>{copy.registryBadge}</LiveBadge>}
      >
        <p className="text-sm leading-6 text-muted-foreground">{copy.registryText}</p>
        {filing ? (
          <Notice tone="info" title={copy.submittedTitle}>
            {copy.submittedText(filing.status === 'pending' ? copy.statusPending : filing.status)}
          </Notice>
        ) : (
          <form onSubmit={onSubmitRegistry} className="flex flex-col gap-4" noValidate>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium">{copy.registryKind}</legend>
              <div className="flex flex-wrap gap-2">
                {(['handelsregister', 'lei'] as RegistryKind[]).map((kind) => (
                  <label key={kind} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-[:checked]:border-beam has-[:checked]:bg-beam/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                    <input
                      type="radio"
                      name="registry-kind"
                      value={kind}
                      className="accent-[var(--beam)]"
                      checked={progress.registryKind === kind}
                      onChange={() => update({ registryKind: kind })}
                    />
                    {copy.kinds[kind]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id="registry-number"
                label={progress.registryKind === 'lei' ? copy.leiNumber : copy.registerNumber}
                value={progress.registrationNumber}
                onChange={(value) => update({ registrationNumber: value })}
                placeholder={progress.registryKind === 'lei' ? '5493001KJTIIGC8Y1R12' : 'HRB 123456'}
                autoComplete="off"
              />
              {progress.registryKind === 'lei' ? (
                <TextField
                  id="registry-country"
                  label={copy.leiCountry}
                  value={progress.leiCountry}
                  onChange={(value) => update({ leiCountry: value.toUpperCase() })}
                  placeholder="DE"
                  maxLength={2}
                  autoComplete="off"
                />
              ) : (
                <TextField
                  id="registry-court"
                  label={copy.registerCourt}
                  value={progress.registerCourt}
                  onChange={(value) => update({ registerCourt: value })}
                  placeholder={copy.registerCourtPlaceholder}
                  autoComplete="off"
                />
              )}
              <TextField
                id="registry-legal-name"
                label={copy.legalName}
                value={progress.legalName}
                onChange={(value) => update({ legalName: value })}
                placeholder={copy.legalPlaceholder}
                autoComplete="organization"
              />
              <TextField
                id="registry-applicant"
                label={copy.applicantName}
                value={progress.applicantName}
                onChange={(value) => update({ applicantName: value })}
                autoComplete="name"
              />
            </div>
            <SelectField id="registry-role" label={copy.applicantRole} value={progress.applicantRole} onChange={(value) => update({ applicantRole: value as typeof progress.applicantRole })}>
              <option value="">{copy.rolePlaceholder}</option>
              {APPLICANT_ROLES.map((role) => <option key={role} value={role}>{copy.roles[role]}</option>)}
            </SelectField>
            <p className="text-xs leading-5 text-muted-foreground">{copy.roleNote}</p>
            {showRegistryErrors && registryInvalid ? <p className="text-xs text-destructive">{t.validation[registryInvalid]}</p> : null}
            {!progress.orgVerified ? <p className="text-xs text-muted-foreground">{copy.registryNeedsDomain}</p> : null}
            {registryError ? <Notice tone="error">{registryError}</Notice> : null}
            <div>
              <Button id="submit-registry" type="submit" variant="outline" className="h-9 rounded-full px-4" disabled={!progress.orgVerified || !secrets.orgApiKey || Boolean(registryInvalid) || pending !== null}>
                {pending === 'registry' ? <Spinner label={copy.submitting} /> : copy.submitRegistry}
              </Button>
            </div>
          </form>
        )}
      </Panel>

      <ComingSoonCard capability="checkPowerOfRepresentation" title={copy.porTitle} company={progress.displayName}>
        {copy.porText}
      </ComingSoonCard>
    </div>
  )
}
