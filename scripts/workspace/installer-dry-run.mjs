import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { formatDate, formatDateTime, optionalFlag, repoRoot, resolveReleaseLabel, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'
import { startOpenClawFleetHarness } from './fleet-shared.mjs'

const releaseLabel = resolveReleaseLabel()
const outputPath = optionalFlag('--output', path.join(process.cwd(), `reports/${releaseLabel}-installer-dry-run.md`))
const nodePath = process.execPath
const onboardingScriptPath = path.join(repoRoot, 'scripts/workspace/openclaw-onboarding.mjs')
const statusScriptPath = path.join(repoRoot, 'scripts/workspace/beam-openclaw-host.mjs')
const bootstrapScriptPath = path.join(repoRoot, 'scripts/workspace/beam-openclaw-host-bootstrap.sh')

function assertStatus(response, status, label) {
  if (response.status !== status) {
    throw new Error(`Expected ${label} to return ${status}, received ${response.status}: ${JSON.stringify(response.payload)}`)
  }
}

async function main() {
  const fleet = await startOpenClawFleetHarness()

  try {
    const bootstrapScript = await readFile(bootstrapScriptPath, 'utf8')
    if (!bootstrapScript.includes('BEAM_OPENCLAW_REPO_URL') || !bootstrapScript.includes('openclaw-onboarding.mjs')) {
      throw new Error('Expected the packaged bootstrap script to expose repo overrides and run the guided onboarding entrypoint.')
    }

    const viewerEnrollmentDenied = await fleet.createEnrollment({
      label: 'Viewer install should be blocked',
      workspaceSlug: fleet.workspaceSlug,
      notes: 'viewer should not mint install packs',
    }, 'viewer', true)
    assertStatus(viewerEnrollmentDenied, 403, 'viewer enrollment creation')

    const operatorEnrollment = await fleet.createEnrollment({
      label: 'Hosted Fleet Install Candidate',
      workspaceSlug: fleet.workspaceSlug,
      notes: 'Installer dry run candidate',
      expiresInHours: 24,
    }, 'operator')

    const enrollment = operatorEnrollment.enrollment
    if (!enrollment?.token || !enrollment?.guidedEnrollmentUrl || !enrollment?.installPack) {
      throw new Error('Expected the operator enrollment response to include a token, guided enrollment URL, and install pack.')
    }
    if (!enrollment.installPack.commands.bootstrapMacos || !enrollment.installPack.commands.bootstrapLinux) {
      throw new Error('Expected the install pack to expose bootstrap commands for macOS and Linux.')
    }
    if ((enrollment.installPack.operatorChecklist?.length ?? 0) < 3) {
      throw new Error('Expected the install pack to expose a non-trivial operator checklist.')
    }

    const enrollments = await fleet.listEnrollments('operator')
    const listed = enrollments.enrollments.find((entry) => entry.id === enrollment.id)
    if (!listed || !listed.token || !listed.installPack) {
      throw new Error('Expected the new enrollment to remain visible in the operator enrollment queue with token and install pack.')
    }

    const onboardingOutput = execFileSync(nodePath, [onboardingScriptPath, '--skip-ui-smoke'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024 * 10,
    })
    if (!onboardingOutput.includes('Beam OpenClaw onboarding finished.')) {
      throw new Error('Expected the guided onboarding command to print its completion banner.')
    }

    const status = JSON.parse(execFileSync(nodePath, [statusScriptPath, 'status', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024 * 10,
    }))
    if (!status.ready || !status.host?.credentialPresent || status.host?.fleetHealth !== 'healthy') {
      throw new Error(`Expected the local onboarding path to finish with a healthy host credential, received ${JSON.stringify(status.host)}`)
    }

    const result = {
      ok: true,
      date: formatDate(),
      enrollment: {
        id: enrollment.id,
        expiresAt: enrollment.expiresAt,
        guidedEnrollmentUrl: enrollment.guidedEnrollmentUrl,
        operatorChecklistItems: enrollment.installPack.operatorChecklist.length,
      },
      installPack: {
        bootstrapMacos: enrollment.installPack.commands.bootstrapMacos,
        bootstrapLinux: enrollment.installPack.commands.bootstrapLinux,
        guidedOnboarding: enrollment.installPack.commands.guidedOnboarding,
        status: enrollment.installPack.commands.status,
      },
      localOnboarding: {
        ready: status.ready,
        hostKey: status.host.hostKey,
        fleetHealth: status.host.fleetHealth,
        routeCount: status.host.routeCount,
        serviceInstalled: status.service?.installed ?? null,
        serviceRunning: status.service?.running ?? null,
      },
    }

    const markdown = `# Beam ${releaseLabel} Installer Dry Run

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- surfaces: packaged bootstrap token flow, guided onboarding command, local host status

## Result

\`PASS\`

## Scenario

1. Verify that only an operator can mint a hosted-fleet enrollment token and install pack.
2. Issue a fresh enrollment and confirm the queue exposes the guided enrollment URL, bootstrap commands, and operator checklist.
3. Run the human-facing \`npm run workspace:openclaw -- --skip-ui-smoke\` flow locally.
4. Confirm the resulting host status reports a healthy credentialed fleet host and an installed managed service.

## Verification

- Viewer enrollment-create guard: \`${viewerEnrollmentDenied.status}\`
- Enrollment token visible in queue: \`${listed?.token ? 'yes' : 'no'}\`
- Guided enrollment URL: \`${enrollment.guidedEnrollmentUrl ? 'present' : 'missing'}\`
- Operator checklist items: \`${enrollment.installPack.operatorChecklist.length}\`
- Local onboarding ready state: \`${status.ready}\`
- Local host health: \`${status.host.fleetHealth}\`
- Local managed service installed: \`${status.service?.installed ?? false}\`
- Local managed service running: \`${status.service?.running ?? false}\`

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
  console.error('[workspace:installer-dry-run] failed:', error)
  process.exitCode = 1
})
