import { mkdir, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const mode = process.argv.includes('--uninstall') ? 'uninstall' : 'install'
const nodePath = process.execPath

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

function createLaunchAgentPlist(stdoutPath, stderrPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.beam.openclaw-host</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${path.join(repoRoot, 'scripts/workspace/beam-openclaw-host.mjs')}</string>
    <string>run</string>
  </array>
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
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}
Environment=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}

[Install]
WantedBy=default.target
`
}

async function installMac() {
  const launchAgentsDir = path.join(os.homedir(), 'Library/LaunchAgents')
  const logsDir = path.join(os.homedir(), 'Library/Logs')
  const plistPath = path.join(launchAgentsDir, 'com.beam.openclaw-host.plist')
  const stdoutPath = path.join(logsDir, 'beam-openclaw-host.log')
  const stderrPath = path.join(logsDir, 'beam-openclaw-host.err.log')
  await mkdir(launchAgentsDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  await writeFile(plistPath, createLaunchAgentPlist(stdoutPath, stderrPath), 'utf8')

  const uid = String(process.getuid())
  run('launchctl', ['bootout', `gui/${uid}`, plistPath], { allowFailure: true })
  run('launchctl', ['bootstrap', `gui/${uid}`, plistPath])
  run('launchctl', ['kickstart', '-k', `gui/${uid}/com.beam.openclaw-host`], { allowFailure: true })

  console.log(`Installed launch agent: com.beam.openclaw-host`)
  console.log(`Plist:  ${plistPath}`)
  console.log(`Stdout: ${stdoutPath}`)
  console.log(`Stderr: ${stderrPath}`)
}

async function uninstallMac() {
  const launchAgentsDir = path.join(os.homedir(), 'Library/LaunchAgents')
  const plistPath = path.join(launchAgentsDir, 'com.beam.openclaw-host.plist')
  const uid = String(process.getuid())
  run('launchctl', ['bootout', `gui/${uid}`, plistPath], { allowFailure: true })
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath)
  }
  console.log('Removed launch agent: com.beam.openclaw-host')
}

async function installLinux() {
  const systemdDir = path.join(os.homedir(), '.config/systemd/user')
  const logsDir = path.join(os.homedir(), '.local/state/beam')
  const unitPath = path.join(systemdDir, 'beam-openclaw-host.service')
  const stdoutPath = path.join(logsDir, 'beam-openclaw-host.log')
  const stderrPath = path.join(logsDir, 'beam-openclaw-host.err.log')

  await mkdir(systemdDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  await writeFile(unitPath, createSystemdUnit(stdoutPath, stderrPath), 'utf8')

  run('systemctl', ['--user', 'daemon-reload'])
  run('systemctl', ['--user', 'enable', '--now', 'beam-openclaw-host.service'])

  console.log('Installed systemd user service: beam-openclaw-host.service')
  console.log(`Unit:   ${unitPath}`)
  console.log(`Stdout: ${stdoutPath}`)
  console.log(`Stderr: ${stderrPath}`)
}

async function uninstallLinux() {
  const systemdDir = path.join(os.homedir(), '.config/systemd/user')
  const unitPath = path.join(systemdDir, 'beam-openclaw-host.service')
  run('systemctl', ['--user', 'disable', '--now', 'beam-openclaw-host.service'], { allowFailure: true })
  run('systemctl', ['--user', 'daemon-reload'], { allowFailure: true })
  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath)
  }
  console.log('Removed systemd user service: beam-openclaw-host.service')
}

async function main() {
  if (process.platform === 'darwin') {
    if (mode === 'install') {
      await installMac()
    } else {
      await uninstallMac()
    }
    return
  }

  if (process.platform === 'linux') {
    if (mode === 'install') {
      await installLinux()
    } else {
      await uninstallLinux()
    }
    return
  }

  throw new Error(`Unsupported platform for Beam OpenClaw host install: ${process.platform}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
