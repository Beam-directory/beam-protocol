import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formatDate, formatDateTime, optionalFlag, repoRoot, resolveReleaseLabel, toJsonBlock, writeMarkdownReport } from '../production/shared.mjs'

const releaseLabel = resolveReleaseLabel()
const outputPath = optionalFlag('--output', path.join(process.cwd(), `reports/${releaseLabel}-linux-fleet-smoke.md`))
const installerPath = path.join(repoRoot, 'scripts/workspace/install-openclaw-host-agent.mjs')
const nodePath = process.execPath

function run(command, args, { env, cwd = repoRoot, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
  })
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
  }
  return result
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function createFakeSystemctl(scriptPath, stateFile) {
  const script = `#!/bin/sh
STATE_FILE="${stateFile}"
CMD="$1"
shift
if [ "$CMD" = "--user" ]; then
  CMD="$1"
  shift
fi

ENABLED=0
ACTIVE=0
if [ -f "$STATE_FILE" ]; then
  . "$STATE_FILE"
fi

write_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  printf 'ENABLED=%s\nACTIVE=%s\n' "$ENABLED" "$ACTIVE" > "$STATE_FILE"
}

case "$CMD" in
  daemon-reload)
    exit 0
    ;;
  enable)
    ENABLED=1
    ACTIVE=1
    write_state
    exit 0
    ;;
  disable)
    ENABLED=0
    ACTIVE=0
    write_state
    exit 0
    ;;
  reset-failed)
    exit 0
    ;;
  is-active)
    if [ "$1" = "--quiet" ]; then
      shift
    fi
    if [ "$ACTIVE" = "1" ]; then
      exit 0
    fi
    exit 3
    ;;
  is-enabled)
    if [ "$ENABLED" = "1" ]; then
      printf 'enabled\n'
      exit 0
    fi
    printf 'disabled\n'
    exit 1
    ;;
  show)
    if [ "$ACTIVE" = "1" ]; then
      ACTIVE_STATE="active"
      SUB_STATE="running"
    else
      ACTIVE_STATE="inactive"
      SUB_STATE="dead"
    fi
    if [ "$ENABLED" = "1" ]; then
      UNIT_FILE_STATE="enabled"
    else
      UNIT_FILE_STATE="disabled"
    fi
    printf 'ActiveState=%s\nSubState=%s\nUnitFileState=%s\n' "$ACTIVE_STATE" "$SUB_STATE" "$UNIT_FILE_STATE"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`

  await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 })
  await chmod(scriptPath, 0o755)
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'beam-linux-host-smoke-'))
  const homeDir = path.join(tempRoot, 'home')
  const binDir = path.join(tempRoot, 'bin')
  const fakeSystemctlPath = path.join(binDir, 'systemctl')
  const fakeStatePath = path.join(tempRoot, 'systemctl-state.env')

  await mkdir(homeDir, { recursive: true, mode: 0o700 })
  await mkdir(binDir, { recursive: true, mode: 0o755 })
  await createFakeSystemctl(fakeSystemctlPath, fakeStatePath)

  const env = {
    ...process.env,
    HOME: homeDir,
    BEAM_OPENCLAW_PLATFORM: 'linux',
    BEAM_OPENCLAW_SYSTEMCTL_BIN: fakeSystemctlPath,
    BEAM_OPENCLAW_KEYCHAIN: '0',
  }

  run(nodePath, [installerPath], { env })
  const installedStatus = run(nodePath, [installerPath, '--status', '--json'], { env })
  assert(installedStatus.stdout, 'Expected JSON status output after install')
  const installed = JSON.parse(installedStatus.stdout)

  const unitPath = path.join(homeDir, '.config/systemd/user/beam-openclaw-host.service')
  assert(fs.existsSync(unitPath), 'Expected systemd unit file to exist after install')
  const unitContents = await readFile(unitPath, 'utf8')
  assert(unitContents.includes('UMask=0077'), 'Expected Linux systemd unit to enforce UMask=0077')
  assert(unitContents.includes('Environment=BEAM_OPENCLAW_KEYCHAIN=0'), 'Expected Linux systemd unit to disable keychain storage explicitly')
  assert(installed.platform === 'linux', 'Expected Linux platform status')
  assert(installed.installed === true, 'Expected installed Linux service status')
  assert(installed.running === true, 'Expected running Linux service status')
  assert(installed.enabled === true, 'Expected enabled Linux service status')
  assert(installed.activeState === 'active', 'Expected active Linux service state')

  run(nodePath, [installerPath, '--uninstall'], { env })
  const removedStatus = run(nodePath, [installerPath, '--status', '--json'], { env })
  assert(removedStatus.stdout, 'Expected JSON status output after uninstall')
  const removed = JSON.parse(removedStatus.stdout)
  assert(removed.installed === false, 'Expected service manifest to be removed on uninstall')
  assert(removed.running === false, 'Expected service to be inactive after uninstall')

  const result = {
    ok: true,
    date: formatDate(),
    platform: 'linux-simulated',
    unitPath,
    installed,
    removed,
  }

  const markdown = `# Beam ${releaseLabel} Linux Host Smoke

## Context

- run date: \`${formatDate()}\`
- generated at: \`${formatDateTime()}\`
- environment: simulated Linux user-service install on a temporary HOME with a fake systemctl shim

## Result

\`PASS\`

## Verification

1. Install the OpenClaw host daemon as a systemd user service.
2. Confirm the generated unit file exists and enforces \`UMask=0077\`.
3. Confirm the service reports installed, enabled, and active through the Linux status path.
4. Uninstall the service and confirm the manifest is removed and the service reports inactive.

## Evidence

${toJsonBlock(result)}
`

  await writeMarkdownReport(outputPath, markdown)
  console.log(JSON.stringify({ ...result, report: outputPath }, null, 2))
}

main().catch((error) => {
  console.error('[workspace:linux-host-smoke] failed:', error)
  process.exitCode = 1
})
