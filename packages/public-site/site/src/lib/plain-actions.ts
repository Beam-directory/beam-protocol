export interface ActionWords {
  read: string
  schedule: string
  files: string
  order: (amount: string, currency: string) => string
}

/** Turns scope actions ("read", "file.send", …) into the words the site shows, e.g. "read, send files". */
export function describeActions(
  actions: readonly string[],
  order: { maxAmount: string; currency: string } | null | undefined,
  words: ActionWords,
): string {
  return actions
    .map((action) => {
      if (action === 'read') return words.read
      if (action === 'schedule.commit') return words.schedule
      if (action === 'file.send') return words.files
      if (action === 'order' && order) return words.order(order.maxAmount, order.currency)
      return action
    })
    .join(', ')
}
