import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, repoRoot, resolveReleaseLabel, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'

const releaseLabel = resolveReleaseLabel()
const outputPath = optionalFlag('--output', path.join(process.cwd(), `reports/${releaseLabel}-buyer-dry-run.md`))

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`Missing ${label}: ${needle}`)
  }
}

async function main() {
  const docsHome = await readFile(path.join(repoRoot, 'docs/index.md'), 'utf8')
  const workspaceGuide = await readFile(path.join(repoRoot, 'docs/guide/beam-workspaces.md'), 'utf8')
  const workspaceUi = await readFile(path.join(repoRoot, 'packages/dashboard/src/pages/WorkspacesPage.tsx'), 'utf8')
  const fleetUi = await readFile(path.join(repoRoot, 'packages/dashboard/src/pages/OpenClawFleetPage.tsx'), 'utf8')

  assertIncludes(docsHome, 'Beam Workspaces', 'docs home workspace entry')
  assertIncludes(docsHome, 'Beam Workspaces guide', 'docs home workspace guide link')
  assertIncludes(workspaceGuide, 'workspace_partner_channels', 'workspace guide partner channel model')
  assertIncludes(workspaceGuide, '`GET /admin/workspaces/:slug/partner-channels`', 'partner channel route')
  assertIncludes(workspaceGuide, '`GET /admin/workspaces/:slug/timeline`', 'timeline route')
  assertIncludes(workspaceGuide, '`GET /admin/workspaces/:slug/digest`', 'digest route')
  assertIncludes(workspaceGuide, 'OpenClaw Fleet', 'OpenClaw fleet guide section')
  assertIncludes(workspaceGuide, 'manual host approval', 'host approval guidance')
  assertIncludes(workspaceGuide, 'rotate host credentials without reinstalling the whole host', 'host credential lifecycle guidance')
  assertIncludes(workspaceGuide, 'managed Linux install command', 'linux install guidance')
  assertIncludes(workspaceGuide, 'fleet digest', 'fleet digest guidance')
  assertIncludes(workspaceGuide, 'Reconciliation and garbage collection', 'reconciliation section')
  assertIncludes(workspaceGuide, 'Run fleet reconciliation', 'reconciliation action guidance')
  assertIncludes(workspaceGuide, 'gc candidate', 'garbage collection guidance')
  assertIncludes(workspaceGuide, 'npm run workspace:openclaw-setup', 'openclaw setup command')
  assertIncludes(workspaceGuide, 'npm run workspace:openclaw-status', 'openclaw status command')
  assertIncludes(workspaceUi, 'Partner channels', 'workspace UI partner channels section')
  assertIncludes(workspaceUi, 'Workspace digest', 'workspace UI digest section')
  assertIncludes(workspaceUi, 'Workspace timeline', 'workspace UI timeline section')
  assertIncludes(workspaceUi, 'Thread composer', 'workspace UI composer section')
  assertIncludes(workspaceUi, 'Host health', 'workspace host health badges')
  assertIncludes(fleetUi, 'Approve host', 'fleet approval action')
  assertIncludes(fleetUi, 'Duplicate identity conflicts', 'fleet conflict surface')
  assertIncludes(fleetUi, 'Selected host', 'fleet host detail surface')
  assertIncludes(fleetUi, 'Rotate credential', 'fleet credential rotation action')
  assertIncludes(fleetUi, 'Recover host', 'fleet credential recovery action')
  assertIncludes(fleetUi, 'Fleet operator digest', 'fleet digest surface')
  assertIncludes(fleetUi, 'Reconciliation and garbage collection', 'fleet reconciliation surface')
  assertIncludes(fleetUi, 'Run fleet reconciliation', 'fleet reconciliation action')
  assertIncludes(fleetUi, 'Disable route', 'fleet route disable action')
  assertIncludes(fleetUi, 'Reset owner', 'fleet route owner reset action')

  const result = {
    ok: true,
    date: formatDate(),
    checks: {
      docsHome: true,
      workspaceGuide: true,
      dashboardSurface: true,
      openClawFleetSurface: true,
      manualHostApproval: true,
      credentialLifecycle: true,
      linuxInstallPath: true,
      hostStatusCommands: true,
      reconciliationGuide: true,
      partnerChannels: true,
      timeline: true,
      digest: true,
      threadComposer: true,
      hostBadges: true,
      reconciliationSurface: true,
      routeOwnerActions: true,
    },
  }

  const markdown = `# Beam ${releaseLabel} Buyer Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- surface: OpenClaw fleet docs and operator-facing control-plane copy

## Result

\`PASS\`

## Path

1. The docs home still points operators to Beam Workspaces as the identity and control-plane layer.
2. The Beam Workspaces guide now explains the OpenClaw fleet model, host approval, credential rotation and recovery, Linux install parity, and fleet digest commands in plain operator language.
3. The dashboard surface vocabulary matches the guide: host approval, host detail, duplicate identity conflicts, host badges, partner channels, timeline, digest, route-owner actions, reconciliation, and thread composer.

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
