import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import { startOpenClawFleetHarness } from './fleet-shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.2.0-operator-dry-run.md'))

async function main() {
  const fleet = await startOpenClawFleetHarness()

  try {
    const overview = await fleet.fetchFleetOverview()
    if (overview.summary.totalHosts !== 3 || overview.summary.activeHosts !== 3) {
      throw new Error(`Expected 3 approved active hosts, found ${overview.summary.activeHosts}/${overview.summary.totalHosts}`)
    }
    if (overview.summary.liveRoutes < 3) {
      throw new Error(`Expected at least 3 live fleet routes, found ${overview.summary.liveRoutes}`)
    }

    const workspaceIdentities = await fleet.fetchWorkspaceIdentities()
    if (workspaceIdentities.total !== 3) {
      throw new Error(`Expected 3 workspace identities in the fleet workspace, found ${workspaceIdentities.total}`)
    }
    if (workspaceIdentities.bindings.some((binding) => !binding.hostId || binding.hostHealth !== 'healthy' || binding.runtimeSessionState !== 'live')) {
      throw new Error('Expected all workspace fleet bindings to expose a healthy host badge and live runtime session state.')
    }

    const betaHost = await fleet.fetchHost(fleet.hosts.beta.id)
    if (betaHost.host.status !== 'active' || betaHost.host.healthStatus !== 'healthy') {
      throw new Error('Expected the selected fleet host to be active and healthy.')
    }
    if (betaHost.routes.length !== 1 || betaHost.identities.length !== 1) {
      throw new Error('Expected the selected fleet host to expose one live route and one attached identity.')
    }
    if ((betaHost.heartbeats?.length ?? 0) < 1) {
      throw new Error('Expected at least one recorded fleet heartbeat for the selected host.')
    }

    await fleet.createConflict()
    const conflictOverview = await fleet.fetchFleetOverview()
    if (conflictOverview.summary.duplicateIdentityConflicts !== 1) {
      throw new Error(`Expected 1 duplicate identity conflict, found ${conflictOverview.summary.duplicateIdentityConflicts}`)
    }

    const gammaConflict = await fleet.fetchHost(fleet.hosts.gamma.id)
    const duplicateAlphaRoute = gammaConflict.routes.find((route) => route.beamId === fleet.agents.alpha.beamId)
    if (!duplicateAlphaRoute || duplicateAlphaRoute.runtimeSessionState !== 'conflict') {
      throw new Error('Expected the duplicate alpha route to surface as a conflict on the gamma host.')
    }

    await fleet.revokeHost('gamma', 'duplicate identity conflict drill')
    const revokedOverview = await fleet.fetchFleetOverview()
    if (revokedOverview.summary.revokedHosts !== 1 || revokedOverview.summary.duplicateIdentityConflicts !== 0) {
      throw new Error('Expected revoking the gamma host to clear the conflict and mark one host revoked.')
    }

    const gammaRevoked = await fleet.fetchHost(fleet.hosts.gamma.id)
    if (gammaRevoked.host.status !== 'revoked' || gammaRevoked.host.healthStatus !== 'revoked') {
      throw new Error('Expected the gamma host to show revoked status and revoked health.')
    }

    const workspaceAfterRevoke = await fleet.fetchWorkspaceIdentities()
    const alphaBinding = workspaceAfterRevoke.bindings.find((binding) => binding.beamId === fleet.agents.alpha.beamId)
    const gammaBinding = workspaceAfterRevoke.bindings.find((binding) => binding.beamId === fleet.agents.gamma.beamId)
    if (!alphaBinding || alphaBinding.runtimeSessionState !== 'live') {
      throw new Error('Expected the alpha binding to return to a live route after the duplicate host was revoked.')
    }
    if (!gammaBinding || gammaBinding.hostHealth !== 'revoked' || gammaBinding.runtimeSessionState !== 'revoked') {
      throw new Error('Expected the revoked gamma binding to surface revoked host state in the workspace roster.')
    }

    const result = {
      ok: true,
      date: formatDate(),
      workspace: fleet.workspaceSlug,
      summary: overview.summary,
      selectedHost: {
        id: betaHost.host.id,
        label: betaHost.host.label,
        routeCount: betaHost.routes.length,
        identityCount: betaHost.identities.length,
        heartbeatCount: betaHost.heartbeats.length,
      },
      conflict: {
        total: conflictOverview.summary.duplicateIdentityConflicts,
        beamId: duplicateAlphaRoute.beamId,
        routeState: duplicateAlphaRoute.runtimeSessionState,
      },
      revoked: {
        hostId: gammaRevoked.host.id,
        status: gammaRevoked.host.status,
        healthStatus: gammaRevoked.host.healthStatus,
      },
    }

    const markdown = `# Beam 1.2.0 Operator Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local three-host OpenClaw fleet harness

## Result

\`PASS\`

## Scenario

1. Bootstrap three approved OpenClaw hosts into one central Beam control plane.
2. Verify the fleet overview, selected host detail, and workspace host badges.
3. Introduce a duplicate Beam identity on a second host and confirm the operator-visible conflict surface.
4. Revoke the conflicting host and confirm the duplicate clears while the revoked routes remain blocked and visible.

## Verification

- Approved active hosts: \`${overview.summary.activeHosts}\`
- Live routes: \`${overview.summary.liveRoutes}\`
- Selected host identities: \`${betaHost.identities.length}\`
- Duplicate conflicts after injection: \`${conflictOverview.summary.duplicateIdentityConflicts}\`
- Revoked hosts after remediation: \`${revokedOverview.summary.revokedHosts}\`
- Alpha route after revoke: \`${alphaBinding.runtimeSessionState}\`
- Gamma route after revoke: \`${gammaBinding.runtimeSessionState}\`

## Evidence

${toJsonBlock(result)}
`

    await writeMarkdownReport(outputPath, markdown)
    console.log(JSON.stringify({ ...result, report: outputPath }, null, 2))
  } finally {
    await fleet.cleanup()
  }
}

main().catch((error) => {
  console.error('[workspace:operator-dry-run] failed:', error)
  process.exitCode = 1
})
