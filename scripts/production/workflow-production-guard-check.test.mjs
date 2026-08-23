import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { repoRoot } from './shared.mjs'
import { evaluateWorkflowProductionGuards } from './workflow-production-guard-check.mjs'

const workflowRoot = path.join(repoRoot, '.github/workflows')

const ciWorkflow = `
permissions:
  contents: read
actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803
actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1
actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
mcp-container:
npm run container:build --workspace=@beam-protocol/mcp-server
npm run test:mcp-container-e2e
aquasec/trivy:0.70.0@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e
--scanners vuln
--severity HIGH,CRITICAL
--exit-code 1
--format cyclonedx
sha256sum tmp/mcp-release-candidate/*
mcp-pilot-evidence:
Tag version $VERSION does not match package.json version $PACKAGE_VERSION
MCP pilot release must be a safe semantic version
EVIDENCE="reports/\${VERSION}-mcp-pilot-evidence.json"
npm run production:mcp-pilot
needs: [monorepo, e2e, docs, quickstart, mcp-container, mcp-pilot-evidence]
`

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
    [path.join(workflowRoot, 'ci.yml')]: ciWorkflow,
    [path.join(workflowRoot, 'dashboard.yml')]: dashboardWorkflow,
    [path.join(workflowRoot, 'public-site.yml')]: publicSiteWorkflow,
    [path.join(workflowRoot, 'operator-candidate.yml')]: operatorCandidateWorkflow,
    ...overrides,
  }
  return async (file) => files[file]
}

test('workflow production guards pass when release and Vercel workflows are fail-closed and deterministic', async () => {
  const result = await evaluateWorkflowProductionGuards({ readFileImpl: fakeReader() })

  assert.equal(result.ok, true)
  assert.deepEqual(result.failures, [])
  assert.equal(result.workflows.length, 4)
})

test('workflow production guards reject a floating or weakened MCP release gate', async () => {
  const result = await evaluateWorkflowProductionGuards({
    readFileImpl: fakeReader({
      [path.join(workflowRoot, 'ci.yml')]: ciWorkflow
        .replace('actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803', 'actions/checkout@v6')
        .replace('--exit-code 1', '--ignore-unfixed'),
    }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.failures.some((failure) => failure.includes('ci: missing pinned checkout action')), true)
  assert.equal(result.failures.some((failure) => failure.includes('floating checkout action')), true)
  assert.equal(result.failures.some((failure) => failure.includes('ci: missing fail-on-findings scan')), true)
  assert.equal(result.failures.some((failure) => failure.includes('ignored unfixed vulnerabilities')), true)
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
