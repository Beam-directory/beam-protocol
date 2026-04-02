import { mkdir, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const nodePath = process.execPath
const defaultStatePath = path.join(os.homedir(), '.openclaw/workspace/secrets/beam-openclaw-host.json')
const defaultAdminSessionCache = path.join(os.homedir(), '.openclaw/workspace/secrets/beam-admin-session.json')
const effectivePlatform = process.env.BEAM_OPENCLAW_PLATFORM || process.platform
const systemctlPath = process.env.BEAM_OPENCLAW_SYSTEMCTL_BIN || 'systemctl'

function readFlag(flagName, fallback = null) {
  const index = process.argv.indexOf(flagName)
  if (index === -1) {
    return fallback
  }

  const next = process.argv[index + 1]
  if (!next || next.startsWith('--')) {
    return fallback
  }

  return next
}

const mode = process.argv.includes('--status')
  ? 'status'
  : process.argv.includes('--uninstall')
    ? 'uninstall'
    : 'install'
const jsonOutput = process.argv.includes('--json')
const statePath = readFlag('--state-path', defaultStatePath)
const adminSessionCachePath = readFlag('--admin-session-cache', defaultAdminSessionCache)
const serviceLabel = 'com.beam.openclaw-host'
const systemdServiceName = 'beam-openclaw-host.service'

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    env: process.env,
  })
  if (result.status !== 0 && !allowFailure) {
    const stderr = result.stderr?.toString('utf8').trim()
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`)
  }
  return result
}

function runSystemctl(args, { allowFailure = false } = {}) {
  return run(systemctlPath, ['--user', ...args], { allowFailure })
}

function createLaunchAgentPlist(stdoutPath, stderrPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${path.join(repoRoot, 'scripts/workspace/beam-openclaw-host.mjs')}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BEAM_OPENCLAW_HOST_STATE_PATH</key>
    <string>${statePath}</string>
    <key>BEAM_OPENCLAW_ADMIN_SESSION_CACHE</key>
    <string>${adminSessionCachePath}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
</dict>
</plist>
`
}

function createSystemdUnit(stdoutPath, stderrPath) {
  return `[Unit]
Description=Beam OpenClaw Host Connector
After=network.target

[Service]
Type=simple
WorkingDirectory=${repoRoot}
ExecStart=${nodePath} ${path.join(repoRoot, 'scripts/workspace/beam-openclaw-host.mjs')} run
Restart=always
RestartSec=3
UMask=0077
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}
Environment=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}
Environment=BEAM_OPENCLAW_KEYCHAIN=0
Environment=BEAM_OPENCLAW_HOST_STATE_PATH=${statePath}
Environment=BEAM_OPENCLAW_ADMIN_SESSION_CACHE=${adminSessionCachePath}

[Install]
WantedBy=default.target
`
}

async function installMac() {
  const launchAgentsDir = path.join(os.homedir(), 'Library/LaunchAgents')
  const logsDir = path.join(os.homedir(), 'Library/Logs')
  const plistPath = path.join(launchAgentsDir, `${serviceLabel}.plist`)
  const stdoutPath = path.join(logsDir, 'beam-openclaw-host.log')
  const stderrPath = path.join(logsDir, 'beam-openclaw-host.err.log')
  await mkdir(launchAgentsDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  await writeFile(plistPath, createLaunchAgentPlist(stdoutPath, stderrPath), 'utf8')

  const uid = String(process.getuid())
  run('launchctl', ['bootout', `gui/${uid}`, plistPath], { allowFailure: true })
  run('launchctl', ['bootstrap', `gui/${uid}`, plistPath])
  run('launchctl', ['kickstart', '-k', `gui/${uid}/${serviceLabel}`], { allowFailure: true })

  console.log(`Installed launch agent: ${serviceLabel}`)
  console.log(`Plist:  ${plistPath}`)
  console.log(`Stdout: ${stdoutPath}`)
  console.log(`Stderr: ${stderrPath}`)
}

async function uninstallMac() {
  const launchAgentsDir = path.join(os.homedir(), 'Library/LaunchAgents')
  const plistPath = path.join(launchAgentsDir, `${serviceLabel}.plist`)
  const uid = String(process.getuid())
  run('launchctl', ['bootout', `gui/${uid}`, plistPath], { allowFailure: true })
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath)
  }
  console.log(`Removed launch agent: ${serviceLabel}`)
}

async function installLinux() {
  const systemdDir = path.join(os.homedir(), '.config/systemd/user')
  const logsDir = path.join(os.homedir(), '.local/state/beam')
  const unitPath = path.join(systemdDir, systemdServiceName)
  const stdoutPath = path.join(logsDir, 'beam-openclaw-host.log')
  const stderrPath = path.join(logsDir, 'beam-openclaw-host.err.log')

  await mkdir(systemdDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  await writeFile(unitPath, createSystemdUnit(stdoutPath, stderrPath), 'utf8')

  runSystemctl(['daemon-reload'])
  runSystemctl(['enable', '--now', systemdServiceName])

  console.log(`Installed systemd user service: ${systemdServiceName}`)
  console.log(`Unit:   ${unitPath}`)
  console.log(`Stdout: ${stdoutPath}`)
  console.log(`Stderr: ${stderrPath}`)
}

async function uninstallLinux() {
  const systemdDir = path.join(os.homedir(), '.config/systemd/user')
  const unitPath = path.join(systemdDir, systemdServiceName)
  runSystemctl(['disable', '--now', systemdServiceName], { allowFailure: true })
  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath)
  }
  runSystemctl(['daemon-reload'], { allowFailure: true })
  runSystemctl(['reset-failed', systemdServiceName], { allowFailure: true })
  console.log(`Removed systemd user service: ${systemdServiceName}`)
}

