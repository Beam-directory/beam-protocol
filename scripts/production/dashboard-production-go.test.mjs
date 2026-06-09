import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDashboardProductionGoConfig,
  inspectVercelState,
  runDashboardProductionGo,
} from './dashboard-production-go.mjs'

function config(args = []) {
  return createDashboardProductionGoConfig({
    argv: ['node', 'dashboard-production-go.mjs', ...args],
    env: {},
  })
}

function preflight(ok) {
  return {
    ok,
    dashboardDomain: 'dashboard.beam.directory',
    dashboardBase: 'https://dashboard.beam.directory',
    expectedRecordType: 'A',
    expectedRecordValue: '76.76.21.21',
    expectedCname: 'cname.vercel-dns.com',
    expectedA: '76.76.21.21',
    publicDns: {
      cname: [],
      a: ok ? ['76.76.21.21'] : [],
      errors: { cname: null, a: ok ? null : { code: 'ENOTFOUND', message: 'missing' } },
      expectedCnamePresent: false,
      expectedARecordPresent: ok,
      expectedRecordPresent: ok,
    },
    godaddy: {
      checked: true,
      cname: [],
      a: ok ? [{ data: '76.76.21.21', name: 'dashboard', ttl: 600 }] : [],
      expectedCnamePresent: false,
      expectedARecordPresent: ok,
      expectedRecordPresent: ok,
    },
    dashboard: {
      reachable: ok,
      status: ok ? 200 : null,
      title: ok ? 'Beam Control Plane' : null,
      shellReady: ok,
      error: ok ? null : { code: 'ENOTFOUND' },
    },
    attempts: 1,
  }
}

test('dashboard production GO defaults to dry-run and does not apply actions', async () => {
  let execCalls = 0
  let fetchCalls = 0
  const result = await runDashboardProductionGo(config(), {
    runDashboardDomainPreflight: async () => preflight(false),
    inspectVercelState: async () => ({ checked: true, protection: { customDomainsBypassSso: true } }),
    execFile: async () => {
      execCalls += 1
      return { stdout: '', stderr: '' }
    },
    fetch: async () => {
      fetchCalls += 1
      throw new Error('fetch should not be called in dry-run')
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.ready, false)
  assert.equal(result.mode, 'dry-run')
  assert.equal(result.applied.length, 0)
  assert.equal(result.plannedActions.vercelDomain.apply, false)
  assert.equal(result.plannedActions.godaddyDns.apply, false)
  assert.equal(result.vercelBefore.checked, true)
  assert.equal(execCalls, 0)
  assert.equal(fetchCalls, 0)
})

test('dashboard production GO refuses apply mode without domain confirmation', async () => {
  await assert.rejects(
    () => runDashboardProductionGo(config(['--apply-godaddy-dns']), {
      runDashboardDomainPreflight: async () => preflight(false),
      inspectVercelState: async () => ({ checked: true }),
    }),
    /Refusing to change production/,
  )
})

test('dashboard production GO inspects Vercel domain and protection read-only', async () => {
  const calls = []
  const result = await inspectVercelState(config(), {
    execFile: async (command, args) => {
      calls.push([command, ...args])
      if (args[0] === 'domains' && args[1] === 'inspect') {
        return {
          stdout: [
            'Fetching Domain dashboard.beam.directory under alfridus1s-projects',
            '> Domain dashboard.beam.directory found under alfridus1s-projects',
            'WARNING! This Domain is not configured properly.',
            'Set the following record on your DNS provider to continue: `A dashboard.beam.directory 76.76.21.21` [recommended]',
          ].join('\n'),
          stderr: '',
        }
      }
      if (args[0] === 'project' && args[1] === 'inspect') {
        return {
          stdout: [
            '> Found Project alfridus1s-projects/dashboard',
            'ID prj_1PjxTEV1rfEmDtNtgxlYI7ql59QG',
            'Name dashboard',
            'Framework Preset Vite',
            'Node.js Version 24.x',
          ].join('\n'),
          stderr: '',
        }
      }
      if (args[0] === 'project' && args[1] === 'protection') {
        return {
          stdout: JSON.stringify({
            projectId: 'prj_1PjxTEV1rfEmDtNtgxlYI7ql59QG',
            name: 'dashboard',
            ssoProtection: { deploymentType: 'all_except_custom_domains' },
            gitForkProtection: true,
            skewProtectionMaxAge: 43200,
          }),
          stderr: '',
        }
      }
      if (args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            deployments: [
              {
                url: 'dashboard-7ty5nk4f4-alfridus1s-projects.vercel.app',
                name: 'dashboard',
                state: 'READY',
                target: 'production',
                createdAt: 1775052936738,
                ready: 1775052954232,
                meta: {
                  gitCommitRef: 'main',
                  gitCommitSha: '7762e6de09f1dc04730ea1c1268e4dc6d097bad6',
                  gitCommitMessage: 'Merge pull request #135',
                  gitDirty: '1',
                  beamDashboardVersion: '1.1.0',
                },
              },
            ],
          }),
          stderr: '',
        }
      }
      if (args[0] === 'inspect' && args.includes('--logs')) {
        return {
          stdout: [
            '> @beam-protocol/dashboard@1.1.0 build',
            '> tsc && vite build',
          ].join('\n'),
          stderr: '',
        }
      }
      if (args[0] === 'inspect') {
        return {
          stdout: [
            'Aliases',
            '╶ https://dashboard-phi-five-73.vercel.app',
            '╶ https://dashboard-alfridus1s-projects.vercel.app',
          ].join('\n'),
          stderr: '',
        }
      }
      throw new Error(`unexpected vercel command: ${args.join(' ')}`)
    },
  })

  assert.equal(result.checked, true)
  assert.equal(result.domain.found, true)
  assert.equal(result.domain.configuredProperly, false)
  assert.equal(result.domain.recommendedRecord, 'A dashboard.beam.directory 76.76.21.21')
  assert.equal(result.project.id, 'prj_1PjxTEV1rfEmDtNtgxlYI7ql59QG')
  assert.equal(result.project.framework, 'Vite')
  assert.equal(result.protection.customDomainsBypassSso, true)
  assert.equal(result.latestProductionDeployment.latest.url, 'dashboard-7ty5nk4f4-alfridus1s-projects.vercel.app')
  assert.equal(result.latestProductionDeployment.latest.dashboardVersionMeta, '1.1.0')
  assert.equal(result.latestProductionDeployment.packageVersion, '1.1.0')
  assert.equal(result.latestProductionDeployment.expectedPackageVersion, '1.6.0')
  assert.equal(result.latestProductionDeployment.packageVersionMatches, false)
  assert.deepEqual(result.latestProductionDeployment.aliases, [
    'dashboard-phi-five-73.vercel.app',
    'dashboard-alfridus1s-projects.vercel.app',
  ])
  assert.equal(calls.some((call) => call.includes('add')), false)
})

