import assert from 'node:assert/strict'
import test from 'node:test'
import { persistOrganizationClaim } from './claim-organization.mjs'

test('a disambiguated claim name is stored and the organization key is kept', () => {
  const written = []
  const saved = persistOrganizationClaim({
    payload: {
      name: 'coppen--de',
      requestedName: 'coppen',
      displayName: 'COPPEN GmbH',
      domain: 'coppen.de',
      beamDomain: 'coppen--de.beam.directory',
      apiKey: 'beam_org_secret',
      verification: { txtName: '_beam-verification.coppen.de', txtValue: 'beam-verification=token' },
      claimExpiresAt: '2026-10-11T00:00:00.000Z',
      createdAt: '2026-10-08T00:00:00.000Z',
    },
    requestedName: 'coppen',
    domain: 'coppen.de',
    directoryUrl: 'https://api.beam.directory',
    write(credential) {
      written.push(credential)
    },
  })
  assert.equal(saved.ok, true)
  assert.equal(written.length, 1)
  assert.equal(written[0].name, 'coppen--de')
  assert.equal(written[0].apiKey, 'beam_org_secret')
})

test('a mismatched claim still writes the organization key before failing', () => {
  const written = []
  const saved = persistOrganizationClaim({
    payload: {
      name: 'other--de',
      requestedName: 'other',
      domain: 'other.de',
      apiKey: 'beam_org_kept',
      verification: { txtName: '_beam-verification.other.de', txtValue: 'beam-verification=token' },
    },
    requestedName: 'coppen',
    domain: 'coppen.de',
    directoryUrl: 'https://api.beam.directory',
    write(credential) {
      written.push(credential)
    },
  })
  assert.equal(saved.ok, false)
  assert.equal(saved.saved, true)
  assert.equal(written[0].apiKey, 'beam_org_kept')
})
