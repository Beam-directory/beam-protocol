import { useState, type FormEvent, type ReactNode } from 'react'
import { DownloadIcon, FileCheckIcon, KeyRoundIcon, LockIcon, ShieldCheckIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ComingSoonCard } from '@/components/onboarding/coming-soon'
import { CopyField, LiveBadge, Notice, Panel, SoonBadge, Spinner, StatusBadge, TextField, downloadJson } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import { buildRecoveryKit, generateAgentIdentity, recoveryKitFileName } from '@/lib/agent-keys'
import { directoryApiBase } from '@/lib/directory-client'
import { describeError, registerAgent, submitBusinessRegistration, type BusinessRegistrationResult } from '@/lib/onboarding-api'
import {
  EMPTY_MANDATE,
  buildBeamId,
  mandatePreview,
  normalizeAgentName,
  validateAgentName,
  validateDisplayName,
  validateMandate,
  validateRegistration,
  type MandateDraft,
} from '@/lib/onboarding-steps'
import { fingerprintPublicKey } from '@/lib/public-agent'

function Check({ id, label, checked, onChange, children }: { id: string; label: string; checked: boolean; onChange: (value: boolean) => void; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 has-[:checked]:border-beam/50 has-[:checked]:bg-beam/5">
      <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm">
        <input id={id} type="checkbox" className="size-4 accent-[var(--beam)]" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
      {checked && children ? <div className="pl-6.5">{children}</div> : null}
    </div>
  )
}

