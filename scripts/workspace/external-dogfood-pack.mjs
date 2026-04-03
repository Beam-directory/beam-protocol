import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createAdminHeaders, createAdminToken, formatDate, formatDateTime, optionalFlag, repoRoot, requestJson, resolveReleaseLabel, writeMarkdownReport } from '../production/shared.mjs'

const releaseLabel = resolveReleaseLabel('1.7.0')
const directoryUrl = optionalFlag('--directory-url', process.env.BEAM_DIRECTORY_URL ?? 'http://localhost:43100')
const workspaceSlug = optionalFlag('--workspace', process.env.BEAM_WORKSPACE_SLUG ?? 'openclaw-local')
const hostLabel = optionalFlag('--host-label', process.env.BEAM_HOST_LABEL ?? 'External Dogfood Candidate')
const testerName = optionalFlag('--tester-name', process.env.BEAM_TESTER_NAME ?? 'External Tester')
const testerEmail = optionalFlag('--tester-email', process.env.BEAM_TESTER_EMAIL ?? '')
const operatorName = optionalFlag('--operator-name', process.env.BEAM_OPERATOR_NAME ?? 'Beam Operator')
const operatorEmail = optionalFlag('--operator-email', process.env.BEAM_OPERATOR_EMAIL ?? 'ops@beam.local')
const adminEmail = optionalFlag('--admin-email', process.env.BEAM_ADMIN_EMAIL ?? operatorEmail)
const explicitToken = optionalFlag('--token', process.env.BEAM_ADMIN_TOKEN ?? null)
const expiresInHours = Number.parseInt(optionalFlag('--expires-in-hours', '72'), 10)
const notes = optionalFlag('--notes', `External hosted-fleet dogfood for ${testerName}`)
const outputDir = optionalFlag('--output-dir', path.join(repoRoot, 'tmp/external-dogfood-pack'))

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'external-dogfood'
}

