import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const scriptPath = path.join(repoRoot, 'scripts/workspace/linux-host-smoke.mjs')

test('linux host smoke validates install, status, and uninstall semantics', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'beam-linux-host-smoke-test-'))
  const outputPath = path.join(outputDir, 'linux-smoke.md')
  const result = spawnSync(process.execPath, [scriptPath, '--output', outputPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(payload.ok, true)
  assert.equal(payload.platform, 'linux-simulated')
  assert.equal(payload.report, outputPath)
  assert.equal(payload.installed.installed, true)
  assert.equal(payload.installed.enabled, true)
  assert.equal(payload.removed.installed, false)
  assert.equal(payload.removed.running, false)
})
