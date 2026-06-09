import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForDashboardShell } from './dashboard-shell-check.mjs'

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://dashboard.example.test/',
    text: async () => body,
  }
}

test('dashboard shell check passes with the expected dashboard version marker', async () => {
  const result = await waitForDashboardShell('https://dashboard.example.test/', {
    timeoutMs: 0,
    intervalMs: 0,
    expectedDashboardVersion: '1.6.0',
    fetchImpl: async () => response('<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.6.0"></div>'),
  })

  assert.equal(result.validation.shellReady, true)
  assert.equal(result.validation.dashboardVersion, '1.6.0')
})

test('dashboard shell check rejects stale dashboard versions', async () => {
  await assert.rejects(
    () => waitForDashboardShell('https://dashboard.example.test/', {
      timeoutMs: 0,
      intervalMs: 0,
      expectedDashboardVersion: '1.6.0',
      fetchImpl: async () => response('<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.1.0"></div>'),
    }),
    /version: 1\.1\.0 !== 1\.6\.0/u,
  )
})

test('dashboard shell check retries until the expected version marker appears', async () => {
  let attempts = 0
  const result = await waitForDashboardShell('https://dashboard.example.test/', {
    timeoutMs: 100,
    intervalMs: 1,
    expectedDashboardVersion: '1.6.0',
    sleepImpl: async () => undefined,
    fetchImpl: async () => {
      attempts += 1
      return response(attempts === 1
        ? '<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.1.0"></div>'
        : '<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.6.0"></div>')
    },
  })

  assert.equal(result.attempts, 2)
  assert.equal(result.validation.dashboardVersion, '1.6.0')
})

test('dashboard shell check falls back to public DNS when system resolver is stale', async () => {
  const resolverError = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ENOTFOUND', hostname: 'dashboard.example.test' },
  })
  const result = await waitForDashboardShell('https://dashboard.example.test/', {
    timeoutMs: 0,
    intervalMs: 0,
    expectedDashboardVersion: '1.6.0',
    fetchImpl: async () => {
      throw resolverError
    },
    dnsImpl: {
      resolve4: async () => ['76.76.21.21'],
    },
    fetchResolvedImpl: async (url, ip) => {
      assert.equal(url, 'https://dashboard.example.test/')
      assert.equal(ip, '76.76.21.21')
      return response('<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.6.0"></div>')
    },
  })

  assert.equal(result.validation.shellReady, true)
  assert.equal(result.validation.dashboardVersion, '1.6.0')
})
