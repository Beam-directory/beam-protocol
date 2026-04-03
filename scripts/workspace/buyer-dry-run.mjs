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
  const settingsUi = await readFile(path.join(repoRoot, 'packages/dashboard/src/pages/SettingsPage.tsx'), 'utf8')
  const onboardingScript = await readFile(path.join(repoRoot, 'scripts/workspace/openclaw-onboarding.mjs'), 'utf8')
  const bootstrapScript = await readFile(path.join(repoRoot, 'scripts/workspace/beam-openclaw-host-bootstrap.sh'), 'utf8')
  const ciWorkflow = await readFile(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')

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
  assertIncludes(workspaceGuide, '`viewer`', 'viewer role guidance')
  assertIncludes(workspaceGuide, '`operator`', 'operator role guidance')
  assertIncludes(workspaceGuide, '`admin`', 'admin role guidance')
  assertIncludes(workspaceGuide, 'external webhooks', 'external webhook alerting guidance')
  assertIncludes(workspaceGuide, 'Create/update requires admin.', 'admin guard guidance')
  assertIncludes(workspaceGuide, 'Testing requires operator or admin.', 'operator guard guidance')
  assertIncludes(workspaceGuide, 'Reconciliation and garbage collection', 'reconciliation section')
  assertIncludes(workspaceGuide, 'Run fleet reconciliation', 'reconciliation action guidance')
  assertIncludes(workspaceGuide, 'gc candidate', 'garbage collection guidance')
  assertIncludes(workspaceGuide, 'npm run workspace:openclaw', 'guided onboarding command')
  assertIncludes(workspaceGuide, 'npm run workspace:openclaw-setup', 'openclaw setup command')
  assertIncludes(workspaceGuide, 'npm run workspace:openclaw-status', 'openclaw status command')
  assertIncludes(workspaceGuide, 'npm run quickstart:ui-baseline', 'visual baseline command')
  assertIncludes(workspaceGuide, 'npm run quickstart:ui-compare', 'visual regression compare command')
  assertIncludes(workspaceGuide, 'guided enrollment', 'guided enrollment docs copy')
  assertIncludes(workspaceGuide, 'copy-paste install pack', 'install pack guidance')
  assertIncludes(workspaceGuide, 'support-bundle export', 'support bundle guidance')
  assertIncludes(workspaceGuide, 'Settings page', 'settings role-management guidance')
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
  assertIncludes(fleetUi, 'Recent enrollment requests', 'fleet enrollment queue')
  assertIncludes(fleetUi, 'Open guided enrollment flow', 'guided enrollment CTA')
  assertIncludes(fleetUi, 'Download support bundle', 'support bundle action')
  assertIncludes(fleetUi, 'Fleet analytics', 'fleet analytics panel')
  assertIncludes(fleetUi, 'External alerting', 'fleet external alerting section')
  assertIncludes(fleetUi, 'Deliver warning/critical fleet items to email or webhooks', 'fleet alerting copy')
  assertIncludes(fleetUi, 'Create/update requires admin.', 'fleet admin guard copy')
  assertIncludes(fleetUi, 'Testing requires operator or admin.', 'fleet operator guard copy')
  assertIncludes(fleetUi, 'Reconciliation and garbage collection', 'fleet reconciliation surface')
  assertIncludes(fleetUi, 'Run fleet reconciliation', 'fleet reconciliation action')
  assertIncludes(fleetUi, 'Disable route', 'fleet route disable action')
  assertIncludes(fleetUi, 'Reset owner', 'fleet route owner reset action')
  assertIncludes(settingsUi, 'Operators and members', 'settings operator/member surface')
  assertIncludes(settingsUi, 'Role management', 'settings role management section')
  assertIncludes(settingsUi, 'Latest sign-in link', 'settings magic link surface')
  assertIncludes(onboardingScript, 'installing Chromium because the dashboard proof browser is not available yet', 'onboarding self-healing browser install')
  assertIncludes(onboardingScript, 'Beam OpenClaw onboarding finished.', 'onboarding completion copy')
  assertIncludes(bootstrapScript, 'BEAM_OPENCLAW_REPO_URL', 'bootstrap repo override')
  assertIncludes(bootstrapScript, 'BEAM_OPENCLAW_REF', 'bootstrap ref override')
  assertIncludes(bootstrapScript, 'openclaw-onboarding.mjs', 'bootstrap onboarding entrypoint')
  assertIncludes(ciWorkflow, 'npm run quickstart:ui-compare -- --latest', 'ui compare CI gate')
  assertIncludes(ciWorkflow, 'npm run quickstart:ui-report -- --latest --output tmp/dashboard-ui-smoke/report.md', 'ui report CI evidence')
  assertIncludes(ciWorkflow, 'quickstart-ui-smoke', 'ui smoke artifact upload')

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
      roleGuards: true,
      externalAlerting: true,
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
      packagedInstaller: true,
      guidedEnrollment: true,
      operatorOnboarding: true,
      memberManagement: true,
      supportBundleExport: true,
      fleetAnalytics: true,
      visualRegressionGate: true,
      selfHealingOnboarding: true,
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
2. The Beam Workspaces guide now explains the OpenClaw fleet model, guided host enrollment, packaged install commands, support-bundle export, role administration, and the visual-regression proof path in plain operator language.
3. The fleet surface now exposes guided enrollment links, recent enrollment requests, fleet analytics, and support-bundle export directly in the dashboard.
4. The Settings page now gives hosted-fleet operators one place for \`viewer\` / \`operator\` / \`admin\` administration and magic-link issuance.
5. The onboarding and CI paths are now adoption-friendly: one human-friendly \`workspace:openclaw\` command, self-healing Chromium install for the UI proof, committed visual baselines, CI diffing, and a readable UI report artifact.

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
