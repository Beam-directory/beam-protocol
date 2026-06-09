import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDashboardDeploymentTruthConfig,
  runDashboardDeploymentTruthCheck,
} from './dashboard-deployment-truth-check.mjs'

function config(args = [], env = {}) {
  return createDashboardDeploymentTruthConfig({
    argv: ['node', 'dashboard-deployment-truth-check.mjs', ...args],
    env,
  })
}

function vercelFixture({ aliases = ['dashboard.beam.directory'], packageVersion = '1.6.0', latestUrl = 'dashboard-current.vercel.app', metadataVersion = '1.6.0' } = {}) {
  const calls = []
  return {
    calls,
    execFile: async (command, args) => {
      calls.push([command, ...args])
      if (args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            deployments: [
              {
                url: latestUrl,
                name: 'dashboard',
                state: 'READY',
                target: 'production',
                createdAt: 1775052936738,
                ready: 1775052954232,
                meta: { gitCommitSha: 'abc123', gitCommitRef: 'main', beamDashboardVersion: metadataVersion },
              },
            ],
          }),
          stderr: '',
        }
      }
      if (args[0] === 'inspect' && args.includes('--logs')) {
        return {
          stdout: [
            `> @beam-protocol/dashboard@${packageVersion} build`,
            '> tsc && vite build',
          ].join('\n'),
          stderr: '',
        }
      }
      if (args[0] === 'inspect') {
        return {
          stdout: ['Aliases', ...aliases.map((alias) => `╶ https://${alias}`)].join('\n'),
          stderr: '',
        }
      }
      throw new Error(`unexpected vercel command: ${args.join(' ')}`)
    },
  }
}

test('dashboard deployment truth check passes for latest production version and alias', async () => {
  const fixture = vercelFixture()
  const result = await runDashboardDeploymentTruthCheck(config([
    '--deployment-url',
    'https://dashboard-current.vercel.app/',
    '--vercel-token',
    'secret-token',
  ]), fixture)

  assert.equal(result.ok, true)
  assert.deepEqual(result.failures, [])
  assert.equal(result.deployment.packageVersion, '1.6.0')
  assert.equal(result.deployment.metadataVersion, '1.6.0')
  assert.equal(result.deployment.metadataVersionMatches, true)
  assert.equal(result.deployment.requiredAliasPresent, true)
  assert.equal(result.latestProduction.latest.url, 'dashboard-current.vercel.app')
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
  assert.equal(fixture.calls.some((call) => call.includes('secret-token')), true)
})

test('dashboard deployment truth check fails stale versions and missing aliases', async () => {
  const fixture = vercelFixture({
    aliases: ['dashboard-alfridus1s-projects.vercel.app'],
    packageVersion: '1.1.0',
    metadataVersion: '1.1.0',
  })
  const result = await runDashboardDeploymentTruthCheck(config(['--deployment-url', 'dashboard-current.vercel.app']), fixture)

  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('version is 1.1.0')), true)
  assert.equal(result.failures.some((failure) => failure.includes('metadata beamDashboardVersion is 1.1.0')), true)
  assert.equal(result.failures.some((failure) => failure.includes('required alias dashboard.beam.directory')), true)
})

test('dashboard deployment truth check requires dashboard version metadata on latest production', async () => {
  const fixture = vercelFixture({ metadataVersion: null })
  const result = await runDashboardDeploymentTruthCheck(config(['--deployment-url', 'dashboard-current.vercel.app']), fixture)

  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('metadata beamDashboardVersion is missing')), true)
})

test('dashboard deployment truth check requires the inspected deployment to be latest production', async () => {
  const fixture = vercelFixture({ latestUrl: 'dashboard-newer.vercel.app' })
  const result = await runDashboardDeploymentTruthCheck(config(['--deployment-url', 'dashboard-older.vercel.app']), fixture)

  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('is not the latest READY production deployment')), true)
})

test('dashboard deployment truth check retries alias propagation', async () => {
  let inspectAttempts = 0
  const result = await runDashboardDeploymentTruthCheck(config([
    '--deployment-url',
    'dashboard-current.vercel.app',
    '--timeout-ms',
    '100',
    '--interval-ms',
    '1',
  ]), {
    sleep: async () => undefined,
    execFile: async (command, args) => {
      if (args[0] === 'list') {
        return {
          stdout: JSON.stringify({ deployments: [{ url: 'dashboard-current.vercel.app', state: 'READY', target: 'production', meta: { beamDashboardVersion: '1.6.0' } }] }),
          stderr: '',
        }
      }
      if (args[0] === 'inspect' && args.includes('--logs')) {
        return { stdout: '> @beam-protocol/dashboard@1.6.0 build', stderr: '' }
      }
      if (args[0] === 'inspect') {
        inspectAttempts += 1
        return {
          stdout: inspectAttempts === 1
            ? 'Aliases\n╶ https://dashboard-alfridus1s-projects.vercel.app'
            : 'Aliases\n╶ https://dashboard.beam.directory',
          stderr: '',
        }
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.attempts, 2)
  assert.equal(result.deployment.requiredAliasPresent, true)
})
