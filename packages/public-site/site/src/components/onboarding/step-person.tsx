import { useState, type FormEvent } from 'react'
import { DownloadIcon, KeyRoundIcon, RefreshCwIcon, UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { CopyField, LiveBadge, Notice, Panel, Spinner, StatusBadge, TextField, downloadJson } from '@/components/onboarding/primitives'
import { ScopeFields } from '@/components/onboarding/scope-fields'
import type { StepProps } from '@/components/onboarding/types'
import { useI18n } from '@/i18n/context'
import { generateSigningIdentity, importSigningIdentity } from '@/lib/agent-keys'
import { createPerson, describeError, getKycStatus, inviteEmployee, requestManualKyc, acceptInvitation } from '@/lib/onboarding-api'
import {
  EMPTY_SCOPE,
  scopeGrantFromDraft,
  validateDisplayName,
  validateEmail,
  validateRole,
  type KycStatus,
  type ScopeDraft,
  type ValidationKey,
} from '@/lib/onboarding-steps'

function kycTone(status: string): 'success' | 'pending' | 'neutral' {
  if (status === 'verified') return 'success'
  if (status === 'pending' || status === 'rejected') return 'pending'
  return 'neutral'
}

export function StepPerson({ progress, update, secrets, setSecrets }: StepProps) {
  const { t } = useI18n()
  const copy = t.onboarding.person
  const [pending, setPending] = useState<'keys' | 'create' | 'kyc' | 'refresh' | 'invite' | 'accept' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<ValidationKey | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('')
  const [inviteRights, setInviteRights] = useState<ScopeDraft>({ ...EMPTY_SCOPE, files: false })
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [acceptToken, setAcceptToken] = useState('')
  const [acceptName, setAcceptName] = useState('')
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [acceptedId, setAcceptedId] = useState('')

  const created = Boolean(progress.personId)
  const kyc = progress.personKycStatus || 'unverified'
  const kycLabel = copy.kycStates[kyc as KycStatus] ?? kyc

  async function onGenerate() {
    setPending('keys')
    setError(null)
    try {
      const identity = await generateSigningIdentity()
      setSecrets({ personIdentity: identity, personKeySaved: false })
    } catch (keyError) {
      setError(describeError(keyError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = validateEmail(progress.personEmail)
      ?? validateDisplayName(progress.personDisplayName)
      ?? validateRole(progress.personRole)
      ?? ('error' in scopeGrantFromDraft(progress.personRights) ? (scopeGrantFromDraft(progress.personRights) as { error: ValidationKey }).error : null)
    setFieldError(invalid)
    const rights = scopeGrantFromDraft(progress.personRights)
    if (invalid || !secrets.orgApiKey || !secrets.personIdentity || !('grant' in rights)) return
    setPending('create')
    setError(null)
    try {
      const person = await createPerson(progress.orgName, secrets.orgApiKey, {
        email: progress.personEmail,
        displayName: progress.personDisplayName,
        role: progress.personRole,
        publicKey: secrets.personIdentity.publicKey,
        rights: rights.grant,
      })
      update({
        personId: person.id,
        personKycStatus: person.kycStatus === 'pending' || person.kycStatus === 'verified' || person.kycStatus === 'rejected' ? person.kycStatus : 'unverified',
        personKycProvider: person.kycProvider ?? '',
      })
    } catch (createError) {
      setError(describeError(createError, t.errors))
    } finally {
      setPending(null)
    }
  }

  function savePersonKey() {
    if (!secrets.personIdentity || !progress.personId) return
    downloadJson(`beam-person-${progress.personId}.json`, {
      format: 'beam-person-key',
      version: 1,
      personId: progress.personId,
      org: progress.orgName,
      publicKey: secrets.personIdentity.publicKey,
      privateKey: secrets.personIdentity.privateKey,
      notice: copy.keyFileNotice,
    })
    setSecrets({ personKeySaved: true })
  }

  async function onLoadKey(file: File) {
    setError(null)
    try {
      const parsed = JSON.parse(await file.text()) as { format?: string; publicKey?: string; privateKey?: string; personId?: string }
      if (parsed.format !== 'beam-person-key' || !parsed.publicKey || !parsed.privateKey) {
        setError(copy.keyFileInvalid)
        return
      }
      const identity = await importSigningIdentity(parsed.publicKey, parsed.privateKey)
      setSecrets({ personIdentity: identity, personKeySaved: true })
    } catch (loadError) {
      setError(describeError(loadError, t.errors))
    }
  }

  async function onRequestKyc() {
    if (!secrets.orgApiKey || !progress.personId) return
    setPending('kyc')
    setError(null)
    try {
      const person = await requestManualKyc(progress.orgName, secrets.orgApiKey, progress.personId)
      update({
        personKycStatus: person.kycStatus === 'pending' || person.kycStatus === 'verified' || person.kycStatus === 'rejected' ? person.kycStatus : 'pending',
        personKycProvider: person.kycProvider ?? 'manual',
      })
    } catch (kycError) {
      setError(describeError(kycError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onRefreshKyc() {
    if (!secrets.orgApiKey || !progress.personId) return
    setPending('refresh')
    setError(null)
    try {
      const person = await getKycStatus(progress.orgName, secrets.orgApiKey, progress.personId)
      if (!person) {
        setError(t.errors.codes.NOT_FOUND ?? t.errors.generic)
        return
      }
      const status = person.kycStatus
      update({
        personKycStatus: status === 'pending' || status === 'verified' || status === 'rejected' || status === 'unverified' ? status : '',
        personKycProvider: person.kycProvider ?? '',
      })
    } catch (refreshError) {
      setError(describeError(refreshError, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const rights = scopeGrantFromDraft(inviteRights)
    const invalid = validateEmail(inviteEmail) ?? validateRole(inviteRole) ?? ('error' in rights ? rights.error : null)
    if (invalid || !secrets.orgApiKey || !('grant' in rights)) {
      setInviteError(invalid ? t.validation[invalid] : null)
      return
    }
    setPending('invite')
    setInviteError(null)
    try {
      const invitation = await inviteEmployee(progress.orgName, secrets.orgApiKey, {
        email: inviteEmail,
        role: inviteRole,
        rights: rights.grant,
        supervisorPersonId: progress.personId || null,
      })
      setSecrets({ invitationToken: invitation.token })
    } catch (inviteFailure) {
      setInviteError(describeError(inviteFailure, t.errors))
    } finally {
      setPending(null)
    }
  }

  async function onAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = validateDisplayName(acceptName)
    if (invalid || !acceptToken.trim()) {
      setAcceptError(invalid ? t.validation[invalid] : copy.tokenRequired)
      return
    }
    setPending('accept')
    setAcceptError(null)
    try {
      const identity = await generateSigningIdentity()
      const person = await acceptInvitation({ token: acceptToken.trim(), displayName: acceptName.trim(), publicKey: identity.publicKey })
      downloadJson(`beam-person-${person.id}.json`, {
        format: 'beam-person-key',
        version: 1,
        personId: person.id,
        org: person.org,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        notice: copy.keyFileNotice,
      })
      setAcceptedId(person.id)
      setAcceptToken('')
    } catch (acceptFailure) {
      setAcceptError(describeError(acceptFailure, t.errors))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {!progress.orgVerified || !secrets.orgApiKey ? (
        <Notice tone="warning" title={copy.orgFirstTitle}>{copy.orgFirstText}</Notice>
      ) : null}

      {created ? (
        <Panel title={copy.ownerPanel} badge={<StatusBadge tone={kycTone(kyc)}>{kycLabel}</StatusBadge>}>
          <div className="flex gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
              <UserIcon aria-hidden="true" className="size-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-1 text-sm leading-6">
              <p className="font-medium text-foreground">{progress.personDisplayName}</p>
              <p className="text-muted-foreground">{progress.personEmail} · {progress.personRole}</p>
              <p className="font-mono text-xs break-all text-muted-foreground">{progress.personId}</p>
            </div>
          </div>
          {secrets.personIdentity ? (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <KeyRoundIcon aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-400" />
                {copy.keyTitle}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">{copy.keyText}</p>
              <CopyField label={copy.publicKey} value={secrets.personIdentity.publicKey} />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" className="h-9 rounded-full px-4" onClick={savePersonKey}>
                  <DownloadIcon aria-hidden="true" /> {copy.downloadKey}
                </Button>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--beam)]" checked={secrets.personKeySaved} onChange={(event) => setSecrets({ personKeySaved: event.target.checked })} />
                  {copy.keySaved}
                </label>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Notice tone="warning" title={copy.keysGoneTitle}>{copy.keysGoneText}</Notice>
              <label className="text-sm font-medium" htmlFor="person-key-file">{copy.loadKey}</label>
              <input
                id="person-key-file"
                type="file"
                accept="application/json,.json"
                className="text-sm"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void onLoadKey(file)
                }}
              />
            </div>
          )}
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-6 text-muted-foreground">{copy.kycManual}</p>
            <p className="text-xs text-muted-foreground">{copy.provider}: <span className="font-mono text-foreground">{progress.personKycProvider || copy.providerNone}</span></p>
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div className="flex flex-wrap gap-2">
              <Button id="request-kyc" type="button" variant="outline" className="h-9 rounded-full px-4" disabled={!secrets.orgApiKey || kyc === 'verified' || kyc === 'pending' || pending !== null} onClick={() => void onRequestKyc()}>
                {pending === 'kyc' ? <Spinner label={copy.requesting} /> : copy.requestReview}
              </Button>
              <Button id="refresh-kyc" type="button" variant="ghost" className="h-9 rounded-full px-4" disabled={!secrets.orgApiKey || pending !== null} onClick={() => void onRefreshKyc()}>
                {pending === 'refresh' ? <Spinner label={copy.refreshing} /> : <><RefreshCwIcon aria-hidden="true" /> {copy.refresh}</>}
              </Button>
            </div>
          </div>
        </Panel>
      ) : (
        <form onSubmit={onCreate} className="flex flex-col gap-5" noValidate>
          <Panel title={copy.ownerPanel} badge={<LiveBadge />}>
            <p className="text-sm leading-6 text-muted-foreground">{copy.createIntro}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="person-email" label={copy.email} type="email" inputMode="email" autoComplete="email" value={progress.personEmail} onChange={(personEmail) => update({ personEmail })} />
              <TextField id="person-name" label={copy.displayName} autoComplete="name" value={progress.personDisplayName} onChange={(personDisplayName) => update({ personDisplayName })} />
              <TextField id="person-role" label={copy.role} value={progress.personRole} onChange={(personRole) => update({ personRole })} placeholder={copy.rolePlaceholder} />
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">{copy.rightsTitle}</p>
              <p className="text-xs leading-5 text-muted-foreground">{copy.rightsText}</p>
              <ScopeFields idPrefix="person-rights" value={progress.personRights} onChange={(personRights) => update({ personRights })} />
            </div>
            {secrets.personIdentity ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <KeyRoundIcon aria-hidden="true" className="size-3.5 text-success" />
                {copy.keyReady}
              </p>
            ) : (
              <Button id="generate-person-key" type="button" variant="outline" className="h-10 w-fit rounded-full px-5" onClick={() => void onGenerate()} disabled={pending !== null}>
                {pending === 'keys' ? <Spinner label={copy.generating} /> : copy.generate}
              </Button>
            )}
            {fieldError ? <p className="text-xs text-destructive">{t.validation[fieldError]}</p> : null}
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div>
              <Button id="create-person" type="submit" className="h-10 rounded-full px-5" disabled={!secrets.orgApiKey || !progress.orgVerified || !secrets.personIdentity || pending !== null}>
                {pending === 'create' ? <Spinner label={copy.creating} /> : copy.create}
              </Button>
            </div>
          </Panel>
        </form>
      )}

      <ComingSoonCard capability="thirdPartyKyc" title={copy.kycTitle} company={progress.displayName}>
        {copy.kycText}
      </ComingSoonCard>

      <Panel title={copy.inviteTitle} badge={<LiveBadge />}>
        <p className="text-sm leading-6 text-muted-foreground">{copy.inviteText}</p>
        {secrets.invitationToken ? (
          <div className="flex flex-col gap-2">
            <Notice tone="warning" title={copy.tokenOnce}>{copy.tokenText}</Notice>
            <CopyField label={copy.token} value={secrets.invitationToken} secret />
          </div>
        ) : (
          <form onSubmit={onInvite} className="flex flex-col gap-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="invite-email" label={copy.email} type="email" inputMode="email" value={inviteEmail} onChange={setInviteEmail} autoComplete="off" />
              <TextField id="invite-role" label={copy.role} value={inviteRole} onChange={setInviteRole} />
            </div>
            <ScopeFields idPrefix="invite-rights" value={inviteRights} onChange={setInviteRights} />
            {progress.personId ? <p className="text-xs text-muted-foreground">{copy.supervisorNote}</p> : null}
            {inviteError ? <Notice tone="error">{inviteError}</Notice> : null}
            <div>
              <Button id="invite-person" type="submit" variant="outline" className="h-9 rounded-full px-4" disabled={!secrets.orgApiKey || pending !== null}>
                {pending === 'invite' ? <Spinner label={copy.inviting} /> : copy.invite}
              </Button>
            </div>
          </form>
        )}
        <details className="rounded-lg border bg-background/60 text-sm">
          <summary className="cursor-pointer rounded-lg px-3 py-2 text-muted-foreground">{copy.acceptTitle}</summary>
          <form onSubmit={onAccept} className="flex flex-col gap-3 border-t p-3" noValidate>
            <p className="text-xs leading-5 text-muted-foreground">{copy.acceptText}</p>
            <TextField id="accept-token" label={copy.token} value={acceptToken} onChange={setAcceptToken} autoComplete="off" />
            <TextField id="accept-name" label={copy.displayName} value={acceptName} onChange={setAcceptName} autoComplete="name" />
            {acceptedId ? <Notice tone="success" title={copy.acceptedTitle}>{copy.acceptedText} <span className="font-mono text-foreground">{acceptedId}</span></Notice> : null}
            {acceptError ? <Notice tone="error">{acceptError}</Notice> : null}
            <div>
              <Button id="accept-invitation" type="submit" variant="outline" className="h-9 rounded-full px-4" disabled={pending !== null}>
                {pending === 'accept' ? <Spinner label={copy.accepting} /> : copy.accept}
              </Button>
            </div>
          </form>
        </details>
      </Panel>

      <ComingSoonCard capability="syncEmployeeDirectory" title={copy.syncTitle} company={progress.displayName}>
        {copy.syncText}
      </ComingSoonCard>
    </div>
  )
}
