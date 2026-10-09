import { randomUUID } from 'node:crypto'

export type KycProviderId = 'manual' | 'stripe_identity'

export type KycRequest = {
  provider: KycProviderId
  status: 'pending'
  reference: string
}

export interface KycAdapter {
  readonly id: KycProviderId
  /** True when this adapter opens a paid vendor session instead of a local reference. */
  readonly createsVendorSession: boolean
  request(input: { personId: string; email: string }): KycRequest
}

const manualKycAdapter: KycAdapter = {
  id: 'manual',
  createsVendorSession: false,
  request(input) {
    return {
      provider: 'manual',
      status: 'pending',
      reference: `manual:${input.personId}:${randomUUID()}`,
    }
  },
}

/** Known provider. Session creation lives in stripe-identity.ts and stays disabled without secrets. */
const stripeIdentityAdapter: KycAdapter = {
  id: 'stripe_identity',
  createsVendorSession: true,
  request() {
    throw new Error('Stripe Identity sessions are created by beginStripeIdentitySession')
  },
}

export function getKycAdapter(id: string): KycAdapter | null {
  if (id === 'manual') return manualKycAdapter
  if (id === 'stripe_identity') return stripeIdentityAdapter
  return null
}
