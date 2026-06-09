import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDashboardShellVersion, formatDate, validateDashboardShellHtml } from './shared.mjs'

test('formatDate uses the Beam ops timezone by default', () => {
  assert.equal(formatDate(new Date('2026-06-08T23:18:51.657Z')), '2026-06-09')
})

test('formatDate supports explicit UTC reports when needed', () => {
  assert.equal(formatDate(new Date('2026-06-08T23:18:51.657Z'), 'UTC'), '2026-06-08')
})

test('formatDate falls back to ISO date for invalid timezone configuration', () => {
  assert.equal(formatDate(new Date('2026-06-08T23:18:51.657Z'), 'Not/A_Zone'), '2026-06-08')
})

test('dashboard shell version is extracted from the root marker first', () => {
  const html = '<!doctype html><meta name="beam-dashboard-version" content="1.5.0"><div id="root" data-beam-dashboard-version="1.6.0"></div>'

  assert.equal(extractDashboardShellVersion(html), '1.6.0')
})

test('dashboard shell version can fall back to the meta marker', () => {
  const html = '<!doctype html><meta content="1.6.0" name="beam-dashboard-version"><div id="root"></div>'

  assert.equal(extractDashboardShellVersion(html), '1.6.0')
})

test('dashboard shell validator rejects missing or stale version markers', () => {
  const missing = validateDashboardShellHtml('<title>Beam Control Plane</title><div id="root"></div>', '1.6.0')
  const stale = validateDashboardShellHtml('<title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.1.0"></div>', '1.6.0')

  assert.equal(missing.shellReady, false)
  assert.equal(missing.versionReady, false)
  assert.equal(stale.shellReady, false)
  assert.equal(stale.versionReady, false)
})
