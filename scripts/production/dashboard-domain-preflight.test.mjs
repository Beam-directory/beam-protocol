import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDashboardDomainConfig,
  normalizeDnsValue,
  runDashboardDomainPreflight,
} from './dashboard-domain-preflight.mjs'

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://example.test/',
    text: async () => body,
  }
}

function config(args = []) {
  return createDashboardDomainConfig({
    argv: ['node', 'dashboard-domain-preflight.mjs', ...args],
    env: {},
  })
}

test('dashboard domain config derives the default GoDaddy record and normalizes DNS names', () => {
  const result = config(['--domain', 'dashboard.beam.directory', '--expected-cname', 'CNAME.VERCEL-DNS.COM.'])

  assert.equal(result.dashboardDomain, 'dashboard.beam.directory')
  assert.equal(result.godaddyZone, 'beam.directory')
  assert.equal(result.godaddyRecord, 'dashboard')
  assert.equal(result.expectedRecordType, 'CNAME')
  assert.equal(result.expectedRecordValue, 'cname.vercel-dns.com')
  assert.equal(result.expectedCname, 'cname.vercel-dns.com')
  assert.equal(normalizeDnsValue('CNAME.VERCEL-DNS.COM.'), 'cname.vercel-dns.com')
})

test('dashboard domain config defaults to the Vercel-recommended A record', () => {
  const result = config()

  assert.equal(result.expectedRecordType, 'A')
  assert.equal(result.expectedRecordValue, '76.76.21.21')
  assert.equal(result.expectedA, '76.76.21.21')
})

test('dashboard domain preflight passes with matching public A DNS, GoDaddy DNS, and shell', async () => {
  const preflightConfig = config(['--godaddy-env', '/tmp/godaddy.env'])
  const result = await runDashboardDomainPreflight(preflightConfig, {
    dns: {
      resolveCname: async () => [],
      resolve4: async () => ['76.76.21.21'],
      resolve6: async () => [],
    },
    readFile: async () => [
      'PATH=/broken/on/purpose',
      'GODADDY_API_KEY="test-key"',
      "GODADDY_API_SECRET='test-secret'",
    ].join('\n'),
    fetch: async (url) => {
      const href = String(url)
      if (href.includes('/records/CNAME/dashboard')) {
        return response(JSON.stringify([]))
      }
      if (href.includes('/records/A/dashboard')) {
        return response(JSON.stringify([{ data: '76.76.21.21', name: 'dashboard', ttl: 600 }]))
      }
      if (href.includes('/records/AAAA/dashboard')) {
        return response(JSON.stringify([]))
      }
      return response('<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.6.0"></div>')
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.publicDns.expectedARecordPresent, true)
  assert.equal(result.godaddy.expectedARecordPresent, true)
  assert.equal(result.publicDns.expectedRecordPresent, true)
  assert.equal(result.godaddy.expectedRecordPresent, true)
  assert.equal(result.dashboard.shellReady, true)
  assert.equal(result.dashboard.dashboardVersion, '1.6.0')
  assert.equal(result.godaddy.credentialSource, 'env-file')
  assert.equal(JSON.stringify(result).includes('test-key'), false)
  assert.equal(JSON.stringify(result).includes('test-secret'), false)
})

test('dashboard domain preflight exposes missing DNS and unreachable shell without secrets', async () => {
  const dnsError = Object.assign(new Error('queryCname ENOTFOUND dashboard.beam.directory'), { code: 'ENOTFOUND' })
  const fetchError = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ENOTFOUND', hostname: 'dashboard.beam.directory' },
  })
  const preflightConfig = config(['--godaddy-env', '/tmp/godaddy.env'])

  const result = await runDashboardDomainPreflight(preflightConfig, {
    dns: {
      resolveCname: async () => { throw dnsError },
      resolve4: async () => { throw dnsError },
      resolve6: async () => { throw dnsError },
    },
    readFile: async () => [
      'GODADDY_API_KEY=test-key',
      'GODADDY_API_SECRET=test-secret',
    ].join('\n'),
    fetch: async (url) => {
      const href = String(url)
      if (href.includes('/records/')) {
        return response(JSON.stringify([]))
      }
      throw fetchError
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.publicDns.expectedRecordPresent, false)
  assert.equal(result.publicDns.errors.cname.code, 'ENOTFOUND')
  assert.equal(result.godaddy.expectedRecordPresent, false)
  assert.deepEqual(result.godaddy.cname, [])
  assert.equal(result.dashboard.reachable, false)
  assert.equal(result.dashboard.error.code, 'ENOTFOUND')
  assert.equal(result.dashboard.error.hostname, 'dashboard.beam.directory')
  assert.equal(JSON.stringify(result).includes('test-key'), false)
  assert.equal(JSON.stringify(result).includes('test-secret'), false)
})

test('dashboard domain preflight retries transient DNS propagation failures', async () => {
  let cnameAttempts = 0
  const preflightConfig = config(['--record-type', 'CNAME', '--timeout-ms', '100', '--interval-ms', '1'])

  const result = await runDashboardDomainPreflight(preflightConfig, {
    dns: {
      resolveCname: async () => {
        cnameAttempts += 1
        if (cnameAttempts === 1) {
          throw Object.assign(new Error('queryCname ENOTFOUND dashboard.beam.directory'), { code: 'ENOTFOUND' })
        }
        return ['cname.vercel-dns.com.']
      },
      resolve4: async () => [],
      resolve6: async () => [],
    },
    fetch: async () => response('<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.6.0"></div>'),
    sleep: async () => undefined,
  })

  assert.equal(result.ok, true)
  assert.equal(result.attempts, 2)
  assert.equal(cnameAttempts, 2)
  assert.equal(result.publicDns.expectedCnamePresent, true)
  assert.equal(result.godaddy.checked, false)
  assert.equal(result.dashboard.shellReady, true)
})

test('dashboard domain preflight falls back to public DNS for stale system resolver misses', async () => {
  const resolverError = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ENOTFOUND', hostname: 'dashboard.beam.directory' },
  })
  const result = await runDashboardDomainPreflight(config(), {
    dns: {
      resolveCname: async () => [],
      resolve4: async () => ['76.76.21.21'],
      resolve6: async () => [],
    },
    fetch: async () => {
      throw resolverError
    },
    fetchResolved: async (_config, url, ip) => {
      assert.equal(url, 'https://dashboard.beam.directory/')
      assert.equal(ip, '76.76.21.21')
      return {
        response: response('<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.6.0"></div>'),
        text: '<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.6.0"></div>',
      }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.dashboard.resolvedViaPublicDns, true)
  assert.equal(result.dashboard.resolvedIp, '76.76.21.21')
  assert.equal(result.dashboard.shellReady, true)
})

test('dashboard domain preflight rejects a shell with a stale dashboard version', async () => {
  const result = await runDashboardDomainPreflight(config(), {
    dns: {
      resolveCname: async () => [],
      resolve4: async () => ['76.76.21.21'],
      resolve6: async () => [],
    },
    fetch: async () => response('<!doctype html><title>Beam Control Plane</title><div id="root" data-beam-dashboard-version="1.1.0"></div>'),
  })

  assert.equal(result.ok, false)
  assert.equal(result.dashboard.shellReady, false)
  assert.equal(result.dashboard.dashboardVersion, '1.1.0')
  assert.equal(result.dashboard.expectedDashboardVersion, '1.6.0')
  assert.equal(result.dashboard.versionReady, false)
})
