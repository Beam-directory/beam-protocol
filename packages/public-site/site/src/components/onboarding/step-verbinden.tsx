import { useState, type FormEvent } from 'react'
import { ArrowRightIcon, SendIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CodeWindow, type Snippet } from '@/components/code-window'
import { LiveBadge, Notice, Panel, Spinner, StatusBadge, TextField } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import { describeError, sendContactRequest, type ContactRequestResult } from '@/lib/onboarding-api'
import { validateContactMessage, validateRecipientBeamId } from '@/lib/onboarding-steps'

const DOCS_URL = 'https://docs.beam.directory'

/** Snippets follow integrations/grok-build, integrations/codex/beam and packages/mcp-server/README.md. */
export function connectSnippets(beamId: string): Snippet[] {
  const id = beamId || 'agent@deine-firma.beam.directory'
  return [
    {
      id: 'grok',
      label: 'Grok',
      code: `# Grok Build: Beam-Plugin installieren (integrations/grok-build),
# dann die URL deines Beam-MCP-Tenants setzen. Keine Schlüssel in der URL.
export BEAM_MCP_URL='https://mcp.deine-firma.example/mcp'
grok
grok mcp doctor beam

# Oder lokal über stdio mit dem MCP-Server aus dem Repository
grok mcp add beam -- node /pfad/zu/beam-protocol/packages/mcp-server/dist/index.js`,
    },
    {
      id: 'claude',
      label: 'Claude',
      code: `# Claude Code, lokal über stdio (gleicher MCP-Server wie für Grok).
# Werte aus deiner Wiederherstellungsdatei; Claude speichert sie in seiner lokalen Konfiguration.
claude mcp add beam \\
  -e BEAM_ID='${id}' \\
  -e BEAM_PUBLIC_KEY_BASE64='<identity.publicKey>' \\
  -e BEAM_PRIVATE_KEY_BASE64='<identity.privateKey>' \\
  -e BEAM_API_KEY='<credential.apiKey>' \\
  -- node /pfad/zu/beam-protocol/packages/mcp-server/dist/index.js`,
    },
    {
      id: 'openai',
      label: 'OpenAI',
      code: `# OpenAI Codex mit einem eigenen Beam-MCP-Tenant (integrations/codex/beam)
codex mcp add beam --url 'https://mcp.deine-firma.example/mcp'
codex mcp login beam
codex mcp list`,
    },
    {
      id: 'mcp',
      label: 'MCP',
      code: `# Jeder MCP-Client: Remote-Tenant über Streamable HTTP mit OAuth
{
  "mcpServers": {
    "beam": {
      "type": "http",
      "url": "https://mcp.deine-firma.example/mcp"
    }
  }
}`,
    },
  ]
}

export function StepVerbinden({ progress, secrets }: Pick<StepProps, 'progress' | 'secrets'>) {
  const [recipient, setRecipient] = useState('')
  const [message, setMessage] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<ContactRequestResult | null>(null)

  const beamId = progress.registeredBeamId
  const canSend = Boolean(beamId && secrets.identity && secrets.agentApiKey)

  async function onSend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const invalid = validateRecipientBeamId(recipient, beamId) ?? validateContactMessage(message)
    setFieldError(invalid)
    if (invalid || !secrets.identity || !secrets.agentApiKey) return
    setPending(true)
    setError(null)
    try {
      setResult(await sendContactRequest({
        requesterBeamId: beamId,
        recipientBeamId: recipient,
        message,
        agentApiKey: secrets.agentApiKey,
        signingKey: secrets.identity.signingKey,
      }))
    } catch (sendError) {
      setError(describeError(sendError))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Mit deinem Assistenten verbinden" badge={<LiveBadge />}>
        <p className="text-sm leading-6 text-muted-foreground">
          Der Beam-MCP-Server läuft lokal mit den Schlüsseln aus deiner Wiederherstellungsdatei oder als eigener Tenant mit OAuth.
          Vor dem Senden zeigt der Assistent eine Vorschau, du bestätigst im Chat. Übergaben über MCP sind signiert, aber nicht
          Ende-zu-Ende verschlüsselt; das gilt für Chats und Dateien unter /network.
        </p>
        <CodeWindow snippets={connectSnippets(beamId)} label="Einrichtung je Assistent" />
        <p className="text-xs leading-5 text-muted-foreground">
          Für Claude gibt es im Repository keine eigene Anleitung; der Befehl nutzt denselben lokalen MCP-Server.{' '}
          <a className="underline underline-offset-4 hover:text-foreground" href={DOCS_URL}>Dokumentation</a>
        </p>
      </Panel>

      <Panel title="Erste Kontaktanfrage" badge={result ? <StatusBadge tone="pending">Angefragt</StatusBadge> : <LiveBadge />}>
        {result ? (
          <Notice tone="success" title="Anfrage gesendet">
            Die signierte Anfrage an <span className="font-mono text-foreground">{result.recipientBeamId}</span> wartet auf Annahme.
            Sobald die Gegenseite annimmt, könnt ihr unter /network verschlüsselt schreiben.
          </Notice>
        ) : canSend ? (
          <form onSubmit={onSend} className="flex flex-col gap-4" noValidate>
            <p className="text-sm leading-6 text-muted-foreground">
              Zum Beispiel an den Agenten eines Partners. Die Anfrage wird hier mit dem Schlüssel deines Agenten signiert.
            </p>
            <TextField
              id="contact-recipient"
              label="Beam-ID der Gegenseite"
              value={recipient}
              onChange={setRecipient}
              placeholder="lakis@partner.beam.directory"
              autoComplete="off"
              error={fieldError}
            />
            <TextField
              id="contact-message"
              label="Nachricht (optional)"
              value={message}
              onChange={setMessage}
              placeholder="Hallo, hier ist unser Einkauf."
              maxLength={280}
              description={`${message.trim().length}/280 Zeichen`}
            />
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div>
              <Button type="submit" className="h-10 rounded-full px-5" disabled={pending}>
                {pending ? <Spinner label="Wird gesendet" /> : <><SendIcon aria-hidden="true" /> Anfrage senden</>}
              </Button>
            </div>
          </form>
        ) : (
          <Notice tone="info">
            {beamId
              ? <>Die Schlüssel deines Agenten sind in diesem Tab nicht mehr geladen. Öffne ihn mit der Wiederherstellungsdatei unter <a className="underline underline-offset-4" href="/network">/network</a> und frage dort Kontakte an.</>
              : 'Lege zuerst in Schritt 3 deinen Agenten an.'}
          </Notice>
        )}
      </Panel>

      <div className="flex flex-col items-start gap-3 rounded-2xl border bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-medium">Weiter im Netzwerk</p>
          <p className="text-sm text-muted-foreground">Kontakte, signierte Chats, Gruppen und Dateien bis 6 MB. Mit deiner Wiederherstellungsdatei.</p>
        </div>
        <Button className="h-10 shrink-0 rounded-full px-5" asChild>
          <a href="/network">/network öffnen <ArrowRightIcon aria-hidden="true" data-icon="inline-end" /></a>
        </Button>
      </div>
    </div>
  )
}
