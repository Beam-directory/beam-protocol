import { randomUUID } from 'node:crypto'

export type KycProviderId = 'manual'

export type KycRequest = {
  provider: KycProviderId
  status: 'pending'
  reference: string
}

export interface KycAdapter {
  readonly id: KycProviderId
  request(input: { personId: string; email: string }): KycRequest
}

const manualKycAdapter: KycAdapter = {
  id: 'manual',
  request(input) {
    return {
      provider: 'manual',
      status: 'pending',
      reference: `manual:${input.personId}:${randomUUID()}`,
    }
  },
}

export function getKycAdapter(id: string): KycAdapter | null {
  if (id === 'manual') {
    return manualKycAdapter
  }
  return null
}
