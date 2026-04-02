import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import { startOpenClawFleetHarness } from './fleet-shared.mjs'

const outputPath = optionalFlag('--output', path.join(process.cwd(), 'reports/1.3.0-operator-dry-run.md'))

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

    await fleet.markHostStale('beta', 12)
    const staleOverview = await fleet.fetchFleetOverview()
    if (staleOverview.summary.staleHosts < 1) {
      throw new Error(`Expected at least one stale host, found ${staleOverview.summary.staleHosts}`)
    }

    const rotatedBeta = await fleet.rotateHost('beta')
    if (rotatedBeta.host.credentialState !== 'rotation_pending') {
      throw new Error(`Expected beta host to enter rotation_pending, received ${rotatedBeta.host.credentialState}`)
    }

    await fleet.createConflict()
    const digest = await fleet.fetchFleetDigest()
    if (digest.summary.staleHosts < 1 || digest.summary.pendingCredentialActions < 1 || digest.summary.duplicateIdentityConflicts < 1) {
      throw new Error('Expected the fleet digest to surface stale hosts, pending credential work, and duplicate conflicts.')
    }
    if (!digest.actionItems.some((item) => item.category === 'delivery')) {
      throw new Error('Expected the fleet digest to include a delivery follow-up item.')
    }

    await fleet.syncHost('alpha', null, { stage: 'stale-remediation' })
    await fleet.syncHost('beta', null, { stage: 'rotation-remediation' })

    const conflictOverview = await fleet.fetchFleetOverview()
    if (conflictOverview.summary.duplicateIdentityConflicts !== 1) {
      throw new Error(`Expected 1 duplicate identity conflict, found ${conflictOverview.summary.duplicateIdentityConflicts}`)
    }

    const alphaConflict = await fleet.fetchHost(fleet.hosts.alpha.id)
    const gammaConflict = await fleet.fetchHost(fleet.hosts.gamma.id)
    const preferredAlphaRoute = alphaConflict.routes.find((route) => route.beamId === fleet.agents.alpha.beamId && route.runtimeSessionState === 'conflict')
    const duplicateAlphaRoute = gammaConflict.routes.find((route) => route.beamId === fleet.agents.alpha.beamId)
    if (!preferredAlphaRoute || !duplicateAlphaRoute || duplicateAlphaRoute.runtimeSessionState !== 'conflict') {
      throw new Error('Expected the duplicate alpha route to surface as a conflict on the gamma host.')
    }

    await fleet.preferRoute(preferredAlphaRoute.id, 'Primary fleet route owner')
    const preferredOverview = await fleet.fetchFleetOverview()
    if (preferredOverview.summary.duplicateIdentityConflicts !== 0) {
      throw new Error('Expected preferring the primary route to clear duplicate conflicts.')
    }

    await fleet.disableRoute(duplicateAlphaRoute.id, 'Shadow duplicate route disabled after owner resolution')
    const gammaAfterDisable = await fleet.fetchHost(fleet.hosts.gamma.id)
    const disabledRoute = gammaAfterDisable.routes.find((route) => route.id === duplicateAlphaRoute.id)
    if (!disabledRoute || disabledRoute.ownerResolutionState !== 'disabled') {
      throw new Error('Expected the duplicate gamma route to record a disabled owner resolution state.')
    }

    await fleet.revokeHost('gamma', 'duplicate identity conflict drill')
    const gammaRevoked = await fleet.fetchHost(fleet.hosts.gamma.id)
    if (gammaRevoked.host.status !== 'revoked' || gammaRevoked.host.healthStatus !== 'revoked') {
      throw new Error('Expected the gamma host to show revoked status and revoked health.')
    }

    const recoveredGamma = await fleet.recoverHost('gamma')
    if (recoveredGamma.host.credentialState !== 'recovery_pending') {
      throw new Error(`Expected gamma host to enter recovery_pending, received ${recoveredGamma.host.credentialState}`)
    }

    await fleet.syncHost('gamma', null, { stage: 'recovery-remediation' })
    await fleet.reconnectHostClient('gamma')

    const recoveredHost = await fleet.fetchHost(fleet.hosts.gamma.id)
    if (recoveredHost.host.status !== 'active' || recoveredHost.host.healthStatus !== 'healthy' || recoveredHost.host.credentialState !== 'ready') {
      throw new Error('Expected gamma recovery to restore an active, healthy host with ready credentials.')
    }

    const workspaceAfterRecovery = await fleet.fetchWorkspaceIdentities()
    const alphaBinding = workspaceAfterRecovery.bindings.find((binding) => binding.beamId === fleet.agents.alpha.beamId)
    const betaBinding = workspaceAfterRecovery.bindings.find((binding) => binding.beamId === fleet.agents.beta.beamId)
    const gammaBinding = workspaceAfterRecovery.bindings.find((binding) => binding.beamId === fleet.agents.gamma.beamId)
    if (!alphaBinding || alphaBinding.runtimeSessionState !== 'live') {
      throw new Error('Expected the alpha binding to return to a live route after conflict resolution.')
    }
    if (!betaBinding || betaBinding.hostHealth !== 'healthy' || betaBinding.runtimeSessionState !== 'live') {
      throw new Error('Expected the beta binding to be healthy and live after credential rotation remediation.')
    }
    if (!gammaBinding || gammaBinding.hostHealth !== 'healthy' || gammaBinding.runtimeSessionState !== 'live') {
      throw new Error('Expected the gamma binding to be healthy and live after recovery.')
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
      stale: {
        staleHosts: staleOverview.summary.staleHosts,
      },
      rotated: {
        hostId: rotatedBeta.host.id,
        credentialState: rotatedBeta.host.credentialState,
      },
      digest: {
        actionItems: digest.summary.actionItems,
        criticalItems: digest.summary.criticalItems,
        pendingCredentialActions: digest.summary.pendingCredentialActions,
        duplicateIdentityConflicts: digest.summary.duplicateIdentityConflicts,
      },
      conflict: {
        total: conflictOverview.summary.duplicateIdentityConflicts,
        beamId: duplicateAlphaRoute.beamId,
        routeState: duplicateAlphaRoute.runtimeSessionState,
      },
      resolved: {
        duplicateIdentityConflicts: preferredOverview.summary.duplicateIdentityConflicts,
        disabledRouteId: disabledRoute.id,
        ownerResolutionState: disabledRoute.ownerResolutionState,
      },
      revoked: {
        hostId: gammaRevoked.host.id,
        status: gammaRevoked.host.status,
        healthStatus: gammaRevoked.host.healthStatus,
      },
      recovered: {
        hostId: recoveredHost.host.id,
        status: recoveredHost.host.status,
        healthStatus: recoveredHost.host.healthStatus,
        credentialState: recoveredHost.host.credentialState,
      },
    }

    const markdown = `# Beam 1.3.0 Operator Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local three-host OpenClaw fleet harness

## Result

\`PASS\`

## Scenario

1. Bootstrap three approved OpenClaw hosts into one central Beam control plane.
2. Verify the fleet overview, selected host detail, and workspace host badges.
3. Force one stale host, rotate one host credential, and confirm the fleet digest surfaces both conditions with next actions.
4. Introduce a duplicate Beam identity on a second host, then resolve it through explicit route-owner actions.
5. Revoke and recover the affected host and confirm the fleet returns to an active, healthy state without rebuilding workspace bindings.

## Verification

- Approved active hosts: \`${overview.summary.activeHosts}\`
- Live routes: \`${overview.summary.liveRoutes}\`
- Selected host identities: \`${betaHost.identities.length}\`
- Stale hosts before remediation: \`${staleOverview.summary.staleHosts}\`
- Pending credential actions in digest: \`${digest.summary.pendingCredentialActions}\`
- Duplicate conflicts after injection: \`${conflictOverview.summary.duplicateIdentityConflicts}\`
- Duplicate conflicts after owner resolution: \`${preferredOverview.summary.duplicateIdentityConflicts}\`
- Revoked gamma status: \`${gammaRevoked.host.status}\`
- Gamma route after recovery: \`${gammaBinding.runtimeSessionState}\`

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
