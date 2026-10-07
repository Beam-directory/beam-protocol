import { useState, type FormEvent } from 'react'
import { DownloadIcon, GlobeIcon, KeyRoundIcon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { CopyField, LiveBadge, Notice, Panel, Spinner, StatusBadge, TextField, downloadJson } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import { checkDomainVerification, createOrg, describeError, getOrg, type OrgRecord } from '@/lib/onboarding-api'
import {
  deriveOrgName,
  normalizeDomain,
  validateDisplayName,
  validateDomain,
  validateRegistration,
  type RegistryCountry,
} from '@/lib/onboarding-steps'

function formatDateTime(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function StepFirma({ progress, update, secrets, setSecrets }: StepProps) {
  const [pending, setPending] = useState<'claim' | 'check' | 'resume' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ displayName?: string | null; domain?: string | null }>({})
  const [dnsResult, setDnsResult] = useState<{ records: string[] } | null>(null)
  const [resumeMode, setResumeMode] = useState(false)
  const [resumeName, setResumeName] = useState(progress.orgName)
  const [resumeKey, setResumeKey] = useState('')

  const orgName = deriveOrgName(progress.domain)
  const claimed = Boolean(progress.orgName && secrets.orgApiKey)
  const needsResume = Boolean(progress.orgName && !secrets.orgApiKey)

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

  async function onClaim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors = { displayName: validateDisplayName(progress.displayName), domain: validateDomain(progress.domain) }
    setFieldErrors(errors)
    if (errors.displayName || errors.domain) return
    setPending('claim')
    setError(null)
    try {
      const org = await createOrg({ name: orgName, displayName: progress.displayName.trim(), domain: normalizeDomain(progress.domain) })
      setSecrets({ orgApiKey: org.apiKey, orgKeySaved: false })
      applyOrg(org)
    } catch (claimError) {
      setError(describeError(claimError))
    } finally {
      setPending(null)
    }
  }

  async function onResume(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!resumeName.trim() || !resumeKey.trim()) {
      setError('Bitte Namensraum und Org-Schlüssel angeben.')
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
      setError(describeError(resumeError))
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
      setError(describeError(checkError))
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
      notice: 'Org-Schlüssel. Vertraulich behandeln. Beam zeigt ihn nur einmal an und speichert ihn nicht im Klartext.',
    })
    setSecrets({ orgKeySaved: true })
  }

  const registryError = progress.registrationNumber || progress.legalName
    ? validateRegistration(progress.registryCountry, progress.registrationNumber, progress.legalName)
    : null

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Domain bestätigen" badge={progress.orgVerified ? <StatusBadge tone="success">Domain verifiziert</StatusBadge> : <LiveBadge />}>
        {!claimed && !resumeMode ? (
          needsResume ? (
            <Notice tone="warning" title="Sitzung fortsetzen">
              Der Org-Schlüssel für <span className="font-mono text-foreground">{progress.orgName}</span> wird aus Sicherheitsgründen nicht gespeichert.
              Gib ihn erneut ein, um weiterzumachen.
              <div className="mt-2">
                <Button type="button" variant="outline" className="h-8 rounded-full px-3" onClick={() => setResumeMode(true)}>Org-Schlüssel eingeben</Button>
              </div>
            </Notice>
          ) : (
            <form onSubmit={onClaim} className="flex flex-col gap-4" noValidate>
              <p className="text-sm leading-6 text-muted-foreground">
                Beam legt einen Namensraum für deine Firma an und gibt dir einen DNS-TXT-Eintrag. Sobald er gefunden wird, gilt die Domain als bestätigt.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="org-display-name"
                  label="Firmenname"
                  value={progress.displayName}
                  onChange={(value) => update({ displayName: value })}
                  autoComplete="organization"
                  placeholder="Firma GmbH"
                  error={fieldErrors.displayName}
                />
                <TextField
                  id="org-domain"
                  label="Domain"
                  value={progress.domain}
                  onChange={(value) => update({ domain: value })}
                  inputMode="url"
                  autoComplete="url"
                  placeholder="firma.de"
                  error={fieldErrors.domain}
                  description={orgName ? <>Namensraum: <span className="font-mono text-foreground">{orgName}</span>, Agenten heißen dann name@{orgName}.beam.directory</> : 'Die Domain, für die du DNS-Einträge setzen kannst.'}
                />
              </div>
              {error ? <Notice tone="error">{error}</Notice> : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" className="h-10 rounded-full px-5" disabled={pending !== null}>
                  {pending === 'claim' ? <Spinner label="Wird angelegt" /> : <><GlobeIcon aria-hidden="true" /> Domain beanspruchen</>}
                </Button>
                <button type="button" onClick={() => { setResumeMode(true); setError(null) }} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  Ich habe schon einen Org-Schlüssel
                </button>
              </div>
            </form>
          )
        ) : null}

        {resumeMode ? (
          <form onSubmit={onResume} className="flex flex-col gap-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="resume-name" label="Namensraum" value={resumeName} onChange={setResumeName} placeholder="firma" autoComplete="off" />
              <TextField id="resume-key" label="Org-Schlüssel" type="password" value={resumeKey} onChange={setResumeKey} placeholder="beam_org_…" autoComplete="off" />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">Der Schlüssel bleibt nur in diesem Tab im Arbeitsspeicher und wird nirgends gespeichert.</p>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" className="h-10 rounded-full px-5" disabled={pending !== null}>
                {pending === 'resume' ? <Spinner label="Wird geprüft" /> : 'Fortsetzen'}
              </Button>
              <button type="button" onClick={() => { setResumeMode(false); setError(null) }} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                Abbrechen
              </button>
            </div>
          </form>
        ) : null}

        {claimed ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <KeyRoundIcon aria-hidden="true" className="size-4 text-amber-500" />
                Org-Schlüssel für {progress.orgName}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                Mit diesem Schlüssel legst du Agenten für deine Firma an. Beam zeigt ihn nur jetzt. Er bleibt nur in diesem Tab im Arbeitsspeicher;
                nach dem Neuladen musst du ihn erneut eingeben.
              </p>
              {secrets.orgApiKey ? <CopyField label="Org-Schlüssel" value={secrets.orgApiKey} secret /> : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" className="h-9 rounded-full px-4" onClick={saveOrgKey}>
                  <DownloadIcon aria-hidden="true" /> Als Datei sichern
                </Button>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--beam)]"
                    checked={secrets.orgKeySaved}
                    onChange={(event) => setSecrets({ orgKeySaved: event.target.checked })}
                  />
                  Ich habe den Schlüssel sicher abgelegt.
                </label>
              </div>
            </div>

            {progress.orgVerified ? (
              <Notice tone="success" title="Domain verifiziert">
                <span className="font-mono text-foreground">{progress.domain}</span> gehört zum Namensraum <span className="font-mono text-foreground">{progress.orgName}</span>.
              </Notice>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm leading-6 text-muted-foreground">
                  Lege diesen TXT-Eintrag bei deinem DNS-Anbieter an und prüfe ihn dann hier.
                  {formatDateTime(progress.claimExpiresAt) ? <> Die Anmeldung läuft am {formatDateTime(progress.claimExpiresAt)} ab, wenn die Domain bis dahin nicht bestätigt ist.</> : null}
                </p>
                <div className="grid gap-3">
                  <CopyField label="Name (Host)" value={progress.txtName} />
                  <CopyField label="Wert" value={progress.txtValue} />
                </div>
                {dnsResult ? (
                  <Notice tone="warning" title="Noch nicht gefunden">
                    DNS-Änderungen brauchen manchmal etwas Zeit.
                    {dnsResult.records.length > 0 ? <> Gefunden: <span className="font-mono break-all text-foreground">{dnsResult.records.join(', ')}</span></> : ' Unter diesem Namen gibt es noch keinen TXT-Eintrag.'}
                  </Notice>
                ) : null}
                {error ? <Notice tone="error">{error}</Notice> : null}
                <div>
                  <Button type="button" className="h-10 rounded-full px-5" onClick={() => void onCheckDns()} disabled={pending !== null}>
                    {pending === 'check' ? <Spinner label="Wird geprüft" /> : <><RefreshCwIcon aria-hidden="true" /> DNS prüfen</>}
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Panel>

      <Panel title="Handelsregister" badge={<LiveBadge>Prüfung durch Beam</LiveBadge>}>
        <p className="text-sm leading-6 text-muted-foreground">
          Deutschland: Beam prüft das Format der Registernummer, der Abgleich mit dem Register erfolgt manuell.
          Vereinigtes Königreich: Abgleich mit Companies House, danach Prüfung durch Beam.
          Eingereicht wird in Schritt 3, weil die Registerprüfung heute an die Beam-ID eines Agenten gebunden ist.
        </p>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">Land des Registers</legend>
          <div className="flex gap-2">
            {(['DE', 'UK'] as RegistryCountry[]).map((country) => (
              <label key={country} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-[:checked]:border-beam has-[:checked]:bg-beam/5">
                <input
                  type="radio"
                  name="registry-country"
                  value={country}
                  className="accent-[var(--beam)]"
                  checked={progress.registryCountry === country}
                  onChange={() => update({ registryCountry: country })}
                />
                {country === 'DE' ? 'Deutschland' : 'Vereinigtes Königreich'}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="registry-number"
            label={progress.registryCountry === 'DE' ? 'Registernummer' : 'Company Number'}
            value={progress.registrationNumber}
            onChange={(value) => update({ registrationNumber: value })}
            placeholder={progress.registryCountry === 'DE' ? 'HRB 123456' : '01234567'}
            autoComplete="off"
          />
          <TextField
            id="registry-legal-name"
            label="Rechtlicher Name laut Register"
            value={progress.legalName}
            onChange={(value) => update({ legalName: value })}
            placeholder="Firma GmbH"
            autoComplete="organization"
          />
        </div>
        {registryError ? <p className="text-xs text-destructive">{registryError}</p> : null}
      </Panel>

      <div className="grid gap-4 md:grid-cols-3">
        <ComingSoonCard capability="verifyDomainByWellKnownFile" title="Datei unter /.well-known/" company={progress.displayName}>
          Alternative zum DNS-Eintrag: eine Prüfdatei auf deinem Webserver. Bis dahin bestätigt nur der TXT-Eintrag die Domain.
        </ComingSoonCard>
        <ComingSoonCard capability="lookupLei" title="LEI" company={progress.displayName}>
          Firmenidentität über den Legal Entity Identifier statt über das Handelsregister.
        </ComingSoonCard>
        <ComingSoonCard capability="checkPowerOfRepresentation" title="Vertretungsberechtigung" company={progress.displayName}>
          Automatische Prüfung, ob du die Firma vertreten darfst. Heute gibt es dafür keine Prüfung.
        </ComingSoonCard>
      </div>
    </div>
  )
}
