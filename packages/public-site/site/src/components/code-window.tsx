import { useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { useI18n } from '@/i18n/context'

export type Snippet = { id: string; label: string; code: string }

/** Lines starting with # are rendered as comments. */
function CodeLines({ code }: { code: string }) {
  return (
    <>
      {code.split('\n').map((line, index) => (
        <span key={index} className={line.trimStart().startsWith('#') ? 'block text-muted-foreground' : 'block text-foreground'}>
          {line || ' '}
        </span>
      ))}
    </>
  )
}

export function CodeWindow({ snippets, label }: { snippets: Snippet[]; label: string }) {
  const { t } = useI18n()
  const [active, setActive] = useState(snippets[0]?.id ?? '')
  const [copied, setCopied] = useState(false)

  async function copy() {
    const snippet = snippets.find((item) => item.id === active)
    if (!snippet || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(snippet.code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be denied; the code stays selectable.
    }
  }

  return (
    <TabsPrimitive.Root
      value={active}
      onValueChange={(value) => {
        setActive(value)
        setCopied(false)
      }}
      className="beam-surface overflow-hidden rounded-2xl border"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span aria-hidden="true" className="mr-1 hidden gap-1.5 sm:flex">
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
          <span className="size-2.5 rounded-full bg-muted-foreground/25" />
        </span>
        <TabsPrimitive.List aria-label={label} className="flex min-w-0 gap-1 overflow-x-auto">
          {snippets.map((snippet) => (
            <TabsPrimitive.Trigger
              key={snippet.id}
              value={snippet.id}
              className="shrink-0 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground"
            >
              {snippet.label}
            </TabsPrimitive.Trigger>
          ))}
        </TabsPrimitive.List>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t.common.copyCode}
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <CheckIcon aria-hidden="true" className="size-3.5 text-success" /> : <CopyIcon aria-hidden="true" className="size-3.5" />}
          <span aria-hidden="true" className="hidden sm:inline">{copied ? t.common.copied : t.common.copy}</span>
        </button>
        <span className="sr-only" aria-live="polite">{copied ? t.common.copiedToClipboard : ''}</span>
      </div>
      {snippets.map((snippet) => (
        <TabsPrimitive.Content key={snippet.id} value={snippet.id} className="outline-none">
          <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-6 sm:p-5" tabIndex={0} aria-label={t.common.codeLabel(snippet.label)}>
            <code>
              <CodeLines code={snippet.code} />
            </code>
          </pre>
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  )
}