function macStatus() {
  const launchAgentsDir = path.join(os.homedir(), 'Library/LaunchAgents')
  const logsDir = path.join(os.homedir(), 'Library/Logs')
  const plistPath = path.join(launchAgentsDir, `${serviceLabel}.plist`)
  const stdoutPath = path.join(logsDir, 'beam-openclaw-host.log')
  const stderrPath = path.join(logsDir, 'beam-openclaw-host.err.log')
  const uid = String(process.getuid())
  const running = run('launchctl', ['print', `gui/${uid}/${serviceLabel}`], { allowFailure: true }).status === 0

  return {
    platform: 'darwin',
    serviceLabel,
    installed: fs.existsSync(plistPath),
    running,
    manifestPath: plistPath,
    stdoutPath,
    stderrPath,
  }
}

function linuxStatus() {
  const systemdDir = path.join(os.homedir(), '.config/systemd/user')
  const logsDir = path.join(os.homedir(), '.local/state/beam')
  const unitPath = path.join(systemdDir, systemdServiceName)
  const stdoutPath = path.join(logsDir, 'beam-openclaw-host.log')
  const stderrPath = path.join(logsDir, 'beam-openclaw-host.err.log')
  const activeResult = runSystemctl(['is-active', '--quiet', systemdServiceName], { allowFailure: true })
  const enabledResult = runSystemctl(['is-enabled', systemdServiceName], { allowFailure: true })
  const showResult = runSystemctl([
    'show',
    systemdServiceName,
    '--property=ActiveState',
    '--property=SubState',
    '--property=UnitFileState',
    '--no-page',
  ], { allowFailure: true })
  const showOutput = showResult.stdout?.toString('utf8') ?? ''
  const properties = Object.fromEntries(
    showOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=')
        if (index === -1) {
          return [line, '']
        }
        return [line.slice(0, index), line.slice(index + 1)]
      }),
  )
  const activeState = typeof properties['ActiveState'] === 'string' && properties['ActiveState'].length > 0
    ? properties['ActiveState']
    : activeResult.status === 0
      ? 'active'
      : 'inactive'
  const subState = typeof properties['SubState'] === 'string' && properties['SubState'].length > 0
    ? properties['SubState']
    : null
  const unitFileState = typeof properties['UnitFileState'] === 'string' && properties['UnitFileState'].length > 0
    ? properties['UnitFileState']
    : enabledResult.status === 0
      ? 'enabled'
      : 'disabled'

  return {
    platform: 'linux',
    serviceLabel: systemdServiceName,
    installed: fs.existsSync(unitPath),
    running: activeResult.status === 0,
    enabled: enabledResult.status === 0,
    activeState,
    subState,
    unitFileState,
    manifestPath: unitPath,
    stdoutPath,
    stderrPath,
    statePath,
    adminSessionCachePath,
  }
}

function printStatus(status) {
  if (jsonOutput) {
    console.log(JSON.stringify(status, null, 2))
    return
  }

  console.log(`Service:   ${status.serviceLabel}`)
  console.log(`Installed: ${status.installed ? 'yes' : 'no'}`)
  console.log(`Running:   ${status.running ? 'yes' : 'no'}`)
  if ('enabled' in status) {
    console.log(`Enabled:   ${status.enabled ? 'yes' : 'no'}`)
  }
  if ('activeState' in status && status.activeState) {
    console.log(`State:     ${status.activeState}${status.subState ? ` (${status.subState})` : ''}`)
  }
  if ('unitFileState' in status && status.unitFileState) {
    console.log(`Unit file: ${status.unitFileState}`)
  }
  console.log(`Manifest:  ${status.manifestPath}`)
  console.log(`Stdout:    ${status.stdoutPath}`)
  console.log(`Stderr:    ${status.stderrPath}`)
  if ('statePath' in status) {
    console.log(`Connector: ${status.statePath}`)
  }
}

async function main() {
  if (effectivePlatform === 'darwin') {
    if (mode === 'install') {
      await installMac()
    } else if (mode === 'uninstall') {
      await uninstallMac()
    } else {
      printStatus(macStatus())
    }
    return
  }

  if (effectivePlatform === 'linux') {
    if (mode === 'install') {
      await installLinux()
    } else if (mode === 'uninstall') {
      await uninstallLinux()
    } else {
      printStatus(linuxStatus())
    }
    return
  }

  throw new Error(`Unsupported platform for Beam OpenClaw host install: ${effectivePlatform}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
