export const SCOPE_ACTIONS = ['read', 'schedule.commit', 'file.send', 'order'] as const

export type ScopeAction = (typeof SCOPE_ACTIONS)[number]

export type MoneyLimit = {
  maxAmount: string
  currency: string
}

export type ScopeGrant = {
  actions: ScopeAction[]
  order?: MoneyLimit
  file?: { maxBytes: number }
}

const AMOUNT_RE = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/
const CURRENCY_RE = /^[A-Z]{3}$/

export function parseScopeGrant(value: unknown): ScopeGrant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw['actions'])) {
    return null
  }
  const actions: ScopeAction[] = []
  for (const entry of raw['actions']) {
    if (typeof entry !== 'string' || !SCOPE_ACTIONS.includes(entry as ScopeAction) || actions.includes(entry as ScopeAction)) {
      return null
    }
    actions.push(entry as ScopeAction)
  }

  let order: MoneyLimit | undefined
  if (raw['order'] !== undefined) {
    if (!raw['order'] || typeof raw['order'] !== 'object' || Array.isArray(raw['order'])) {
      return null
    }
    const money = raw['order'] as Record<string, unknown>
    const maxAmount = typeof money['maxAmount'] === 'string' ? money['maxAmount'].trim() : ''
    const currency = typeof money['currency'] === 'string' ? money['currency'].trim().toUpperCase() : ''
    if (!AMOUNT_RE.test(maxAmount) || !CURRENCY_RE.test(currency) || !actions.includes('order')) {
      return null
    }
    order = { maxAmount, currency }
  }

  let file: { maxBytes: number } | undefined
  if (raw['file'] !== undefined) {
    if (!raw['file'] || typeof raw['file'] !== 'object' || Array.isArray(raw['file'])) {
      return null
    }
    const maxBytes = (raw['file'] as Record<string, unknown>)['maxBytes']
    if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !actions.includes('file.send')) {
      return null
    }
    file = { maxBytes }
  }

  return { actions, ...(order ? { order } : {}), ...(file ? { file } : {}) }
}

export function moneyWithinLimit(amount: string, currency: string, limit: MoneyLimit): boolean {
  if (!AMOUNT_RE.test(amount) || currency !== limit.currency) {
    return false
  }
  return amountToCents(amount) <= amountToCents(limit.maxAmount)
}

export function amountToCents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.')
  const cents = `${whole}${fraction.padEnd(2, '0')}`
  return BigInt(cents)
}

const INTENT_SCOPE: Record<string, ScopeAction> = {
  'schedule.commit': 'schedule.commit',
  'file.send': 'file.send',
  'file.forward': 'file.send',
  'order.place': 'order',
  'payment.submit': 'order',
}

export function scopeActionForIntent(intent: string): ScopeAction | null {
  return INTENT_SCOPE[intent] ?? null
}

export function scopeWithin(child: ScopeGrant, parent: ScopeGrant): boolean {
  if (child.actions.some((action) => !parent.actions.includes(action))) {
    return false
  }
  if (child.actions.includes('order') && parent.order) {
    if (!child.order || parent.order.currency !== child.order.currency) {
      return false
    }
    if (amountToCents(child.order.maxAmount) > amountToCents(parent.order.maxAmount)) {
      return false
    }
  }
  if (child.actions.includes('file.send') && parent.file) {
    if (!child.file || child.file.maxBytes > parent.file.maxBytes) {
      return false
    }
  }
  return true
}
