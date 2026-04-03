import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, resolveReleaseLabel, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import { startWebhookCapture } from './fleet-evidence-shared.mjs'
import { startOpenClawFleetHarness } from './fleet-shared.mjs'

const releaseLabel = resolveReleaseLabel()
const outputPath = optionalFlag('--output', path.join(process.cwd(), `reports/${releaseLabel}-operator-dry-run.md`))

function assertStatus(response, status, label) {
  if (response.status !== status) {
    throw new Error(`Expected ${label} to return ${status}, received ${response.status}: ${JSON.stringify(response.payload)}`)
  }
}

async function main() {
  const fleet = await startOpenClawFleetHarness()
  const alertWebhook = await startWebhookCapture()

  try {
    const overview = await fleet.fetchFleetOverview()
    if (overview.summary.totalHosts !== 3 || overview.summary.activeHosts !== 3) {
      throw new Error(`Expected 3 approved active hosts, found ${overview.summary.activeHosts}/${overview.summary.totalHosts}`)
    }
    if (overview.summary.liveRoutes < 3) {
      throw new Error(`Expected at least 3 live fleet routes, found ${overview.summary.liveRoutes}`)
    }

    const viewerOverview = await fleet.fetchFleetOverview('viewer')
    if (viewerOverview.summary.totalHosts !== 3) {
      throw new Error('Expected the viewer session to read the fleet overview.')
    }
    const viewerRoles = await fleet.listRoles('viewer')
    if (!Array.isArray(viewerRoles.roles)) {
      throw new Error('Expected the viewer role to inspect the directory role list.')
    }

    const viewerAssignDenied = await fleet.assignRole('viewer-blocked@example.com', 'viewer', 'viewer', true)
    assertStatus(viewerAssignDenied, 403, 'viewer role assignment')

    const operatorAssignDenied = await fleet.assignRole('operator-blocked@example.com', 'viewer', 'operator', true)
    assertStatus(operatorAssignDenied, 403, 'operator role assignment')

    await fleet.assignRole('second-operator@example.com', 'operator')
    const rolesAfterAssign = await fleet.listRoles('viewer')
    if (!rolesAfterAssign.roles.some((assignment) => assignment.email === 'second-operator@example.com' && assignment.role === 'operator')) {
      throw new Error('Expected the new operator assignment to become visible in the shared role list.')
    }
    await fleet.revokeRole('second-operator@example.com')
    const rolesAfterRevoke = await fleet.listRoles('viewer')
    if (rolesAfterRevoke.roles.some((assignment) => assignment.email === 'second-operator@example.com')) {
      throw new Error('Expected the operator assignment to disappear after revocation.')
    }

    const analytics = await fleet.fetchFleetAnalytics('viewer')
    if (analytics.summary.totalHosts !== 3 || analytics.hostPosture.length < 1 || analytics.routeChurn.length < 1) {
      throw new Error('Expected fleet analytics to expose host totals, host posture, and route churn history.')
    }

    const viewerEnrollmentDenied = await fleet.createEnrollment({
      label: 'Viewer enrollment should fail',
      workspaceSlug: fleet.workspaceSlug,
      notes: 'viewer should not mint install packs',
    }, 'viewer', true)
    assertStatus(viewerEnrollmentDenied, 403, 'viewer enrollment creation')

    const enrollment = await fleet.createEnrollment({
      label: 'Operator onboarding candidate',
      workspaceSlug: fleet.workspaceSlug,
      notes: 'Operator dry run enrollment request',
      expiresInHours: 24,
    }, 'operator')
    if (!enrollment.enrollment?.guidedEnrollmentUrl || !enrollment.enrollment?.installPack?.commands.bootstrapMacos) {
      throw new Error('Expected operator enrollment creation to return a guided enrollment URL and bootstrap commands.')
    }
    const enrollments = await fleet.listEnrollments('operator')
    if (!enrollments.enrollments.some((entry) => entry.id === enrollment.enrollment.id && entry.token)) {
      throw new Error('Expected the operator enrollment queue to list the new install-pack token.')
    }

    const viewerSupportBundleDenied = await fleet.fetchFleetSupportBundle({
      hostId: fleet.hosts.alpha.id,
      workspaceSlug: fleet.workspaceSlug,
      hours: 12,
    }, 'viewer', true)
    assertStatus(viewerSupportBundleDenied, 403, 'viewer support-bundle export')

    const supportBundle = await fleet.fetchFleetSupportBundle({
      hostId: fleet.hosts.alpha.id,
      workspaceSlug: fleet.workspaceSlug,
      hours: 12,
    }, 'operator')
    if (!supportBundle.payload?.host?.host || !supportBundle.payload?.workspace || !supportBundle.payload?.digest) {
      throw new Error('Expected the support bundle export to include host, workspace, and digest context.')
    }

    const viewerCreateAlertDenied = await fleet.createFleetAlertTarget({
      label: 'Viewer should not create this',
      deliveryKind: 'webhook',
      destination: alertWebhook.url,
      severityThreshold: 'warning',
    }, 'viewer', true)
    assertStatus(viewerCreateAlertDenied, 403, 'viewer alert-target creation')

    const operatorCreateAlertDenied = await fleet.createFleetAlertTarget({
      label: 'Operator should not create this',
      deliveryKind: 'webhook',
      destination: alertWebhook.url,
      severityThreshold: 'warning',
    }, 'operator', true)
    assertStatus(operatorCreateAlertDenied, 403, 'operator alert-target creation')

    const alertTarget = await fleet.createFleetAlertTarget({
      label: 'Operator drill webhook',
      deliveryKind: 'webhook',
      destination: alertWebhook.url,
      severityThreshold: 'warning',
      notes: 'Operator drill webhook target',
      headers: {
        'x-beam-alert-source': 'operator-dry-run',
      },
    })

    const viewerAlerts = await fleet.fetchFleetAlerts('viewer')
    if (viewerAlerts.targets.length < 1) {
      throw new Error('Expected the viewer role to list at least one fleet alert target.')
    }

    const viewerDigestDenied = await fleet.requestRole('/admin/openclaw/fleet/digest/schedule', {
      role: 'viewer',
      method: 'PATCH',
      body: {
        enabled: true,
      },
      allowError: true,
    })
    assertStatus(viewerDigestDenied, 403, 'viewer digest schedule update')

    const now = new Date()
    const digestSchedule = await fleet.updateFleetDigestSchedule({
      enabled: true,
      deliveryEmail: 'ops@example.com',
      escalationEmail: 'critical@example.com',
      runHourUtc: now.getUTCHours(),
      runMinuteUtc: now.getUTCMinutes(),
      escalateOnCritical: true,
    }, 'operator')
    if (!digestSchedule.schedule.enabled) {
      throw new Error('Expected the operator role to enable the fleet digest schedule.')
    }

    const testAlert = await fleet.testFleetAlertTarget(alertTarget.target.id, 'operator')
    if (!testAlert.ok || testAlert.status !== 'delivered') {
      throw new Error(`Expected operator alert-target test delivery to succeed, received ${JSON.stringify(testAlert)}`)
    }
    const [testAlertEvent] = await alertWebhook.waitForCount(1)
    if (testAlertEvent.body?.test !== true) {
      throw new Error('Expected the first captured webhook alert to be a test delivery.')
    }

    const operatorRotateDenied = await fleet.rotateHost('beta', 'operator', true)
    assertStatus(operatorRotateDenied, 403, 'operator credential rotation')

    const workspaceIdentities = await fleet.fetchWorkspaceIdentities()
    if (workspaceIdentities.total !== 3) {
      throw new Error(`Expected 3 workspace identities in the fleet workspace, found ${workspaceIdentities.total}`)
    }
    if (workspaceIdentities.bindings.some((binding) => !binding.hostId || binding.hostHealth !== 'healthy' || binding.runtimeSessionState !== 'live')) {
      throw new Error('Expected all workspace fleet bindings to expose a healthy host badge and live runtime session state.')
    }

    const rolloutUpdate = await fleet.updateRollout('alpha', {
      ring: 'canary',
      desiredConnectorVersion: '1.6.0-test',
      notes: 'Operator dry run canary ring',
    })
    if (rolloutUpdate.host.rollout.ring !== 'canary') {
      throw new Error(`Expected alpha rollout ring canary, received ${rolloutUpdate.host.rollout.ring}`)
    }
    const rolloutOverview = await fleet.fetchFleetOverview()
    if (rolloutOverview.rollout.summary.canaryHosts < 1) {
      throw new Error('Expected at least one canary host after rollout update.')
    }

    const maintenanceUpdate = await fleet.enableMaintenance('alpha', {
      owner: 'ops@example.com',
      reason: 'maintenance drill',
    })
    if (maintenanceUpdate.host.maintenance.state !== 'maintenance') {
      throw new Error(`Expected alpha host to enter maintenance, received ${maintenanceUpdate.host.maintenance.state}`)
    }
    const maintenanceOverview = await fleet.fetchFleetOverview()
    if (maintenanceOverview.maintenance.counts.blocked < 1) {
      throw new Error('Expected maintenance mode to block at least one host in the fleet overview.')
    }
    await fleet.resumeHost('alpha')
    const resumedAlpha = await fleet.fetchHost(fleet.hosts.alpha.id)
    if (resumedAlpha.host.maintenance.state !== 'serving') {
      throw new Error(`Expected alpha host to resume serving, received ${resumedAlpha.host.maintenance.state}`)
    }

    await fleet.markHostStale('gamma', 45, { ageRoutes: true })
    const reconciliationBefore = await fleet.fetchFleetReconciliation()
    if (reconciliationBefore.summary.driftedHosts < 1 || reconciliationBefore.summary.garbageCollectableRoutes < 1) {
      throw new Error('Expected reconciliation to surface at least one drifted host and garbage-collectable route.')
    }
    const reconciliationRun = await fleet.runFleetReconciliation({
      hostId: fleet.hosts.gamma.id,
      staleGraceMinutes: 0,
      orphanedGraceMinutes: 0,
      note: 'Operator dry run reconciliation',
    })
    if (reconciliationRun.deletedCount < 1) {
      throw new Error('Expected reconciliation to delete at least one garbage-collectable route.')
    }
    await fleet.syncHost('gamma', null, { stage: 'reconciliation-remediation' })
    await fleet.reconnectHostClient('gamma')

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

    const digestRun = await fleet.runFleetDigest({
      triggerKind: 'manual',
      deliver: true,
    }, 'operator')
    if (!digestRun.run || digestRun.run.deliveryState === 'skipped') {
      throw new Error('Expected the operator-triggered digest run to persist delivery evidence.')
    }
    const alertEvents = await alertWebhook.waitForCount(2)
    const liveAlertEvent = alertEvents.at(-1)
    if (!liveAlertEvent?.body || liveAlertEvent.body.test === true) {
      throw new Error('Expected the second captured webhook event to be a live fleet alert delivery.')
    }
    if ((liveAlertEvent.body.matchingItems?.length ?? 0) < 1) {
      throw new Error('Expected the live fleet alert payload to include at least one matching action item.')
    }
    const alertsAfterDigest = await fleet.fetchFleetAlerts('viewer')
    if (alertsAfterDigest.deliveries.length < 2) {
      throw new Error('Expected persisted fleet alert delivery history after the test and live alert fanout.')
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
      rbac: {
        viewerOverviewRole: 'viewer',
        viewerRoleAssignStatus: viewerAssignDenied.status,
        operatorRoleAssignStatus: operatorAssignDenied.status,
        viewerAlertCreateStatus: viewerCreateAlertDenied.status,
        operatorAlertCreateStatus: operatorCreateAlertDenied.status,
        viewerDigestScheduleStatus: viewerDigestDenied.status,
        operatorRotateStatus: operatorRotateDenied.status,
      },
      operatorAdministration: {
        visibleRoles: viewerRoles.roles.length,
        assignedRoleEmail: 'second-operator@example.com',
        rolesAfterAssign: rolesAfterAssign.roles.length,
        rolesAfterRevoke: rolesAfterRevoke.roles.length,
      },
      enrollment: {
        id: enrollment.enrollment.id,
        queueSize: enrollments.total,
        guidedEnrollmentUrl: Boolean(enrollment.enrollment.guidedEnrollmentUrl),
        bootstrapMacos: Boolean(enrollment.enrollment.installPack?.commands.bootstrapMacos),
      },
      analytics: {
        totalHosts: analytics.summary.totalHosts,
        staleHosts: analytics.summary.staleHosts,
        duplicateIdentityConflicts: analytics.summary.duplicateIdentityConflicts,
        hostPostureRows: analytics.hostPosture.length,
        routeChurnRows: analytics.routeChurn.length,
      },
      supportBundle: {
        filename: supportBundle.filename,
        hostLabel: supportBundle.payload.host.host.label,
        workspaceSlug: supportBundle.payload.workspace.workspace.slug,
        digestActionItems: supportBundle.payload.digest.summary.actionItems,
      },
      alerting: {
        targetId: alertTarget.target.id,
        testStatus: testAlert.status,
        webhookEvents: alertEvents.length,
        liveMatchingItems: liveAlertEvent.body.matchingItems.length,
        persistedDeliveries: alertsAfterDigest.deliveries.length,
      },
      selectedHost: {
        id: betaHost.host.id,
        label: betaHost.host.label,
        routeCount: betaHost.routes.length,
        identityCount: betaHost.identities.length,
        heartbeatCount: betaHost.heartbeats.length,
      },
      rollout: {
        hostId: rolloutUpdate.host.id,
        ring: rolloutUpdate.host.rollout.ring,
        desiredConnectorVersion: rolloutUpdate.host.rollout.desiredConnectorVersion,
        canaryHosts: rolloutOverview.rollout.summary.canaryHosts,
      },
      maintenance: {
        hostId: maintenanceUpdate.host.id,
        state: maintenanceUpdate.host.maintenance.state,
        blockedHosts: maintenanceOverview.maintenance.counts.blocked,
        resumedState: resumedAlpha.host.maintenance.state,
      },
      reconciliation: {
        driftedHosts: reconciliationBefore.summary.driftedHosts,
        garbageCollectableRoutes: reconciliationBefore.summary.garbageCollectableRoutes,
        deletedCount: reconciliationRun.deletedCount,
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
        deliveryState: digestRun.run.deliveryState,
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

    const markdown = `# Beam ${releaseLabel} Operator Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: local three-host OpenClaw fleet harness

## Result

\`PASS\`

## Scenario

1. Bootstrap three approved OpenClaw hosts into one central Beam control plane.
2. Verify the fleet overview, selected host detail, and workspace host badges.
3. Prove hosted-fleet operator administration: viewers can inspect roles, only admins can change them, and operator onboarding can issue install-pack enrollments without exposing admin-only mutation paths.
4. Verify the new fleet analytics and support-bundle export surfaces, including the operator-only export guard.
5. Create and test one external webhook alert target, then drive a live digest fanout through it.
6. Put one host into a canary rollout ring and another into maintenance mode, then resume it cleanly.
7. Force reconciliation drift on a subagent route, run reconciliation, and confirm garbage collection removes the stale historical state.
8. Force one stale host, rotate one host credential, and confirm the fleet digest surfaces both conditions with next actions.
9. Introduce a duplicate Beam identity on a second host, then resolve it through explicit route-owner actions.
10. Revoke and recover the affected host and confirm the fleet returns to an active, healthy state without rebuilding workspace bindings.

## Verification

- Approved active hosts: \`${overview.summary.activeHosts}\`
- Live routes: \`${overview.summary.liveRoutes}\`
- Viewer role-list access: \`${viewerRoles.roles.length}\`
- Viewer role-assign guard: \`${viewerAssignDenied.status}\`
- Operator role-assign guard: \`${operatorAssignDenied.status}\`
- Operator enrollment queue size: \`${enrollments.total}\`
- Guided enrollment URL returned: \`${Boolean(enrollment.enrollment.guidedEnrollmentUrl)}\`
- Viewer support-bundle guard: \`${viewerSupportBundleDenied.status}\`
- Support-bundle workspace slug: \`${supportBundle.payload.workspace.workspace.slug}\`
- Analytics host-posture rows: \`${analytics.hostPosture.length}\`
- Analytics route-churn rows: \`${analytics.routeChurn.length}\`
- Viewer alert-create guard: \`${viewerCreateAlertDenied.status}\`
- Operator alert-create guard: \`${operatorCreateAlertDenied.status}\`
- Viewer digest-schedule guard: \`${viewerDigestDenied.status}\`
- Operator rotate guard: \`${operatorRotateDenied.status}\`
- Webhook alert deliveries captured: \`${alertEvents.length}\`
- Selected host identities: \`${betaHost.identities.length}\`
- Canary hosts after rollout update: \`${rolloutOverview.rollout.summary.canaryHosts}\`
- Maintenance-blocked hosts: \`${maintenanceOverview.maintenance.counts.blocked}\`
- Garbage-collectable routes before reconciliation: \`${reconciliationBefore.summary.garbageCollectableRoutes}\`
- Deleted routes during reconciliation: \`${reconciliationRun.deletedCount}\`
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
    await alertWebhook.close()
    await fleet.cleanup()
  }
}

main().catch((error) => {
  console.error('[workspace:operator-dry-run] failed:', error)
  process.exitCode = 1
})
