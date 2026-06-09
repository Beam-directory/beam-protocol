import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { repoRoot } from './shared.mjs'
import { evaluateWorkflowProductionGuards } from './workflow-production-guard-check.mjs'

const workflowRoot = path.join(repoRoot, '.github/workflows')

const dashboardWorkflow = `
VERCEL_CLI_VERSION: '54.4.1'
Fail deploy when Vercel config is missing
Dashboard deploy is not production-safe because Vercel configuration is incomplete.
npm install --global "vercel@$VERCEL_CLI_VERSION"
vercel whoami --token "$VERCEL_TOKEN"
vercel project inspect "$VERCEL_PROJECT_ID"
vercel pull --yes --environment='\${{ steps.target.outputs.pull_env }}' --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"
set -euo pipefail
--project "$VERCEL_PROJECT_ID"
--meta "beamDashboardVersion=$DASHBOARD_VERSION"
tee "$DEPLOY_OUTPUT"
node ../../scripts/production/extract-vercel-deployment-url.mjs "$DEPLOY_OUTPUT"
dashboard-deployment-truth-check.mjs
--required-alias dashboard.beam.directory
dashboard-domain-preflight.mjs
dashboard-shell-check.mjs
`

const publicSiteWorkflow = `
VERCEL_CLI_VERSION: '54.4.1'
Fail deploy when Vercel config is missing
Public-site deploy is not production-safe because Vercel configuration is incomplete.
npm install --global "vercel@$VERCEL_CLI_VERSION"
vercel whoami --token "$VERCEL_TOKEN"
vercel project inspect "$VERCEL_PROJECT_ID"
vercel pull --yes --environment=production --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"
vercel deploy --prod --yes --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"
`

const operatorCandidateWorkflow = `
VERCEL_CLI_VERSION: '54.4.1'
Fail dashboard deploy when Vercel config is missing
Operator candidate is not production-safe because Vercel dashboard configuration is incomplete.
npm install --global "vercel@$VERCEL_CLI_VERSION"
vercel whoami --token "$VERCEL_TOKEN"
vercel project inspect "$VERCEL_PROJECT_ID"
vercel pull --yes --environment='\${{ steps.dashboard_target.outputs.pull_env }}' --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"
set -euo pipefail
--project "$VERCEL_PROJECT_ID"
--meta "beamDashboardVersion=$DASHBOARD_VERSION"
tee "$DEPLOY_OUTPUT"
node ../../scripts/production/extract-vercel-deployment-url.mjs "$DEPLOY_OUTPUT"
`

function fakeReader(overrides = {}) {
  const files = {
    [path.join(workflowRoot, 'dashboard.yml')]: dashboardWorkflow,
    [path.join(workflowRoot, 'public-site.yml')]: publicSiteWorkflow,
    [path.join(workflowRoot, 'operator-candidate.yml')]: operatorCandidateWorkflow,
    ...overrides,
  }
  return async (file) => files[file]
}

test('workflow production guards pass when Vercel workflows are fail-closed and deterministic', async () => {
  const result = await evaluateWorkflowProductionGuards({ readFileImpl: fakeReader() })

  assert.equal(result.ok, true)
  assert.deepEqual(result.failures, [])
  assert.equal(result.workflows.length, 3)
})

test('workflow production guards reject skipped dashboard deploys and fragile URL parsing', async () => {
  const result = await evaluateWorkflowProductionGuards({
    readFileImpl: fakeReader({
      [path.join(workflowRoot, 'dashboard.yml')]: dashboardWorkflow
        .replace('Dashboard deploy is not production-safe because Vercel configuration is incomplete.', 'Skipping dashboard deploy')
        .replace('node ../../scripts/production/extract-vercel-deployment-url.mjs "$DEPLOY_OUTPUT"', 'tail -n1'),
    }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('dashboard: missing fail-closed missing config exit')), true)
  assert.equal(result.failures.some((failure) => failure.includes('dashboard: missing tested Vercel URL extractor')), true)
  assert.equal(result.failures.some((failure) => failure.includes('fragile Vercel URL parsing')), true)
  assert.equal(result.failures.some((failure) => failure.includes('skip-on-missing-config')), true)
})

test('workflow production guards reject implicit public-site Vercel projects', async () => {
  const result = await evaluateWorkflowProductionGuards({
    readFileImpl: fakeReader({
      [path.join(workflowRoot, 'public-site.yml')]: publicSiteWorkflow
        .replace('vercel pull --yes --environment=production --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"', 'vercel pull --yes --environment=production --token "$VERCEL_TOKEN"')
        .replace('vercel deploy --prod --yes --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"', 'vercel deploy --prod --yes --token "$VERCEL_TOKEN"'),
    }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('public-site: missing explicit project pull')), true)
  assert.equal(result.failures.some((failure) => failure.includes('public-site: missing explicit project deploy')), true)
})
