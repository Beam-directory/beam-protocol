import { mkdir, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const launchAgentsDir = path.join(os.homedir(), 'Library/LaunchAgents')
const logsDir = path.join(os.homedir(), 'Library/Logs')
const label = 'com.beam.openclaw-receiver'
const plistPath = path.join(launchAgentsDir, `${label}.plist`)
const stdoutPath = path.join(logsDir, 'beam-openclaw-receiver.log')
const stderrPath = path.join(logsDir, 'beam-openclaw-receiver.err.log')
const mode = process.argv.includes('--uninstall') ? 'uninstall' : 'install'
const nodePath = process.execPath
const receiverPath = [...new Set([
  path.dirname(nodePath),
  path.join(os.homedir(), 'Library/pnpm'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  process.env.PATH,
].filter(Boolean))].join(':')

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

function createPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${path.join(repoRoot, 'scripts/workspace/openclaw-beam-receiver.mjs')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${receiverPath}</string>
  </dict>
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

async function install() {
  await mkdir(launchAgentsDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  await writeFile(plistPath, createPlist(), 'utf8')

  const uid = String(process.getuid())
  run('launchctl', ['bootout', `gui/${uid}`, plistPath], { allowFailure: true })
  run('launchctl', ['bootstrap', `gui/${uid}`, plistPath])
  run('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { allowFailure: true })

  console.log(`Installed launch agent: ${label}`)
  console.log(`Plist:  ${plistPath}`)
  console.log(`Stdout: ${stdoutPath}`)
  console.log(`Stderr: ${stderrPath}`)
}

async function uninstall() {
  const uid = String(process.getuid())
  run('launchctl', ['bootout', `gui/${uid}`, plistPath], { allowFailure: true })
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath)
  }
  console.log(`Removed launch agent: ${label}`)
}

if (mode === 'install') {
  install().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
} else {
  uninstall().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
