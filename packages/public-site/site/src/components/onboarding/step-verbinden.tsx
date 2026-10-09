import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRightIcon, SendIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CodeWindow, type Snippet } from '@/components/code-window'
import { Collapsible, CopyField, Notice, SoonBadge, Spinner, TextField } from '@/components/onboarding/primitives'
import type { StepProps } from '@/components/onboarding/types'
import type { Messages } from '@/i18n/en'
import { useI18n } from '@/i18n/context'
import { describeError, sendContactRequest, type ContactRequestResult } from '@/lib/onboarding-api'
import { validateContactMessage, validateRecipientBeamId, type ValidationKey } from '@/lib/onboarding-steps'

const DOCS_URL = 'https://docs.beam.directory'

type SnippetCopy = Messages['onboarding']['connect']['snippetComments']

/** Snippets follow integrations/grok-build, integrations/codex/beam and packages/mcp-server/README.md. */
export function connectSnippets(beamId: string, copy: SnippetCopy): Snippet[] {
  const id = beamId || 'agent@company.beam.directory'
  const server = `${copy.repoPath}/packages/mcp-server/dist/index.js`
  return [
    {
      id: 'grok',
      label: 'Grok',
      code: `${copy.grokPlugin}
export BEAM_MCP_URL='${copy.tenantUrl}'
grok
grok mcp doctor beam

${copy.grokLocal}
grok mcp add beam -- node ${server}`,
    },
    {
      id: 'claude',
      label: 'Claude',
      code: `${copy.claude}
claude mcp add beam \\
  -e BEAM_ID='${id}' \\
  -e BEAM_PUBLIC_KEY_BASE64='<identity.publicKey>' \\
  -e BEAM_PRIVATE_KEY_BASE64='<identity.privateKey>' \\
  -e BEAM_API_KEY='<credential.apiKey>' \\
  -- node ${server}`,
    },
    {
      id: 'openai',
      label: 'OpenAI',
      code: `${copy.openai}
codex mcp add beam --url '${copy.tenantUrl}'
codex mcp login beam
codex mcp list`,
    },
    {
      id: 'mcp',
      label: 'MCP',
      code: `${copy.mcp}
{
  "mcpServers": {
    "beam": {
      "type": "http",
      "url": "${copy.tenantUrl}"
    }
  }
}`,
    },
  ]
}

export function StepVerbinden({ progress, secrets }: Pick<StepProps, 'progress' | 'secrets'>) {
  const { t, href } = useI18n()
  const copy = t.onboarding.connect
  const [recipient, setRecipient] = useState('')
  const [message, setMessage] = useState('')
  const [fieldError, setFieldError] = useState<ValidationKey | null>(null)
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
      setError(describeError(sendError, t.errors))
    } finally {
      setPending(false)
    }
  }

  if (!beamId) return <Notice tone="warning">{copy.createFirst}</Notice>

  return (
    <div className="flex flex-col gap-5">
      <div className="beam-surface flex flex-col gap-4 rounded-2xl border p-5 sm:p-6">
        <CopyField label={copy.addressTitle} value={beamId} />
        <div className="flex flex-wrap gap-3">
          <Button id="check-own-agent" className="h-10 rounded-full px-5" asChild>
            <Link to={`${href('verify')}?agent=${encodeURIComponent(beamId)}`}>
              {copy.checkIt} <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-col items-start gap-3 rounded-2xl border bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-medium">{copy.networkTitle}</p>
          <p className="text-sm text-muted-foreground">{copy.networkText}</p>
        </div>
        <Button variant="outline" className="h-10 shrink-0 rounded-full px-5" asChild>
          <a href="/network">{copy.openNetwork} <ArrowRightIcon aria-hidden="true" data-icon="inline-end" /></a>
        </Button>
      </div>

      <Collapsible id="connect-assistant" title={copy.assistantTitle}>
        <p className="leading-6 text-muted-foreground">{copy.connectIntro} {copy.previewNote}</p>
        <CodeWindow snippets={connectSnippets(beamId, copy.snippetComments)} label={copy.setupLabel} />
        <div className="flex flex-col gap-2 rounded-xl border border-dashed p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">{copy.grokTitle}</p>
            <SoonBadge />
          </div>
          <p className="leading-6 text-muted-foreground">{copy.grokText}</p>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {copy.claudeNote}{' '}
          <a className="underline underline-offset-4 hover:text-foreground" href={DOCS_URL}>{copy.docs}</a>
        </p>
      </Collapsible>

      <Collapsible id="connect-contact" title={copy.contactTitle}>
        {result ? (
          <Notice tone="success" title={copy.sentTitle}>
            {copy.sentBefore} <span className="font-mono text-foreground">{result.recipientBeamId}</span> {copy.sentAfter}
          </Notice>
        ) : canSend ? (
          <form onSubmit={onSend} className="flex flex-col gap-4" noValidate>
            <p className="leading-6 text-muted-foreground">{copy.contactIntro}</p>
            <TextField
              id="contact-recipient"
              label={copy.recipient}
              value={recipient}
              onChange={setRecipient}
              placeholder="lakis@partner.beam.directory"
              autoComplete="off"
              error={fieldError ? t.validation[fieldError] : null}
            />
            <TextField
              id="contact-message"
              label={copy.message}
              value={message}
              onChange={setMessage}
              placeholder={copy.messagePlaceholder}
              maxLength={280}
              description={copy.chars(message.trim().length)}
            />
            {error ? <Notice tone="error">{error}</Notice> : null}
            <div>
              <Button type="submit" className="h-10 rounded-full px-5" disabled={pending}>
                {pending ? <Spinner label={copy.sending} /> : <><SendIcon aria-hidden="true" /> {copy.send}</>}
              </Button>
            </div>
          </form>
        ) : (
          <Notice tone="info">
            {copy.keysNotLoadedBefore} <a className="underline underline-offset-4" href="/network">/network</a> {copy.keysNotLoadedAfter}
          </Notice>
        )}
      </Collapsible>
    </div>
  )
}
