import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const nodePath = process.execPath
const daemonPath = path.join(repoRoot, 'scripts/workspace/beam-openclaw-host.mjs')

const result = spawnSync(nodePath, [daemonPath, 'setup', ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
})

process.exit(result.status ?? 1)