function isLoopback(url) {
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

async function ensureDirectoryIsReachable(url) {
  try {
    const response = await fetch(`${url}/health`)
    if (!response.ok) {
      throw new Error(`Directory health returned ${response.status}`)
    }
  } catch (error) {
    throw new Error(`Beam directory is not reachable at ${url}. Start Beam first or pass --directory-url/--token for the target control plane.`, { cause: error })
  }
}

async function resolveAdminToken() {
  if (explicitToken) {
    return explicitToken
  }
  if (isLoopback(directoryUrl)) {
    return createAdminToken(directoryUrl, adminEmail)
  }
  throw new Error('No admin token available. For non-local Beam directories, pass --token or set BEAM_ADMIN_TOKEN.')
}

async function main() {
  if (!Number.isFinite(expiresInHours) || expiresInHours < 1) {
    throw new Error(`Invalid --expires-in-hours value: ${expiresInHours}`)
  }

  await ensureDirectoryIsReachable(directoryUrl)
  const token = await resolveAdminToken()

  const enrollmentResponse = await requestJson(`${directoryUrl}/admin/openclaw/hosts/enrollment`, {
    method: 'POST',
    headers: createAdminHeaders(token),
    body: JSON.stringify({
      label: hostLabel,
      workspaceSlug,
      notes,
      expiresInHours,
    }),
  })

  const enrollment = enrollmentResponse?.enrollment
  if (!enrollment?.id || !enrollment?.token || !enrollment?.guidedEnrollmentUrl || !enrollment?.installPack) {
    throw new Error('Enrollment response did not include the expected hosted-fleet install pack.')
  }
  const fleetUrl = new URL('/openclaw-fleet', enrollment.guidedEnrollmentUrl).toString()
  const foregroundDebug = enrollment.installPack.commands.foregroundDebug ?? 'npm run workspace:openclaw-host -- status'
  const uninstallCommand = enrollment.installPack.commands.uninstall ?? 'npm run workspace:openclaw-host:uninstall'

  const fileStem = `${formatDate()}-${slugify(`${testerName}-${hostLabel}`)}`
  const packPath = path.join(outputDir, `${fileStem}.md`)
  const feedbackPath = path.join(outputDir, `${fileStem}.feedback.md`)

  await mkdir(outputDir, { recursive: true })

  const feedbackTemplate = `# Beam External Dogfood Feedback

- tester: \`${testerName}\`${testerEmail ? ` <${testerEmail}>` : ''}
- host label: \`${hostLabel}\`
- workspace: \`${workspaceSlug}\`
- date:

## 1. Install path

- Which machine/OS did you use?
- Which install command did you run?
- Did the install finish without manual fixes?

## 2. Guided enrollment

- Did the guided enrollment page make sense immediately?
- Was anything unclear during host approval or waiting for approval?
- Did the host appear in the fleet view as expected?

## 3. Runtime result

- Did the host start sending heartbeats and inventory after approval?
- Did you see anything surprising in status, routes, or health?

## 4. Supportability

- If something broke, did the support-bundle / analytics path help?
- What log, screen, or hint was missing?

## 5. One-line verdict

- What is the one thing that still makes this feel non-production?
- What is the one thing that already felt solid?
`

  const markdown = `# Beam ${releaseLabel} External Dogfood Pack

Prepared for: \`${testerName}\`${testerEmail ? ` <${testerEmail}>` : ''}

Prepared by: \`${operatorName}\`${operatorEmail ? ` <${operatorEmail}>` : ''}

Generated at: \`${formatDateTime()}\`

## Goal

Use this pack to install one external OpenClaw host into Beam through the hosted fleet adoption path, without needing repo context.

## Host install

### macOS

\`\`\`bash
${enrollment.installPack.commands.bootstrapMacos}
\`\`\`

### Linux

\`\`\`bash
${enrollment.installPack.commands.bootstrapLinux}
\`\`\`

### Guided local onboarding alternative

\`\`\`bash
${enrollment.installPack.commands.guidedOnboarding}
\`\`\`

## Enrollment

- Enrollment id: \`${enrollment.id}\`
- Expires at: \`${enrollment.expiresAt}\`
- Guided enrollment URL: ${enrollment.guidedEnrollmentUrl}
- Workspace: \`${workspaceSlug}\`
- Host label: \`${hostLabel}\`

## Operator runbook

1. Send the tester **one** install command from this document.
2. Open the guided enrollment URL and wait for the host to appear as \`pending\`.
3. Approve the host in the fleet UI once the tester confirms the install completed.
4. Verify heartbeat, route count, and health in the fleet view.
5. If something looks wrong, export a support bundle from the fleet page for that host/workspace/trace slice.
6. Ask the tester to fill in the feedback template linked below.

## Support path

- Fleet UI: \`${fleetUrl}\`
- Status command:

\`\`\`bash
${enrollment.installPack.commands.status}
\`\`\`

- Foreground debug:

\`\`\`bash
${foregroundDebug}
\`\`\`

- Uninstall:

\`\`\`bash
${uninstallCommand}
\`\`\`

## Operator checklist

${enrollment.installPack.operatorChecklist.map((item) => `- ${item}`).join('\n')}

## Feedback template

Send the tester this file after the install run:

\`${feedbackPath}\`
`

  await writeMarkdownReport(packPath, markdown)
  await writeMarkdownReport(feedbackPath, feedbackTemplate)

  console.log(JSON.stringify({
    ok: true,
    date: formatDate(),
    directoryUrl,
    workspaceSlug,
    hostLabel,
    enrollmentId: enrollment.id,
    guidedEnrollmentUrl: enrollment.guidedEnrollmentUrl,
    output: packPath,
    feedbackOutput: feedbackPath,
  }, null, 2))
}

main().catch((error) => {
  console.error('[workspace:external-dogfood-pack] failed:', error)
  process.exit(1)
})
