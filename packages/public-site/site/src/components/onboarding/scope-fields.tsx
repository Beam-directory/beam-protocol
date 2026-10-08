import type { ReactNode } from 'react'
import { TextField } from '@/components/onboarding/primitives'
import { useI18n } from '@/i18n/context'
import type { ScopeDraft } from '@/lib/onboarding-steps'

function Check({ id, label, checked, onChange, children }: { id: string; label: string; checked: boolean; onChange: (value: boolean) => void; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 has-[:checked]:border-beam/50 has-[:checked]:bg-beam/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm">
        <input id={id} type="checkbox" className="size-4 accent-[var(--beam)]" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        {label}
      </label>
      {checked && children ? <div className="pl-6.5">{children}</div> : null}
    </div>
  )
}

/** Rights and mandate scopes. Actions match packages/directory/src/trust/scopes.ts. */
export function ScopeFields({ idPrefix, value, onChange }: { idPrefix: string; value: ScopeDraft; onChange: (next: ScopeDraft) => void }) {
  const { t } = useI18n()
  const copy = t.onboarding.scopes
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Check id={`${idPrefix}-read`} label={copy.read} checked={value.read} onChange={(read) => onChange({ ...value, read })} />
      <Check id={`${idPrefix}-schedule`} label={copy.schedule} checked={value.schedule} onChange={(schedule) => onChange({ ...value, schedule })} />
      <Check id={`${idPrefix}-files`} label={copy.files} checked={value.files} onChange={(files) => onChange({ ...value, files })} />
      <Check id={`${idPrefix}-order`} label={copy.order} checked={value.order} onChange={(order) => onChange({ ...value, order })}>
        <TextField
          id={`${idPrefix}-order-limit`}
          label={copy.orderLimit}
          inputMode="decimal"
          value={value.orderLimitEur}
          onChange={(orderLimitEur) => onChange({ ...value, orderLimitEur })}
          placeholder="500.00"
        />
      </Check>
    </div>
  )
}
