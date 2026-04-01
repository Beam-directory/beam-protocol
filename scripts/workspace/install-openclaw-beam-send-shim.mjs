import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const uninstall = process.argv.includes('--uninstall')
const skillDir = path.join(os.homedir(), '.openclaw/workspace/skills/beam-protocol')
const beamSendPath = path.join(skillDir, 'beam-send.js')
const backupPath = path.join(skillDir, 'beam-send.original.js')

function buildShim() {
  return `#!/usr/bin/env node

import fs from 'node:fs'
import { resolve } from 'node:path'

const home = process.env.HOME || ''
const mergedIdentitiesPath = resolve(home, '.openclaw/workspace/secrets/beam-identities.merged.json')
const baseIdentitiesPath = resolve(home, '.openclaw/workspace/secrets/beam-identities.json')

if (!process.env.BEAM_IDENTITIES) {
  process.env.BEAM_IDENTITIES = fs.existsSync(mergedIdentitiesPath)
    ? mergedIdentitiesPath
    : baseIdentitiesPath
}

if (!process.env.BEAM_DIRECTORY_URL) {
  process.env.BEAM_DIRECTORY_URL = 'http://localhost:43100'
}

await import('./beam-send.original.js')
`
}

async function install() {
  await mkdir(skillDir, { recursive: true })
  if (!fs.existsSync(beamSendPath)) {
    throw new Error(`Could not find beam-send.js in ${skillDir}`)
  }

  if (!fs.existsSync(backupPath)) {
    await copyFile(beamSendPath, backupPath)
  } else {
    const current = await readFile(beamSendPath, 'utf8')
    if (!current.includes("await import('./beam-send.original.js')")) {
      await copyFile(beamSendPath, backupPath)
    }
  }

  await writeFile(beamSendPath, buildShim(), { encoding: 'utf8', mode: 0o755 })
  console.log(`Installed OpenClaw Beam send shim at ${beamSendPath}`)
}

async function uninstallShim() {
  if (!fs.existsSync(backupPath)) {
    console.log('No beam-send.original.js backup found; nothing to restore.')
    return
  }

  const backup = await readFile(backupPath, 'utf8')
  await writeFile(beamSendPath, backup, { encoding: 'utf8', mode: 0o755 })
  console.log(`Restored original beam-send.js from ${backupPath}`)
}

if (uninstall) {
  await uninstallShim()
} else {
  await install()
}
