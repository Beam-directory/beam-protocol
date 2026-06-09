import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatDate, formatDateTime, repoRoot, toJsonBlock, writeMarkdownReport } from './shared.mjs'

const workflowRoot = path.join(repoRoot, '.github/workflows')

const workflowSpecs = [
  {
    name: 'dashboard',
    path: path.join(workflowRoot, 'dashboard.yml'),
    required: [
      ['pinned Vercel CLI', "VERCEL_CLI_VERSION: '54.4.1'"],
      ['fail-closed missing config step', 'Fail deploy when Vercel config is missing'],
      ['fail-closed missing config exit', 'Dashboard deploy is not production-safe because Vercel configuration is incomplete.'],
      ['pinned Vercel CLI install', 'npm install --global "vercel@$VERCEL_CLI_VERSION"'],
      ['Vercel token validation', 'vercel whoami --token "$VERCEL_TOKEN"'],
      ['dashboard project access validation', 'vercel project inspect "$VERCEL_PROJECT_ID"'],
      ['explicit project pull', 'vercel pull --yes --environment=\'${{ steps.target.outputs.pull_env }}\' --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"'],
      ['strict deploy shell', 'set -euo pipefail'],
      ['dashboard version metadata', '--meta "beamDashboardVersion=$DASHBOARD_VERSION"'],
      ['explicit project deploy args', '--project "$VERCEL_PROJECT_ID"'],
      ['captured Vercel output', 'tee "$DEPLOY_OUTPUT"'],
      ['tested Vercel URL extractor', 'node ../../scripts/production/extract-vercel-deployment-url.mjs "$DEPLOY_OUTPUT"'],
      ['production deployment truth check', 'dashboard-deployment-truth-check.mjs'],
      ['required dashboard alias check', '--required-alias dashboard.beam.directory'],
      ['production dashboard domain check', 'dashboard-domain-preflight.mjs'],
      ['production dashboard shell check', 'dashboard-shell-check.mjs'],
    ],
    forbidden: [
      ['floating Vercel CLI', 'vercel@latest'],
      ['fragile Vercel URL parsing', 'tail -n1'],
      ['skip-on-missing-config deploy', 'Skipping dashboard deploy'],
    ],
  },
  {
    name: 'public-site',
    path: path.join(workflowRoot, 'public-site.yml'),
    required: [
      ['pinned Vercel CLI', "VERCEL_CLI_VERSION: '54.4.1'"],
      ['fail-closed missing config step', 'Fail deploy when Vercel config is missing'],
      ['fail-closed missing config exit', 'Public-site deploy is not production-safe because Vercel configuration is incomplete.'],
      ['pinned Vercel CLI install', 'npm install --global "vercel@$VERCEL_CLI_VERSION"'],
      ['Vercel token validation', 'vercel whoami --token "$VERCEL_TOKEN"'],
      ['public-site project access validation', 'vercel project inspect "$VERCEL_PROJECT_ID"'],
      ['explicit project pull', 'vercel pull --yes --environment=production --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"'],
      ['explicit project deploy', 'vercel deploy --prod --yes --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"'],
    ],
    forbidden: [
      ['floating Vercel CLI', 'vercel@latest'],
      ['skip-on-missing-config deploy', 'Skipping public-site deploy'],
    ],
  },
  {
    name: 'operator-candidate',
    path: path.join(workflowRoot, 'operator-candidate.yml'),
    required: [
      ['pinned Vercel CLI', "VERCEL_CLI_VERSION: '54.4.1'"],
      ['fail-closed missing dashboard config step', 'Fail dashboard deploy when Vercel config is missing'],
      ['fail-closed missing dashboard config exit', 'Operator candidate is not production-safe because Vercel dashboard configuration is incomplete.'],
      ['pinned Vercel CLI install', 'npm install --global "vercel@$VERCEL_CLI_VERSION"'],
      ['Vercel token validation', 'vercel whoami --token "$VERCEL_TOKEN"'],
      ['dashboard project access validation', 'vercel project inspect "$VERCEL_PROJECT_ID"'],
      ['explicit project pull', 'vercel pull --yes --environment=\'${{ steps.dashboard_target.outputs.pull_env }}\' --project "$VERCEL_PROJECT_ID" --token "$VERCEL_TOKEN"'],
      ['strict deploy shell', 'set -euo pipefail'],
      ['dashboard version metadata', '--meta "beamDashboardVersion=$DASHBOARD_VERSION"'],
      ['explicit project deploy args', '--project "$VERCEL_PROJECT_ID"'],
      ['captured Vercel output', 'tee "$DEPLOY_OUTPUT"'],
      ['tested Vercel URL extractor', 'node ../../scripts/production/extract-vercel-deployment-url.mjs "$DEPLOY_OUTPUT"'],
    ],
    forbidden: [
      ['floating Vercel CLI', 'vercel@latest'],
      ['fragile Vercel URL parsing', 'tail -n1'],
    ],
  },
]

export async function evaluateWorkflowProductionGuards({ readFileImpl = readFile } = {}) {
  const workflows = []
  const failures = []

  for (const spec of workflowSpecs) {
    let text = ''
    try {
      text = await readFileImpl(spec.path, 'utf8')
    } catch (error) {
      failures.push(`${spec.name}: could not read ${spec.path}: ${error.message}`)
      workflows.push({ name: spec.name, path: spec.path, ok: false, checks: [] })
      continue
    }

    const checks = []
    for (const [label, pattern] of spec.required) {
      const ok = text.includes(pattern)
      checks.push({ label, ok, required: true })
      if (!ok) {
        failures.push(`${spec.name}: missing ${label}`)
      }
    }
    for (const [label, pattern] of spec.forbidden) {
      const ok = !text.includes(pattern)
      checks.push({ label, ok, forbidden: true })
      if (!ok) {
        failures.push(`${spec.name}: forbidden ${label} is present`)
      }
    }

    workflows.push({
      name: spec.name,
      path: spec.path,
      ok: checks.every((check) => check.ok),
      checks,
    })
  }

  return {
    ok: failures.length === 0,
    date: formatDate(),
    generatedAt: formatDateTime(),
    workflows,
    failures,
  }
}

async function main() {
  const outputIndex = process.argv.indexOf('--output')
  const outputPath = outputIndex === -1 ? null : process.argv[outputIndex + 1]
  const result = await evaluateWorkflowProductionGuards()

  if (outputPath) {
    const markdown = `# Beam Production Workflow Guard Check

## Context

- generated at: \`${formatDateTime()}\`

## Result

\`${result.ok ? 'PASS' : 'FAIL'}\`

## Failures

${result.failures.length === 0 ? '- none' : result.failures.map((failure) => `- ${failure}`).join('\n')}

## Evidence

${toJsonBlock(result)}
`
    await writeMarkdownReport(path.resolve(outputPath), markdown)
  }

  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[production:workflow-guards] failed:', error)
    process.exitCode = 1
  })
}
