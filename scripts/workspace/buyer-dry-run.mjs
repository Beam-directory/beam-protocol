import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, repoRoot, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.1.0-buyer-dry-run.md'))

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`)
  }
}

async function main() {
  const docsHome = await readFile(path.join(repoRoot, 'docs/index.md'), 'utf8')
  const workspaceGuide = await readFile(path.join(repoRoot, 'docs/guide/beam-workspaces.md'), 'utf8')
  const workspaceUi = await readFile(path.join(repoRoot, 'packages/dashboard/src/pages/WorkspacesPage.tsx'), 'utf8')

  assertIncludes(docsHome, 'Beam Workspaces', 'docs home workspace entry')
  assertIncludes(workspaceGuide, 'workspace_partner_channels', 'workspace guide partner channel model')
  assertIncludes(workspaceGuide, '`GET /admin/workspaces/:slug/partner-channels`', 'partner channel route')
  assertIncludes(workspaceGuide, '`GET /admin/workspaces/:slug/timeline`', 'timeline route')
  assertIncludes(workspaceGuide, '`GET /admin/workspaces/:slug/digest`', 'digest route')
  assertIncludes(workspaceGuide, 'blocked handoff draft', 'blocked handoff guidance')
  assertIncludes(workspaceUi, 'Partner channels', 'workspace UI partner channels section')
  assertIncludes(workspaceUi, 'Workspace digest', 'workspace UI digest section')
  assertIncludes(workspaceUi, 'Workspace timeline', 'workspace UI timeline section')
  assertIncludes(workspaceUi, 'Thread composer', 'workspace UI composer section')

  const result = {
    ok: true,
    date: formatDate(),
    checks: {
      docsHome: true,
      workspaceGuide: true,
      dashboardSurface: true,
      partnerChannels: true,
      timeline: true,
      digest: true,
      threadComposer: true,
    },
  }

  const markdown = `# Beam 1.1.0 Buyer Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- surface: workspace docs and operator-facing product copy

## Result

\`PASS\`

## Path

1. The docs home still points operators to Beam Workspaces from the main control-plane narrative.
2. The Beam Workspaces guide describes the new control-plane model beyond simple identity bindings.
3. The operator surface vocabulary matches the guide: partner channels, timeline, digest, and thread composer.

## Evidence

${toJsonBlock(result)}
`

  await writeMarkdownReport(outputPath, markdown)
  console.log(JSON.stringify({ ...result, report: outputPath }, null, 2))
}

main().catch((error) => {
  console.error('[workspace:buyer-dry-run] failed:', error)
  process.exitCode = 1
})
