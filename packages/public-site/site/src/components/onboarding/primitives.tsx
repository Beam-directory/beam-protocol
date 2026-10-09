import { useId, useState, type ReactNode } from 'react'
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, CircleDashedIcon, CopyIcon, DownloadIcon, InfoIcon, KeyRoundIcon, LoaderCircleIcon } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n/context'

export function Panel({ title, badge, children, className, id }: { title: string; badge?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  const headingId = useId()
  return (
    <section id={id} aria-labelledby={headingId} className={cn('beam-surface flex flex-col gap-4 rounded-2xl border p-5 sm:p-6', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-base font-semibold tracking-tight">{title}</h3>
        {badge}
      </div>
      {children}
    </section>
  )
}

/** Collapsed section for optional or technical parts of a step. Native <details>, so it works without JavaScript state. */
export function Collapsible({ title, children, id, className }: { title: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <details id={id} className={cn('group rounded-xl border bg-background/50', className)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-4 border-t px-4 py-4 text-sm">{children}</div>
    </details>
  )
}

/** A one-time file the user has to keep (company key, personal key, agent file). */
export function SaveFileBox({
  title, text, buttonLabel, onSave, saved, onSavedChange, savedLabel, buttonId,
}: {
  title: string
  text: string
  buttonLabel: string
  onSave: () => void
  saved: boolean
  onSavedChange?: (saved: boolean) => void
  savedLabel: string
  buttonId?: string
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <KeyRoundIcon aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-400" />
        {title}
      </p>
      <p className="text-sm leading-6 text-muted-foreground">{text}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button id={buttonId} type="button" variant={saved ? 'outline' : 'default'} className="h-9 rounded-full px-4" onClick={onSave}>
          <DownloadIcon aria-hidden="true" /> {buttonLabel}
        </Button>
        {onSavedChange ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--beam)]" checked={saved} onChange={(event) => onSavedChange(event.target.checked)} />
            {savedLabel}
          </label>
        ) : saved ? (
          <StatusBadge tone="success">{savedLabel}</StatusBadge>
        ) : null}
      </div>
    </div>
  )
}

export function SoonBadge() {
  const { t } = useI18n()
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-muted-foreground/40 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-muted-foreground">
      <CircleDashedIcon aria-hidden="true" className="size-3" />
      {t.common.comingSoon}
    </span>
  )
}

export function StatusBadge({ tone, children }: { tone: 'success' | 'pending' | 'neutral'; children: ReactNode }) {
  const styles = {
    success: 'border-success/30 bg-success/10 text-success',
    pending: 'border-beam/30 bg-beam/10 text-foreground',
    neutral: 'border-border bg-muted text-muted-foreground',
  }[tone]
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', styles)}>{children}</span>
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'error' | 'success'; title?: string; children: ReactNode }) {
  const icon = {
    info: <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-beam" />,
    warning: <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-500" />,
    error: <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />,
    success: <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />,
  }[tone]
  const border = {
    info: 'border-beam/25 bg-beam/5',
    warning: 'border-amber-500/30 bg-amber-500/5',
    error: 'border-destructive/30 bg-destructive/5',
    success: 'border-success/30 bg-success/5',
  }[tone]
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-xl border p-3.5 text-sm leading-6', border)}>
      {icon}
      <div className="flex min-w-0 flex-col gap-0.5">
        {title ? <p className="font-medium text-foreground">{title}</p> : null}
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}

export function TextField({
  id, label, value, onChange, description, error, placeholder, autoComplete, type = 'text', inputMode, disabled, prefix, suffix, maxLength,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  description?: ReactNode
  error?: string | null
  placeholder?: string
  autoComplete?: string
  type?: string
  inputMode?: 'text' | 'email' | 'numeric' | 'decimal' | 'url'
  disabled?: boolean
  prefix?: string
  suffix?: string
  maxLength?: number
}) {
  const descriptionId = `${id}-description`
  const errorId = `${id}-error`
  const describedBy = [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <div className="flex items-stretch">
        {prefix ? <span className="flex items-center rounded-l-lg border border-r-0 bg-muted px-2.5 font-mono text-xs text-muted-foreground">{prefix}</span> : null}
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          type={type}
          inputMode={inputMode}
          disabled={disabled}
          maxLength={maxLength}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn('h-10', prefix && 'rounded-l-none', suffix && 'rounded-r-none')}
        />
        {suffix ? <span className="flex max-w-[55%] items-center truncate rounded-r-lg border border-l-0 bg-muted px-2.5 font-mono text-xs text-muted-foreground">{suffix}</span> : null}
      </div>
      {description ? <p id={descriptionId} className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      {error ? <p id={errorId} className="text-xs leading-5 text-destructive">{error}</p> : null}
    </div>
  )
}

export function SelectField({
  id, label, value, onChange, children,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-lg border bg-background px-3 text-sm text-foreground"
      >
        {children}
      </select>
    </div>
  )
}

export function CopyField({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [revealed, setRevealed] = useState(!secret)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // The value stays selectable when clipboard access is denied.
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 rounded-lg border bg-background/70 p-1.5 pl-3">
        <code className="min-w-0 flex-1 font-mono text-[12.5px] break-all select-all">
          {revealed ? value : '•'.repeat(Math.min(value.length, 32))}
        </code>
        {secret ? (
          <button type="button" onClick={() => setRevealed((open) => !open)} className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            {revealed ? t.common.hide : t.common.show}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t.common.copyLabel(label)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {copied ? <CheckIcon aria-hidden="true" className="size-3.5 text-success" /> : <CopyIcon aria-hidden="true" className="size-3.5" />}
          <span aria-hidden="true" className="hidden sm:inline">{copied ? t.common.copied : t.common.copy}</span>
        </button>
      </div>
      <span className="sr-only" aria-live="polite">{copied ? t.common.copiedLabel(label) : ''}</span>
    </div>
  )
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      {label}
    </span>
  )
}

export function downloadJson(fileName: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