test('dashboard production GO rejects the old CNAME-specific apply flag', () => {
  assert.throws(
    () => config(['--apply-godaddy-cname']),
    /Use --apply-godaddy-dns/,
  )
})

test('dashboard production GO can apply Vercel and GoDaddy actions behind confirmation', async () => {
  const seenCommands = []
  const seenFetches = []
  let preflightCalls = 0

  const result = await runDashboardProductionGo(config([
    '--apply-vercel-domain',
    '--apply-godaddy-dns',
    '--confirm-production-change',
    'dashboard.beam.directory',
  ]), {
    runDashboardDomainPreflight: async () => {
      preflightCalls += 1
      return preflight(preflightCalls > 1)
    },
    inspectVercelState: async () => ({ checked: true, protection: { customDomainsBypassSso: true } }),
    execFile: async (command, args) => {
      seenCommands.push([command, ...args])
      return { stdout: 'domain attached', stderr: '' }
    },
    loadGoDaddyCredentials: async () => ({
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      source: 'test',
    }),
    fetch: async (url, init) => {
      seenFetches.push({ url: String(url), init })
      return {
        ok: true,
        status: 200,
        text: async () => '',
      }
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.ready, true)
  assert.equal(result.mode, 'apply')
  assert.equal(preflightCalls, 2)
  assert.equal(result.applied.length, 2)
  assert.deepEqual(seenCommands[0].slice(0, 5), ['vercel', 'domains', 'add', 'dashboard.beam.directory', 'dashboard'])
  assert.equal(seenFetches[0].init.method, 'PUT')
  assert.match(seenFetches[0].url, /\/records\/A\/dashboard$/u)
  assert.equal(seenFetches[0].init.body, '[{"data":"76.76.21.21","ttl":600}]')
  assert.equal(JSON.stringify(result).includes('test-key'), false)
  assert.equal(JSON.stringify(result).includes('test-secret'), false)
})