export function StepAgent({ progress, update, secrets, setSecrets }: StepProps) {
  const [pending, setPending] = useState<'keys' | 'register' | 'business' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [mandate, setMandate] = useState<MandateDraft>(EMPTY_MANDATE)
  const [business, setBusiness] = useState<BusinessRegistrationResult | null>(null)
  const [businessError, setBusinessError] = useState<string | null>(null)

  const registered = Boolean(progress.registeredBeamId)
  const beamId = registered ? progress.registeredBeamId : buildBeamId(progress.agentName || 'name', progress.orgName || 'firma')
  const canRegister = progress.orgVerified && Boolean(secrets.orgApiKey) && Boolean(secrets.identity)
  const mandateError = validateMandate(mandate)
  const hasRegistryData = Boolean(progress.registrationNumber && progress.legalName)
    && !validateRegistration(progress.registryCountry, progress.registrationNumber, progress.legalName)

  async function onGenerate() {
    setPending('keys')
    setError(null)
    try {
      const identity = await generateAgentIdentity()
      setSecrets({ identity, kitSaved: false })
      setFingerprint(await fingerprintPublicKey(identity.publicKey))
    } catch (keyError) {
      setError(describeError(keyError))
    } finally {
      setPending(null)
    }
  }

  async function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalidName = validateAgentName(progress.agentName)
    const invalidDisplay = validateDisplayName(progress.agentDisplayName)
    setNameError(invalidName ?? invalidDisplay)
    if (invalidName || invalidDisplay || !secrets.identity || !secrets.orgApiKey) return
    setPending('register')
    setError(null)
    try {
      const agent = await registerAgent({
        beamId: buildBeamId(progress.agentName, progress.orgName),
        org: progress.orgName,
        displayName: progress.agentDisplayName.trim(),
        publicKey: secrets.identity.publicKey,
        dhPublicKey: secrets.identity.encryption.publicKey,
      }, secrets.orgApiKey)
      setSecrets({ agentApiKey: agent.apiKey, kitSaved: false })
      update({ registeredBeamId: agent.beamId })
    } catch (registerError) {
      setError(describeError(registerError))
    } finally {
      setPending(null)
    }
  }

  function saveKit() {
    if (!secrets.identity || !secrets.agentApiKey) return
    const kit = buildRecoveryKit({ beamId: progress.registeredBeamId, directoryUrl: directoryApiBase(), identity: secrets.identity, apiKey: secrets.agentApiKey })
    downloadJson(recoveryKitFileName(kit.beamId), kit)
    setSecrets({ kitSaved: true })
  }

  async function onSubmitBusiness() {
    if (!secrets.agentApiKey) return
    setPending('business')
    setBusinessError(null)
    try {
      setBusiness(await submitBusinessRegistration(progress.registeredBeamId, secrets.agentApiKey, {
        country: progress.registryCountry,
        registrationNumber: progress.registrationNumber.trim(),
        legalName: progress.legalName.trim(),
      }))
    } catch (submitError) {
      setBusinessError(describeError(submitError))
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex gap-3 rounded-2xl border border-beam/30 bg-beam/5 p-4 sm:p-5">
        <LockIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-beam" />
        <div className="flex flex-col gap-1 text-sm leading-6">
          <p className="font-medium">Der private Schlüssel verlässt diesen Browser nie.</p>
          <p className="text-muted-foreground">
            Das Schlüsselpaar entsteht hier mit WebCrypto (Ed25519 zum Signieren, X25519 für Ende-zu-Ende-verschlüsselte Chats unter /network).
            Beam bekommt nur die öffentlichen Schlüssel. Den privaten Schlüssel sicherst du selbst in einer Wiederherstellungsdatei.
          </p>
        </div>
      </div>

      {registered ? (
        <Panel title="Agent registriert" badge={<StatusBadge tone="success">Registriert</StatusBadge>}>
          <CopyField label="Beam-ID" value={progress.registeredBeamId} />
          {secrets.identity && secrets.agentApiKey ? (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="flex items-center gap-2 text-sm font-medium">
                <KeyRoundIcon aria-hidden="true" className="size-4 text-amber-500" />
                Wiederherstellungsdatei sichern
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                Die Datei enthält den privaten Schlüssel und den Agenten-Schlüssel. Beam speichert beides nicht. Mit der Datei öffnest du den Agenten unter /network.
                Ohne sie ist der Agent nach dem Schließen dieses Tabs nicht mehr nutzbar.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" className="h-9 rounded-full px-4" onClick={saveKit}>
                  <DownloadIcon aria-hidden="true" /> Datei herunterladen
                </Button>
                {secrets.kitSaved ? <StatusBadge tone="success">Download gestartet</StatusBadge> : null}
              </div>
            </div>
          ) : (
            <Notice tone="warning" title="Schlüssel nicht mehr im Speicher">
              Nach dem Neuladen sind die Schlüssel aus Sicherheitsgründen weg. Öffne den Agenten mit deiner Wiederherstellungsdatei unter <a className="underline underline-offset-4" href="/network">/network</a>.
            </Notice>
          )}
        </Panel>
      ) : (
        <form onSubmit={onRegister} className="flex flex-col gap-5" noValidate>
          <Panel title="Adresse" badge={<LiveBadge />}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id="agent-name"
                label="Beam-ID"
                value={progress.agentName}
                onChange={(value) => update({ agentName: normalizeAgentName(value) })}
                suffix={`@${progress.orgName || 'firma'}.beam.directory`}
                placeholder="einkauf"
                autoComplete="off"
                maxLength={63}
                error={nameError}
              />
              <TextField
                id="agent-display-name"
                label="Anzeigename"
                value={progress.agentDisplayName}
                onChange={(value) => update({ agentDisplayName: value })}
                placeholder="Einkauf"
                autoComplete="off"
              />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Neue Agenten sind zunächst nicht öffentlich gelistet. Die Sichtbarkeit änderst du später.
            </p>
          </Panel>

          <Panel title="Schlüsselpaar" badge={secrets.identity ? <StatusBadge tone="success">Im Browser erzeugt</StatusBadge> : <LiveBadge />}>
            {secrets.identity ? (
              <div className="flex flex-col gap-3">
                <CopyField label="Öffentlicher Schlüssel (geht an Beam)" value={secrets.identity.publicKey} />
                {fingerprint ? <p className="text-xs text-muted-foreground">Fingerabdruck: <span className="font-mono text-foreground">{fingerprint}</span></p> : null}
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheckIcon aria-hidden="true" className="size-3.5 text-success" />
                  Privater Schlüssel: nur im Arbeitsspeicher dieses Tabs.
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm leading-6 text-muted-foreground">Erzeugt ein neues Schlüsselpaar für diesen Agenten. Es wird nichts gesendet.</p>
                <Button type="button" variant="outline" className="h-10 rounded-full px-5" onClick={() => void onGenerate()} disabled={pending !== null}>
                  {pending === 'keys' ? <Spinner label="Wird erzeugt" /> : <><KeyRoundIcon aria-hidden="true" /> Schlüssel im Browser erzeugen</>}
                </Button>
              </div>
            )}
          </Panel>

          {!progress.orgVerified || !secrets.orgApiKey ? (
            <Notice tone="warning" title="Firma zuerst bestätigen">
              Agenten einer Firma können erst angelegt werden, wenn die Domain verifiziert ist und der Org-Schlüssel in diesem Tab vorliegt (Schritt 1).
            </Notice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div>
            <Button type="submit" className="h-10 rounded-full px-5" disabled={!canRegister || pending !== null}>
              {pending === 'register' ? <Spinner label="Wird registriert" /> : 'Agent registrieren'}
            </Button>
          </div>
        </form>
      )}

      <Panel title="Vollmacht" badge={<SoonBadge />} className="border-dashed bg-transparent">
        <p className="text-sm leading-6 text-muted-foreground">
          Lege fest, was der Agent in deinem Namen darf. Signierte Vollmachten mit Betragsgrenzen und Eskalation stellt Beam noch nicht aus;
          dieser Entwurf wird weder gespeichert noch durchgesetzt.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Check id="scope-read" label="Lesen" checked={mandate.read} onChange={(read) => setMandate({ ...mandate, read })} />
          <Check id="scope-appointments" label="Termine zusagen" checked={mandate.acceptAppointments} onChange={(acceptAppointments) => setMandate({ ...mandate, acceptAppointments })} />
          <Check id="scope-files" label="Dateien senden" checked={mandate.sendFiles} onChange={(sendFiles) => setMandate({ ...mandate, sendFiles })} />
          <Check id="scope-order" label="Bestellen bis Betrag" checked={mandate.order} onChange={(order) => setMandate({ ...mandate, order })}>
            <TextField id="scope-order-limit" label="Höchstbetrag in Euro" inputMode="decimal" value={mandate.orderLimitEur} onChange={(orderLimitEur) => setMandate({ ...mandate, orderLimitEur })} placeholder="500" />
          </Check>
          <div className="sm:col-span-2">
            <Check id="scope-escalate" label="Eskalation an Vorgesetzte" checked={mandate.escalate} onChange={(escalate) => setMandate({ ...mandate, escalate })}>
              <TextField id="scope-escalate-to" label="An wen" value={mandate.escalateTo} onChange={(escalateTo) => setMandate({ ...mandate, escalateTo })} placeholder="Leitung Einkauf" />
            </Check>
          </div>
        </div>
        {mandateError ? <p className="text-xs text-muted-foreground">{mandateError}</p> : null}
        <details className="rounded-lg border bg-background/60 text-xs">
          <summary className="cursor-pointer px-3 py-2 text-muted-foreground">Entwurf ansehen</summary>
          <pre className="overflow-x-auto border-t p-3 font-mono leading-5">{JSON.stringify(mandatePreview(mandate, registered ? progress.registeredBeamId : beamId), null, 2)}</pre>
        </details>
      </Panel>
      <ComingSoonCard capability="issueMandate" title="Vollmachten ausstellen" company={progress.displayName}>
        Von dir signierte Vollmachten mit Befugnissen, Betragsgrenzen und Eskalation. Heute kennt Beam nur Delegationen zwischen Agenten mit freiem Text als Umfang.
      </ComingSoonCard>

      {registered ? (
        <Panel title="Handelsregister einreichen" badge={business ? <StatusBadge tone="pending">Prüfung ausstehend</StatusBadge> : <LiveBadge>Prüfung durch Beam</LiveBadge>}>
          {business ? (
            <Notice tone="info" title="Eingereicht">
              Die Angaben liegen zur Prüfung bei Beam. Status: {business.status === 'pending' ? 'ausstehend' : business.status}. Das ist noch keine Bestätigung der Firma.
            </Notice>
          ) : hasRegistryData ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm leading-6 text-muted-foreground">
                <FileCheckIcon aria-hidden="true" className="mr-1 inline size-4" />
                {progress.legalName}, {progress.registrationNumber} ({progress.registryCountry === 'DE' ? 'Deutschland' : 'Vereinigtes Königreich'})
              </p>
              {businessError ? <Notice tone="error">{businessError}</Notice> : null}
              <Button type="button" variant="outline" className="h-9 rounded-full px-4" disabled={!secrets.agentApiKey || pending !== null} onClick={() => void onSubmitBusiness()}>
                {pending === 'business' ? <Spinner label="Wird eingereicht" /> : 'Zur Prüfung einreichen'}
              </Button>
            </div>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">Keine vollständigen Registerangaben aus Schritt 1. Du kannst sie dort ergänzen.</p>
          )}
        </Panel>
      ) : null}
    </div>
  )
}
