#!/usr/bin/env node

import process from 'node:process'

function valueAfter(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`[godaddy-txt-record] ${message}`)
  process.exit(1)
}

function requireValue(flag) {
  const value = valueAfter(flag)?.trim()
  if (!value) fail(`${flag} is required`)
  return value
}

function normalizeFqdn(value) {
  return value.trim().toLowerCase().replace(/\.$/u, '')
}

const apply = process.argv.includes('--apply')
const zone = normalizeFqdn(requireValue('--zone'))
const record = normalizeFqdn(requireValue('--record'))
const value = requireValue('--value')
const confirmation = valueAfter('--confirm')?.trim()
const ttl = Number.parseInt(valueAfter('--ttl') ?? '600', 10)
const apiKey = process.env.GODADDY_API_KEY?.trim()
const apiSecret = process.env.GODADDY_API_SECRET?.trim()

if (!apiKey || !apiSecret) fail('GODADDY_API_KEY and GODADDY_API_SECRET are required')
if (!Number.isInteger(ttl) || ttl < 600) fail('--ttl must be an integer of at least 600 seconds')
if (!record.endsWith(`.${zone}`)) fail('--record must be inside --zone')

const relativeName = record.slice(0, -(zone.length + 1))
if (!relativeName || relativeName.includes('..')) fail('--record has an invalid relative name')
if (apply && confirmation !== record) {
  fail(`refusing to change DNS without --confirm ${record}`)
}

const url = `https://api.godaddy.com/v1/domains/${encodeURIComponent(zone)}/records/TXT/${encodeURIComponent(relativeName)}`
const headers = {
  Accept: 'application/json',
  Authorization: `sso-key ${apiKey}:${apiSecret}`,
  'Content-Type': 'application/json',
  'User-Agent': 'beam-dns-onboarding/1.0',
}

const currentResponse = await fetch(url, {
  headers,
  signal: AbortSignal.timeout(15_000),
})
const currentText = await currentResponse.text()
if (!currentResponse.ok) {
  fail(`GoDaddy TXT lookup failed with HTTP ${currentResponse.status}: ${currentText.slice(0, 240)}`)
}

let current
try {
  current = JSON.parse(currentText)
} catch {
  fail('GoDaddy TXT lookup returned invalid JSON')
}
if (!Array.isArray(current)) fail('GoDaddy TXT lookup returned an unexpected payload')

const existing = current
  .filter((entry) => entry && typeof entry.data === 'string')
  .map((entry) => ({ data: entry.data, ttl: Number.isInteger(entry.ttl) ? entry.ttl : ttl }))
const alreadyPresent = existing.some((entry) => entry.data === value)
const next = alreadyPresent ? existing : [...existing, { data: value, ttl }]

if (!apply || alreadyPresent) {
  console.log(JSON.stringify({
    ok: true,
    apply,
    changed: false,
    zone,
    record,
    type: 'TXT',
    existingValues: existing.length,
    plannedValues: next.length,
    alreadyPresent,
  }, null, 2))
  process.exit(0)
}

const updateResponse = await fetch(url, {
  method: 'PUT',
  headers,
  body: JSON.stringify(next),
  signal: AbortSignal.timeout(15_000),
})
const updateText = await updateResponse.text()
if (!updateResponse.ok) {
  fail(`GoDaddy TXT update failed with HTTP ${updateResponse.status}: ${updateText.slice(0, 240)}`)
}

console.log(JSON.stringify({
  ok: true,
  apply: true,
  changed: true,
  zone,
  record,
  type: 'TXT',
  previousValues: existing.length,
  currentValues: next.length,
  ttl,
}, null, 2))
