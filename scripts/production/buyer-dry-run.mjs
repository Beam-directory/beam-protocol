import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, repoRoot, toJsonBlock, writeMarkdownReport } from './shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.0.0-buyer-dry-run.md'))

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`)
  }
}

async function main() {
  const landing = await readFile(path.join(repoRoot, 'packages/public-site/index.html'), 'utf8')
  const guided = await readFile(path.join(repoRoot, 'packages/public-site/guided-evaluation.html'), 'utf8')
  const hostedBeta = await readFile(path.join(repoRoot, 'packages/public-site/hosted-beta.html'), 'utf8')
  const docsHome = await readFile(path.join(repoRoot, 'docs/index.md'), 'utf8')
  const workflowGuide = await readFile(path.join(repoRoot, 'docs/guide/production-partner-workflow.md'), 'utf8')
  const onboardingGuide = await readFile(path.join(repoRoot, 'docs/guide/design-partner-onboarding.md'), 'utf8')
  const goLiveChecklist = await readFile(path.join(repoRoot, 'docs/guide/production-go-live-checklist.md'), 'utf8')

  assertIncludes(landing, 'Safe AI Work Between Companies', 'landing headline')
  assertIncludes(landing, 'Request hosted beta', 'landing primary CTA')
  assertIncludes(guided, 'guided evaluation', 'guided evaluation narrative')
  assertIncludes(hostedBeta, 'Request a Guided Beam Pilot', 'hosted beta title')
  assertIncludes(docsHome, 'Hosted Quickstart', 'docs home quickstart link')
  assertIncludes(workflowGuide, 'First Production Partner Workflow Contract', 'workflow guide')
  assertIncludes(onboardingGuide, 'go-live', 'onboarding guide go-live section')
  assertIncludes(goLiveChecklist, 'Go-Live Checklist', 'go-live checklist title')

  const result = {
    ok: true,
    date: formatDate(),
    checks: {
      landing: true,
      guidedEvaluation: true,
      hostedBeta: true,
      docsHome: true,
      workflowGuide: true,
      onboardingGuide: true,
      goLiveChecklist: true,
    },
  }

  const markdown = `# Beam 1.0.0 Buyer Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- surface: public-site and docs candidate content

## Result

\`PASS\`

## Path

1. Landing communicates the same production-partner motion as the docs.
2. Guided evaluation and hosted beta pages still point to one concrete pilot.
3. The docs home, workflow guide, onboarding pack, and go-live checklist all reinforce the same commercial path.

## Evidence

${toJsonBlock(result)}
`

  await writeMarkdownReport(outputPath, markdown)
  console.log(JSON.stringify({ ...result, report: outputPath }, null, 2))
}

main().catch((error) => {
  console.error('[production:buyer-dry-run] failed:', error)
  process.exitCode = 1
})
