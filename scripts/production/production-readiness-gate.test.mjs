import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createProductionReadinessConfig,
  inspectGithubReadiness,
  runProductionReadinessGate,
} from './production-readiness-gate.mjs'

function config(args = []) {
  return createProductionReadinessConfig({
    argv: ['node', 'production-readiness-gate.mjs', ...args],
    env: {},
  })
}

function dashboardResult(ready) {
  return {
    ok: true,
    ready,
    mode: 'dry-run',
    domain: 'dashboard.beam.directory',
    preflightBefore: {
      publicDns: {
        expectedRecordPresent: ready,
        errors: { a: ready ? null : { code: 'ENOTFOUND' } },
      },
      godaddy: {
        checked: true,
        expectedRecordPresent: ready,
      },
      dashboard: {
        shellReady: ready,
        status: ready ? 200 : null,
        error: ready ? null : { code: 'ENOTFOUND' },
      },
    },
    vercelBefore: {
      domain: {
        checked: true,
        configuredProperly: ready,
        recommendedRecord: ready ? null : 'A dashboard.beam.directory 76.76.21.21',
      },
      protection: {
        checked: true,
        customDomainsBypassSso: true,
      },
      latestProductionDeployment: {
        checked: true,
        packageVersion: ready ? '1.6.0' : '1.1.0',
        expectedPackageVersion: '1.6.0',
        packageVersionMatches: ready,
        latest: {
          dashboardVersionMeta: ready ? '1.6.0' : '1.1.0',
        },
        aliases: ready ? ['dashboard.beam.directory'] : ['dashboard-alfridus1s-projects.vercel.app'],
      },
    },
  }
}

function dogfoodResult(ok) {
  return {
    ok,
    evidencePath: '/tmp/evidence.json',
    counts: ok ? { externalOperators: 2 } : {},
    failures: ok ? [] : ['Need at least 2 distinct external operators; found 0.'],
  }
}

function githubResult(ok) {
  return {
    ok,
    checked: true,
    issue: { number: 196, state: ok ? 'CLOSED' : 'OPEN' },
    latestRun: { status: 'completed', conclusion: ok ? 'success' : 'failure' },
    failures: ok ? [] : ['GitHub issue #196 is OPEN.', 'Latest Deploy Dashboard run is completed/failure.'],
  }
}

test('production readiness gate aggregates blockers without mutating production', async () => {
  const result = await runProductionReadinessGate(config(), {
    runDashboardProductionGo: async () => dashboardResult(false),
    runExternalDogfoodGate: async () => dogfoodResult(false),
    inspectGithubReadiness: async () => githubResult(false),
  })

  assert.equal(result.ok, false)
  assert.equal(result.blockers.some((blocker) => blocker.includes('Dashboard production domain is not ready')), true)
  assert.equal(result.blockers.some((blocker) => blocker.includes('recommended record')), true)
  assert.equal(result.blockers.some((blocker) => blocker.includes('deployment version is 1.1.0')), true)
  assert.equal(result.blockers.some((blocker) => blocker.includes('metadata beamDashboardVersion is 1.1.0')), true)
  assert.equal(result.blockers.some((blocker) => blocker.includes('does not list dashboard.beam.directory')), true)
  assert.equal(result.blockers.some((blocker) => blocker.includes('External dogfood')), true)
  assert.equal(result.blockers.some((blocker) => blocker.includes('GitHub issue #196')), true)
})

test('production readiness gate passes only when dashboard, dogfood, and GitHub are ready', async () => {
  const result = await runProductionReadinessGate(config(), {
    runDashboardProductionGo: async () => dashboardResult(true),
    runExternalDogfoodGate: async () => dogfoodResult(true),
    inspectGithubReadiness: async () => githubResult(true),
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.blockers, [])
})

test('GitHub readiness requires issue closure and successful dashboard deploy run', async () => {
  const calls = []
  const result = await inspectGithubReadiness(config(), {
    execFile: async (command, args) => {
      calls.push([command, ...args])
      if (args[0] === 'issue') {
        return {
          stdout: JSON.stringify({
            number: 196,
            state: 'OPEN',
            title: 'Collect external dogfood and adoption evidence',
          }),
        }
      }
      if (args[0] === 'run') {
        return {
          stdout: JSON.stringify([
            {
              databaseId: 23945588562,
              status: 'completed',
              conclusion: 'failure',
              displayTitle: 'Deploy Dashboard',
            },
          ]),
        }
      }
      throw new Error(`unexpected gh command: ${args.join(' ')}`)
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('#196')), true)
  assert.equal(result.failures.some((failure) => failure.includes('completed/failure')), true)
  assert.equal(calls.every((call) => call[0] === 'gh'), true)
})
